import { BUILTIN_PLUGINS } from "../../src/services/plugins/builtin-registry.js";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { z } from "zod";
import { createMigratedConnection } from "@bb/db/testing";
import { controlPlaneUsers, setControlPlaneProfileAccess } from "@bb/db";
import { createControlPlaneBackgroundJobs } from "../../src/control-plane/background-jobs.js";
import {
  createControlPlaneAccess,
  currentControlPlanePrincipal,
  withControlPlaneUser,
} from "../../src/control-plane/access.js";
import { hashAdminPassword } from "../../src/control-plane/credentials.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";

it("admits only approved builtin hosts and captures the current user without accepting overrides", async () => {
  const db = createMigratedConnection();
  try {
    const { alice, bob } = seedControlPlaneJobSubjects(db);
    for (const [id, builtin] of [
      ["workflows", false],
      ["automations", false],
      ["other", true],
      ["bb--workflows", true],
      ["bb--automations", true],
    ] as const)
      expect(() => createControlPlaneBackgroundJobs(db, id, builtin)).toThrow(
        "not authorized",
      );
    const workflowId = BUILTIN_PLUGINS.find(
      (plugin) => plugin.name === "workflows",
    )?.pluginId;
    const automationId = BUILTIN_PLUGINS.find(
      (plugin) => plugin.name === "automations",
    )?.pluginId;
    if (!workflowId || !automationId)
      throw new Error("Missing builtin job plugins");
    const jobs = createControlPlaneBackgroundJobs(db, workflowId, true);
    expect(
      createControlPlaneBackgroundJobs(db, automationId, true),
    ).toBeDefined();
    await expect(jobs.bind(alice.input)).rejects.toThrow("not authorized");
    expect(jobs.userId).toBeNull();
    expect(() => jobs.readOrigin(alice.thread.id)).toThrow("not authorized");
    withControlPlaneUser(alice.user.id, () => {
      expect(jobs.userId).toBe(alice.user.id);
      expect(jobs.canReadProject(alice.project.id)).toBe(true);
      expect(jobs.canReadProject(bob.project.id)).toBe(false);
      expect(jobs.readOrigin(alice.thread.id)).toEqual({
        projectId: alice.project.id,
        environmentId: alice.environment.id,
        providerId: "qwen-server",
        model: "qwen-test",
        reasoningLevel: "none",
        permissionMode: "full",
      });
      expect(() => jobs.readOrigin(bob.thread.id)).toThrow("not authorized");
    });
    expect(jobs.userId).toBeNull();

    const a = await withControlPlaneUser(alice.user.id, () =>
      jobs.bind(alice.input),
    );
    const b = await withControlPlaneUser(bob.user.id, () =>
      jobs.bind(bob.input),
    );
    await expect(
      withControlPlaneUser(bob.user.id, () =>
        jobs.evaluateWorkflow(
          a.id,
          {
            body: "return null",
            args: null,
            maxAgentCalls: 1,
            maxConcurrentAgents: 1,
            timeoutMs: 1000,
          },
          new AbortController().signal,
          () => {},
        ),
      ),
    ).rejects.toThrow("not authorized");
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      withControlPlaneUser(alice.user.id, () =>
        jobs.evaluateWorkflow(
          a.id,
          {
            body: "return null",
            args: null,
            maxAgentCalls: 1,
            maxConcurrentAgents: 1,
            timeoutMs: 1000,
          },
          aborted.signal,
          () => {},
        ),
      ),
    ).rejects.toThrow("cancelled before");
    await expect(
      withControlPlaneUser(alice.user.id, () =>
        jobs.evaluateWorkflow(
          a.id,
          {
            body: "return null",
            args: null,
            maxAgentCalls: 0,
            maxConcurrentAgents: 1,
            timeoutMs: 1000,
          },
          new AbortController().signal,
          () => {},
        ),
      ),
    ).rejects.toThrow();
    expect(a.ownerUserId).toBe(alice.user.id);
    expect(a.profileVersionId).toBe(alice.profile.versionId);
    expect(b.ownerUserId).toBe(bob.user.id);
    await jobs.setEnabled(a.id, false);
    await expect(jobs.setEnabled(a.id, true)).rejects.toThrow("not authorized");
    await withControlPlaneUser(alice.user.id, () =>
      jobs.setEnabled(a.id, true),
    );
    for (const extra of [
      { userId: bob.user.id },
      { uid: bob.user.uid },
      { home: bob.user.home },
    ])
      await expect(
        withControlPlaneUser(alice.user.id, () =>
          jobs.bind({ ...alice.input, ...extra }),
        ),
      ).rejects.toThrow();
    await expect(
      withControlPlaneUser(alice.user.id, () =>
        jobs.bind({ ...alice.input, kind: "automation" }),
      ),
    ).rejects.toThrow("not authorized");
    expect(
      await withControlPlaneUser(bob.user.id, () => jobs.get(a.id)),
    ).toBeNull();
    expect(
      (
        await withControlPlaneUser(bob.user.id, () =>
          jobs.list({ kind: "workflow-run", cursor: null, limit: 1 }),
        )
      ).bindings.map((job) => job.id),
    ).toEqual([b.id]);
    const automations = createControlPlaneBackgroundJobs(
      db,
      "automations",
      true,
    );
    expect(await automations.get(a.id)).toBeNull();
    expect(() =>
      automations.list({ kind: "workflow-run", cursor: null, limit: 1 }),
    ).toThrow("not authorized");
  } finally {
    db.$client.close();
  }
});

