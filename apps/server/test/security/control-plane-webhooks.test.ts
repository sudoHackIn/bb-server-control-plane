import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { createMigratedConnection } from "@bb/db/testing";
import {
  ControlPlaneRegistry,
  controlPlaneWebhookDeliveries,
  controlPlaneWebhooks,
  controlPlaneUserSessions,
  setControlPlaneProfileAccess,
} from "@bb/db";
import {
  controlPlaneAgentRunSchema,
  controlPlaneAgentRunStartSchema,
} from "@bb/domain";
import { createControlPlaneClient } from "@bb/sdk/node";
import { createControlPlaneWebhookService } from "../../src/control-plane/webhooks.js";
import { createControlPlaneAccess } from "../../src/control-plane/access.js";
import {
  createControlPlaneUserAccess,
  isUserAuthPath,
} from "../../src/control-plane/user-access.js";
import { createControlPlaneThreadService } from "../../src/control-plane/threads.js";
import { createControlPlaneWorkflowService } from "../../src/control-plane/workflows.js";
import { createApp } from "../../src/server.js";
import { hashAdminPassword } from "../../src/control-plane/credentials.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { withTestHarness } from "../helpers/test-app.js";

function fixture() {
  const db = createMigratedConnection();
  const { alice, bob } = seedControlPlaneJobSubjects(db);
  const start = vi.fn(async () =>
    controlPlaneAgentRunSchema.parse({
      runId: "thr_webhook",
      threadId: "thr_webhook",
      projectId: alice.project.id,
      profileId: alice.profile.profileId,
      profileVersionId: alice.profile.versionId,
      source: "manual",
      title: "Webhook",
      status: "starting",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  const service = createControlPlaneWebhookService(db, { start });
  const created = service.create(alice.user.id, {
    projectId: alice.project.id,
    profileVersionId: alice.profile.versionId,
    name: "Build",
    inputField: "task",
  });
  return { db, alice, bob, start, service, ...created };
}
it("pins owner and target, scopes reads and management, stores only a secret digest and rechecks revoked grants", async () => {
  const f = fixture();
  try {
    const { service, alice, bob, webhook, secret, db, start } = f;
    expect(db.select().from(controlPlaneWebhooks).get()?.secretHash).toBe(
      createHash("sha256").update(secret).digest("hex"),
    );
    expect(
      JSON.stringify(service.get(alice.user.id, webhook.id)),
    ).not.toContain(secret);
    for (const attempt of [
      () => service.get(bob.user.id, webhook.id),
      () => service.history(bob.user.id, webhook.id, { limit: 20 }),
      () => service.rotate(bob.user.id, webhook.id),
      () => service.setEnabled(bob.user.id, webhook.id, false),
    ])
      expect(attempt).toThrow("not found");
    await expect(
      service.deliver(
        webhook.id,
        "Bearer invalid",
        "event",
        '{"task":"hello"}',
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(db.select().from(controlPlaneWebhookDeliveries).all()).toHaveLength(
      0,
    );
    const raw = JSON.stringify({
      task: "hello",
      ownerUserId: bob.user.id,
      projectId: bob.project.id,
      profileVersionId: bob.profile.versionId,
    });
    expect(
      (await service.deliver(webhook.id, `Bearer ${secret}`, "event", raw))
        .state,
    ).toBe("accepted");
    expect(start).toHaveBeenCalledWith(
      alice.user.id,
      expect.objectContaining({
        projectId: alice.project.id,
        profileVersionId: alice.profile.versionId,
        input: "hello",
      }),
    );
    setControlPlaneProfileAccess(
      db,
      alice.profile.profileId,
      alice.user.id,
      false,
    );
    expect(
      (await service.deliver(webhook.id, `Bearer ${secret}`, "revoked", raw))
        .state,
    ).toBe("failed");
    await expect(
      service.deliver(webhook.id, `Bearer ${secret}`, "event", raw),
    ).rejects.toMatchObject({ status: 403 });
    expect(start).toHaveBeenCalledTimes(1);
    service.setEnabled(alice.user.id, webhook.id, false);
    await expect(
      service.deliver(webhook.id, `Bearer ${secret}`, "disabled", raw),
    ).rejects.toMatchObject({ status: 409 });
    const rotated = service.rotate(alice.user.id, webhook.id);
    await expect(
      service.deliver(webhook.id, `Bearer ${secret}`, "old-secret", raw),
    ).rejects.toMatchObject({ status: 401 });
    expect(rotated.secret).not.toBe(secret);
  } finally {
    f.db.$client.close();
  }
});
it("reuses concurrent deliveries and persisted admission after a lost reply without changing the request", async () => {
  const f = fixture();
  try {
    const { service, webhook, secret, start, db, alice } = f;
    const raw = '{"task":"hello"}';
    const [a, b] = await Promise.all([
      service.deliver(webhook.id, `Bearer ${secret}`, "same", raw),
      service.deliver(webhook.id, `Bearer ${secret}`, "same", raw),
    ]);
    expect(a).toEqual(b);
    expect(start).toHaveBeenCalledTimes(1);
    await expect(
      service.deliver(
        webhook.id,
        `Bearer ${secret}`,
        "same",
        '{"task":"changed"}',
      ),
    ).rejects.toMatchObject({ status: 409 });
    const reopened = createControlPlaneWebhookService(db, { start });
    expect(
      await reopened.deliver(webhook.id, `Bearer ${secret}`, "same", raw),
    ).toEqual(a);
    expect(start).toHaveBeenCalledTimes(1);
    db.update(controlPlaneWebhookDeliveries)
      .set({ state: "pending", runId: null })
      .where(eq(controlPlaneWebhookDeliveries.id, a.id))
      .run();
    expect(
      (await reopened.deliver(webhook.id, `Bearer ${secret}`, "same", raw))
        .runId,
    ).toBe(a.runId);
    expect(start).toHaveBeenLastCalledWith(
      alice.user.id,
      expect.objectContaining({ idempotencyKey: `webhook:${a.id}` }),
    );
    expect(db.select().from(controlPlaneWebhookDeliveries).all()).toHaveLength(
      1,
    );
    expect(
      controlPlaneAgentRunStartSchema.safeParse({
        projectId: alice.project.id,
        profileVersionId: alice.profile.versionId,
        source: "manual",
        input: "hello",
        idempotencyKey: `webhook:${a.id}`,
      }).success,
    ).toBe(false);
  } finally {
    f.db.$client.close();
  }
});
it("records invalid mappings without executing, bounds payloads and supports retry after transient launch failure", async () => {
  const f = fixture();
  try {
    const { service, webhook, secret, start, alice } = f;
    const invalid = await service.deliver(
      webhook.id,
      `Bearer ${secret}`,
      "invalid",
      '{"input":"not the selected field"}',
    );
    expect(invalid).toMatchObject({
      state: "failed",
      error: "invalid_webhook_input",
      runId: null,
    });
    expect(start).not.toHaveBeenCalled();
    await expect(
      service.deliver(
        webhook.id,
        `Bearer ${secret}`,
        "large",
        "x".repeat(262145),
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      service.deliver(webhook.id, `Bearer ${secret}`, undefined, "{}"),
    ).rejects.toMatchObject({ status: 400 });
    start.mockRejectedValueOnce(new Error("private provider diagnostics"));
    const failed = await service.deliver(
      webhook.id,
      `Bearer ${secret}`,
      "transient",
      '{"task":"hello"}',
    );
    expect(failed).toMatchObject({
      state: "failed",
      error: "launch_not_available",
    });
    const accepted = await service.deliver(
      webhook.id,
      `Bearer ${secret}`,
      "transient",
      '{"task":"hello"}',
    );
    expect(accepted).toMatchObject({
      id: failed.id,
      state: "accepted",
      createdAt: failed.createdAt,
    });
    expect(
      JSON.stringify(service.history(alice.user.id, webhook.id, { limit: 20 })),
    ).not.toContain("private provider diagnostics");
  } finally {
    f.db.$client.close();
  }
});
it("exposes only the authenticated webhook delivery route outside the user API with SDK management parity", async () => {
  await withTestHarness(async (h) => {
    const { alice, bob } = seedControlPlaneJobSubjects(h.db);
    const registry = new ControlPlaneRegistry(h.db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 299999,
    });
    const origin = "https://bb.example";
    h.config.appUrl = origin;
    const threads = createControlPlaneThreadService({ deps: h.deps });
    const workflows = createControlPlaneWorkflowService(h.db, async () => {
      throw new Error("Unexpected native execution");
    });
    const users = createControlPlaneUserAccess(
      registry,
      origin,
      Date.now,
      undefined,
      threads,
      workflows,
    );
    const server = createApp(h.deps, {
      controlPlane: createControlPlaneAccess(
        {
          version: 1,
          publicOrigin: origin,
          admin: {
            login: "admin",
            passwordHash: await hashAdminPassword("webhook-test"),
          },
        },
        Date.now,
        users,
      ),
    });
    const tokens = new Map<string, string>();
    for (const s of [alice, bob]) {
      const token = `agt_${randomBytes(32).toString("base64url")}`;
      tokens.set(s.user.id, token);
      h.db
        .insert(controlPlaneUserSessions)
        .values({
          userId: s.user.id,
          digest: createHash("sha256").update(token).digest("hex"),
          expiresAt: Date.now() + 60000,
        })
        .run();
    }
    const client = (id: string) =>
      createControlPlaneClient({
        origin,
        token: () => tokens.get(id) ?? null,
        fetch: async (input, init) =>
          server.app.fetch(new Request(input, init)),
      });
    try {
      const created = await client(alice.user.id).webhooks.create({
        projectId: alice.project.id,
        profileVersionId: alice.profile.versionId,
        name: "API webhook",
      });
      expect(
        (
          await client(alice.user.id).webhooks.list({
            projectId: alice.project.id,
          })
        ).webhooks,
      ).toHaveLength(1);
      await expect(
        client(bob.user.id).webhooks.get(created.webhook.id),
      ).rejects.toThrow();
      expect(
        (
          await server.app.request(created.webhook.deliveryPath, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await server.app.request(created.webhook.deliveryPath, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${tokens.get(alice.user.id)}`,
            },
            body: "{}",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await server.app.request(created.webhook.deliveryPath, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${created.secret}`,
              "x-bb-delivery-id": "oversized",
            },
            body: JSON.stringify({ input: "x".repeat(262144) }),
          })
        ).status,
      ).toBe(413);
      const delivery = await client(alice.user.id).webhooks.deliver(
        created.webhook.id,
        {
          secret: created.secret,
          deliveryId: "bad-mapping",
          payload: { input: 42 },
        },
      );
      expect(delivery.state).toBe("failed");
      expect(
        (await client(alice.user.id).webhooks.history(created.webhook.id))
          .deliveries[0],
      ).toEqual(delivery);
      await client(alice.user.id).webhooks.setEnabled(
        created.webhook.id,
        false,
      );
      const rotated = await client(alice.user.id).webhooks.rotate(
        created.webhook.id,
      );
      expect(rotated.secret).not.toBe(created.secret);
      expect(isUserAuthPath(created.webhook.deliveryPath, "POST")).toBe(true);
      expect(isUserAuthPath(created.webhook.deliveryPath, "GET")).toBe(false);
      expect(
        isUserAuthPath(created.webhook.deliveryPath + "/admin", "POST"),
      ).toBe(false);
      expect((await server.app.request("/api/v1/projects")).status).not.toBe(
        200,
      );
    } finally {
      users.close();
    }
  });
});