it("adopts current saved authority for nested registration and async callbacks and rechecks revocation", async () => {
  const db = createMigratedConnection();
  try {
    const { alice, bob } = seedControlPlaneJobSubjects(db);
    const jobs = createControlPlaneBackgroundJobs(db, "workflows", true);
    const a = await withControlPlaneUser(alice.user.id, () =>
      jobs.bind(alice.input),
    );
    const b = await withControlPlaneUser(bob.user.id, () =>
      jobs.bind(bob.input),
    );
    await Promise.all(
      [a, b].map((job) =>
        jobs.withAuthority(job.id, async () => {
          await Promise.resolve();
          expect(currentControlPlanePrincipal()).toEqual({
            kind: "user",
            userId: job.ownerUserId,
          });
          const nested = await jobs.bind({
            ...alice.input,
            objectId: randomUUID(),
            projectId: job.projectId,
            originThreadId: job.originThreadId,
            sourceBindingId: job.id,
          });
          expect(nested.ownerUserId).toBe(job.ownerUserId);
        }),
      ),
    );
    expect(currentControlPlanePrincipal()).toBeNull();
    expect(() =>
      withControlPlaneUser(bob.user.id, () =>
        jobs.withAuthority(a.id, () => {
          throw new Error("Foreign callback executed");
        }),
      ),
    ).toThrow("not authorized");
    await expect(
      withControlPlaneUser(bob.user.id, () => jobs.setEnabled(a.id, false)),
    ).rejects.toThrow("not authorized");
    setControlPlaneProfileAccess(
      db,
      alice.profile.profileId,
      alice.user.id,
      false,
    );
    expect(() =>
      jobs.withAuthority(a.id, () => {
        throw new Error("Revoked callback executed");
      }),
    ).toThrow("not authorized");
    await withControlPlaneUser(alice.user.id, () =>
      jobs.setEnabled(a.id, false),
    );
    await expect(
      withControlPlaneUser(alice.user.id, () => jobs.setEnabled(a.id, true)),
    ).rejects.toThrow("not authorized");
    db.update(controlPlaneUsers)
      .set({ enabled: false })
      .where(eq(controlPlaneUsers.id, alice.user.id))
      .run();
    expect(
      await withControlPlaneUser(alice.user.id, () => jobs.get(a.id)),
    ).toBeNull();
    expect((await jobs.get(a.id))?.ownerUserId).toBe(alice.user.id);
    await jobs.setEnabled(a.id, false);
    await expect(jobs.setEnabled(a.id, true)).rejects.toThrow("not authorized");
    await jobs.remove(a.id);
    expect((await jobs.get(a.id))?.deletedAt).not.toBeNull();
  } finally {
    db.$client.close();
  }
});

it("an explicit administrative request can bind a registered project owner while callbacks remain user scoped", async () => {
  const db = createMigratedConnection();
  const access = createControlPlaneAccess({
    version: 1,
    publicOrigin: "https://bb.example",
    admin: {
      login: "operator",
      passwordHash: await hashAdminPassword("test-only-background-password"),
    },
  });
  try {
    const { alice } = seedControlPlaneJobSubjects(db);
    const jobs = createControlPlaneBackgroundJobs(db, "workflows", true);
    const app = new Hono();
    access.install(app);
    const handoff: {
      release: (() => void) | null;
      escaped: Promise<unknown> | null;
    } = { release: null, escaped: null };
    const gate = new Promise<void>((resolve) => {
      handoff.release = resolve;
    });
    app.post("/fixture", async (context) => {
      expect(currentControlPlanePrincipal()).toEqual({
        kind: "admin",
        login: "operator",
      });
      handoff.escaped = gate.then(() => {
        expect(currentControlPlanePrincipal()).toEqual({
          kind: "admin",
          login: "operator",
        });
        return jobs.bind({ ...alice.input, objectId: randomUUID() });
      });
      const job = await jobs.bind(alice.input);
      await jobs.withAuthority(job.id, async () => {
        await Promise.resolve();
        expect(currentControlPlanePrincipal()).toEqual({
          kind: "user",
          userId: alice.user.id,
        });
      });
      expect(currentControlPlanePrincipal()).toEqual({
        kind: "admin",
        login: "operator",
      });
      return context.json({ ownerUserId: job.ownerUserId });
    });
    const login = await app.request("/control-plane/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        login: "operator",
        password: "test-only-background-password",
      }),
    });
    const { token } = z.object({ token: z.string() }).parse(await login.json());
    const response = await app.request("/fixture", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ownerUserId: alice.user.id });
    if (!handoff.escaped || !handoff.release)
      throw new Error("Missing escaped administrative callback");
    const check = expect(handoff.escaped).rejects.toThrow("not authorized");
    handoff.release();
    await check;
  } finally {
    access.close();
    db.$client.close();
  }
});

it("resolves worker profiles under current parent and profile grants", async () => {
  const db = createMigratedConnection();
  try {
    const { alice, bob } = seedControlPlaneJobSubjects(db);
    const jobs = createControlPlaneBackgroundJobs(db, "workflows", true);
    const parent = await withControlPlaneUser(alice.user.id, () =>
      jobs.bind(alice.input),
    );
    withControlPlaneUser(bob.user.id, () => {
      expect(() => jobs.resolveWorkerProfile(parent.id, null)).toThrow(
        "not authorized",
      );
    });
    withControlPlaneUser(alice.user.id, () => {
      expect(jobs.resolveWorkerProfile(parent.id, null)).toMatchObject({
        profileVersionId: alice.profile.versionId,
        model: "qwen-test",
      });
      expect(() =>
        jobs.resolveWorkerProfile(parent.id, bob.profile.versionId),
      ).toThrow("not authorized");
      setControlPlaneProfileAccess(
        db,
        bob.profile.profileId,
        alice.user.id,
        true,
      );
      expect(
        jobs.resolveWorkerProfile(parent.id, bob.profile.versionId),
      ).toMatchObject({ profileVersionId: bob.profile.versionId });
      setControlPlaneProfileAccess(
        db,
        bob.profile.profileId,
        alice.user.id,
        false,
      );
      expect(() =>
        jobs.resolveWorkerProfile(parent.id, bob.profile.versionId),
      ).toThrow("not authorized");
      setControlPlaneProfileAccess(
        db,
        bob.profile.profileId,
        alice.user.id,
        true,
      );
      setControlPlaneProfileAccess(
        db,
        alice.profile.profileId,
        alice.user.id,
        false,
      );
      expect(() =>
        jobs.resolveWorkerProfile(parent.id, bob.profile.versionId),
      ).toThrow("not authorized");
    });
  } finally {
    db.$client.close();
  }
});
