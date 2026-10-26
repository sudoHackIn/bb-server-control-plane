import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, unlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { eq, and } from "drizzle-orm";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  ControlPlaneRegistry,
  controlPlaneUserSessions,
  controlPlaneMcpCredentials,
  controlPlaneMcpAccess,
  controlPlaneProjectAccess,
  controlPlaneUsers,
} from "@bb/db";
import { createControlPlaneClient } from "@bb/sdk/node";
import { createApp } from "../../src/server.js";
import { createControlPlaneAccess } from "../../src/control-plane/access.js";
import { createControlPlaneUserAccess } from "../../src/control-plane/user-access.js";
import { createControlPlaneMcpCredentials } from "../../src/control-plane/mcp-credentials.js";
import { hashAdminPassword } from "../../src/control-plane/credentials.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

async function fixture(harness: TestAppHarness) {
  const subjects = seedControlPlaneJobSubjects(harness.db);
  const registry = new ControlPlaneRegistry(harness.db, {
    usersRoot: "/srv/users",
    firstUid: 200000,
    lastUid: 299999,
  });
  const origin = "https://bb.example";
  harness.config.appUrl = origin;
  const secrets = createControlPlaneMcpCredentials(
    harness.db,
    harness.config.dataDir,
  );
  const server = createApp(harness.deps, {
    controlPlane: createControlPlaneAccess(
      {
        version: 1,
        publicOrigin: origin,
        admin: {
          login: "admin",
          passwordHash: await hashAdminPassword("test-only-mcp-password"),
        },
      },
      Date.now,
      createControlPlaneUserAccess(
        registry,
        origin,
        Date.now,
        undefined,
        undefined,
        undefined,
        undefined,
        secrets,
      ),
    ),
  });
  const request = (
    path: string,
    token: string | null,
    method = "GET",
    body?: object,
  ) =>
    server.app.request(path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const login = await request("/control-plane/login", null, "POST", {
    login: "admin",
    password: "test-only-mcp-password",
  });
  const adminToken = z
    .object({ token: z.string() })
    .parse(await login.json()).token;
  const client = (token: string) =>
    createControlPlaneClient({
      origin,
      token: () => token,
      fetch: async (input, init) => server.app.fetch(new Request(input, init)),
    });
  const tokens = [subjects.alice, subjects.bob].map(({ user }) => {
    const token = `agt_${randomBytes(32).toString("base64url")}`;
    harness.db
      .insert(controlPlaneUserSessions)
      .values({
        userId: user.id,
        digest: createHash("sha256").update(token).digest("hex"),
        expiresAt: Date.now() + 60000,
      })
      .run();
    return token;
  });
  const aliceToken = tokens[0]!,
    bobToken = tokens[1]!;
  const admin = client(adminToken),
    alice = client(aliceToken),
    bob = client(bobToken);
  const connector = await admin.admin.mcp.create({
    slug: "jira",
    name: "Jira MCP",
    endpoint: "https://mcp.example/jira",
  });
  for (const subject of [subjects.alice, subjects.bob])
    await admin.admin.mcp.grant(connector.id, subject.user.id, true);
  return {
    ...subjects,
    secrets,
    request,
    admin,
    aliceApi: alice,
    bobApi: bob,
    adminToken,
    aliceToken,
    bobToken,
    connector,
  };
}

it("scopes catalog, encrypted credentials, shared-project metadata and configuration to current identities", async () => {
  await withTestHarness(async (harness) => {
    const f = await fixture(harness);
    const [aliceSecret, bobSecret] = ["alice-PAT-secret", "bob-PAT-secret"];
    for (const [api, token] of [
      [f.aliceApi, aliceSecret],
      [f.bobApi, bobSecret],
    ] as const) {
      expect((await api.mcp.list()).connectors).toHaveLength(1);
      const metadata = await api.mcp.setCredential(f.connector.id, {
        token,
        expectedRevision: 0,
        connectorRevision: 1,
      });
      expect(metadata.configured).toBe(true);
      expect(JSON.stringify(metadata)).not.toContain(token);
    }
    expect(await f.secrets.resolve(f.alice.user.id, f.connector.id, 1)).toBe(
      aliceSecret,
    );
    expect(await f.secrets.resolve(f.bob.user.id, f.connector.id, 1)).toBe(
      bobSecret,
    );
    const rows = harness.db.select().from(controlPlaneMcpCredentials).all();
    expect(JSON.stringify(rows)).not.toContain(aliceSecret);
    expect(JSON.stringify(rows)).not.toContain(bobSecret);
    const connection = await f.aliceApi.mcp.configure(f.alice.project.id, {
      connectorId: f.connector.id,
      connectorRevision: 1,
      expectedRevision: 0,
    });
    expect(connection).toMatchObject({
      enabled: false,
      executionState: "not_activated",
      readiness: "configured",
    });
    harness.db
      .insert(controlPlaneProjectAccess)
      .values({
        projectId: f.alice.project.id,
        userId: f.bob.user.id,
        role: "viewer",
      })
      .run();
    expect(
      (await f.bobApi.mcp.connections(f.alice.project.id)).connections[0]
        ?.readiness,
    ).toBe("configured");
    await expect(
      f.bobApi.mcp.configure(f.alice.project.id, {
        connectorId: f.connector.id,
        connectorRevision: 1,
        expectedRevision: 1,
      }),
    ).rejects.toThrow("403");
    expect(
      (await f.request("/control-plane/admin/mcp/connectors", f.aliceToken))
        .status,
    ).toBe(401);
    const spoof = await f.request(
      `/control-plane/user/mcp/connectors/${f.connector.id}/credential`,
      f.aliceToken,
      "PUT",
      {
        token: "bad",
        expectedRevision: 1,
        connectorRevision: 1,
        userId: f.bob.user.id,
      },
    );
    expect(spoof.status).toBe(400);
    expect(await f.secrets.resolve(f.bob.user.id, f.connector.id, 1)).toBe(
      bobSecret,
    );
  });
});

it("uses credential CAS and retained revocation revisions to prevent stale replacement and revoke ABA", async () => {
  await withTestHarness(async (harness) => {
    const f = await fixture(harness);
    const outcomes = await Promise.allSettled(
      ["one", "two"].map((token) =>
        f.aliceApi.mcp.setCredential(f.connector.id, {
          token,
          expectedRevision: 0,
          connectorRevision: 1,
        }),
      ),
    );
    expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(outcomes.filter((row) => row.status === "rejected")).toHaveLength(1);
    expect(
      (await f.aliceApi.mcp.revokeCredential(f.connector.id, 1)).revision,
    ).toBe(2);
    await expect(
      f.aliceApi.mcp.setCredential(f.connector.id, {
        token: "stale",
        expectedRevision: 0,
        connectorRevision: 1,
      }),
    ).rejects.toThrow("409");
    expect(
      (
        await f.aliceApi.mcp.setCredential(f.connector.id, {
          token: "new",
          expectedRevision: 2,
          connectorRevision: 1,
        })
      ).revision,
    ).toBe(3);
    await expect(
      f.aliceApi.mcp.revokeCredential(f.connector.id, 1),
    ).rejects.toThrow("409");
    expect(await f.secrets.resolve(f.alice.user.id, f.connector.id, 1)).toBe(
      "new",
    );
  });
});

it("binds ciphertext to user, connector and revision and fails closed when the encryption key is lost or permissive", async () => {
  await withTestHarness(async (harness) => {
    const f = await fixture(harness);
    for (const api of [f.aliceApi, f.bobApi])
      await api.mcp.setCredential(f.connector.id, {
        token: "private-PAT",
        expectedRevision: 0,
        connectorRevision: 1,
      });
    const aliceRow = harness.db
      .select()
      .from(controlPlaneMcpCredentials)
      .where(eq(controlPlaneMcpCredentials.userId, f.alice.user.id))
      .get()!;
    const bobRow = harness.db
      .select()
      .from(controlPlaneMcpCredentials)
      .where(eq(controlPlaneMcpCredentials.userId, f.bob.user.id))
      .get()!;
    harness.db
      .update(controlPlaneMcpCredentials)
      .set({ ciphertext: aliceRow.ciphertext })
      .where(eq(controlPlaneMcpCredentials.userId, f.bob.user.id))
      .run();
    await expect(
      f.secrets.resolve(f.bob.user.id, f.connector.id, 1),
    ).rejects.toThrow("credential_unavailable");
    harness.db
      .update(controlPlaneMcpCredentials)
      .set({ ciphertext: bobRow.ciphertext })
      .where(eq(controlPlaneMcpCredentials.userId, f.bob.user.id))
      .run();
    harness.db
      .update(controlPlaneMcpCredentials)
      .set({ revision: 2 })
      .where(eq(controlPlaneMcpCredentials.userId, f.alice.user.id))
      .run();
    await expect(
      f.secrets.resolve(f.alice.user.id, f.connector.id, 1),
    ).rejects.toThrow("credential_unavailable");
    harness.db
      .update(controlPlaneMcpCredentials)
      .set({ revision: 1 })
      .where(eq(controlPlaneMcpCredentials.userId, f.alice.user.id))
      .run();
    const other = await f.admin.admin.mcp.create({
      slug: "other",
      name: "Other connector",
      endpoint: "https://mcp.example/other",
    });
    await f.admin.admin.mcp.grant(other.id, f.alice.user.id, true);
    harness.db
      .insert(controlPlaneMcpCredentials)
      .values({ ...aliceRow, connectorId: other.id })
      .run();
    await expect(
      f.secrets.resolve(f.alice.user.id, other.id, 1),
    ).rejects.toThrow("credential_unavailable");
    const path = join(harness.config.dataDir, "control-plane-mcp-key");
    const saved = await readFile(path);
    await chmod(path, 0o644);
    await expect(
      f.secrets.resolve(f.alice.user.id, f.connector.id, 1),
    ).rejects.toThrow("credential_unavailable");
    await chmod(path, 0o600);
    await unlink(path);
    await expect(
      f.aliceApi.mcp.setCredential(f.connector.id, {
        token: "must-not-replace",
        expectedRevision: 1,
        connectorRevision: 1,
      }),
    ).rejects.toThrow("503");
    await expect(readFile(path)).rejects.toThrow();
    await writeFile(path, saved, { mode: 0o600 });
    expect(await f.secrets.resolve(f.alice.user.id, f.connector.id, 1)).toBe(
      "private-PAT",
    );
  });
});

it("requires explicit credential and connection refresh after catalog revision changes and current grants", async () => {
  await withTestHarness(async (harness) => {
    const f = await fixture(harness);
    await f.aliceApi.mcp.setCredential(f.connector.id, {
      token: "secret",
      expectedRevision: 0,
      connectorRevision: 1,
    });
    await f.aliceApi.mcp.configure(f.alice.project.id, {
      connectorId: f.connector.id,
      connectorRevision: 1,
      expectedRevision: 0,
    });
    const updated = await f.admin.admin.mcp.update(f.connector.id, {
      expectedRevision: 1,
      name: "Changed",
      endpoint: "https://mcp.example/new",
      enabled: true,
    });
    expect(updated.revision).toBe(2);
    expect(
      (await f.aliceApi.mcp.connections(f.alice.project.id)).connections[0]
        ?.readiness,
    ).toBe("revision_mismatch");
    await expect(
      f.secrets.resolve(f.alice.user.id, f.connector.id, 1),
    ).rejects.toThrow("conflict");
    await expect(
      f.secrets.resolve(f.alice.user.id, f.connector.id, 2),
    ).rejects.toThrow("credential_unavailable");
    await f.aliceApi.mcp.configure(f.alice.project.id, {
      connectorId: f.connector.id,
      connectorRevision: 2,
      expectedRevision: 1,
    });
    expect(
      (await f.aliceApi.mcp.connections(f.alice.project.id)).connections[0]
        ?.readiness,
    ).toBe("credentials_required");
    await f.admin.admin.mcp.grant(f.connector.id, f.alice.user.id, false);
    expect((await f.aliceApi.mcp.list()).connectors).toEqual([]);
    expect(
      (await f.aliceApi.mcp.connections(f.alice.project.id)).connections[0]
        ?.readiness,
    ).toBe("access_denied");
    expect(
      (await f.aliceApi.mcp.revokeCredential(f.connector.id, 1)).configured,
    ).toBe(false);
  });
});

it("rechecks authority after asynchronous key access and preserves disabled-configuration semantics", async () => {
  await withTestHarness(async (harness) => {
    const f = await fixture(harness);
    await f.aliceApi.mcp.setCredential(f.connector.id, {
      token: "secret",
      expectedRevision: 0,
      connectorRevision: 1,
    });
    const pending = f.secrets.resolve(f.alice.user.id, f.connector.id, 1);
    await f.admin.admin.mcp.grant(f.connector.id, f.alice.user.id, false);
    await expect(pending).rejects.toThrow();
    await f.admin.admin.mcp.grant(f.connector.id, f.alice.user.id, true);
    const pendingWrite = f.secrets.set(f.bob.user.id, f.connector.id, {
      token: "must-not-save",
      connectorRevision: 1,
      expectedRevision: 0,
    });
    harness.db
      .delete(controlPlaneMcpAccess)
      .where(
        and(
          eq(controlPlaneMcpAccess.connectorId, f.connector.id),
          eq(controlPlaneMcpAccess.userId, f.bob.user.id),
        ),
      )
      .run();
    await expect(pendingWrite).rejects.toMatchObject({ code: "not_found" });
    expect(f.secrets.metadata(f.bob.user.id, f.connector.id).revision).toBe(0);
    const invalid = await f.request(
      `/control-plane/user/projects/${f.alice.project.id}/mcp`,
      f.aliceToken,
      "PUT",
      {
        connectorId: f.connector.id,
        connectorRevision: 1,
        expectedRevision: 0,
        command: "/bin/sh",
      },
    );
    expect(invalid.status).toBe(400);
    expect(
      (await f.aliceApi.mcp.connections(f.alice.project.id)).executionSupported,
    ).toBe(true);
    const oversized = await f.request(
      `/control-plane/user/mcp/connectors/${f.connector.id}/credential`,
      f.aliceToken,
      "PUT",
      { token: "x".repeat(70000), expectedRevision: 1, connectorRevision: 1 },
    );
    expect(oversized.status).toBe(413);
    expect((await f.aliceApi.mcp.credential(f.connector.id)).revision).toBe(1);
    expect(
      (
        await f.request(
          `/control-plane/user/mcp/connectors/${f.connector.id}/credential?userId=${f.bob.user.id}`,
          f.aliceToken,
        )
      ).status,
    ).toBe(400);
    harness.db
      .delete(controlPlaneProjectAccess)
      .where(
        and(
          eq(controlPlaneProjectAccess.projectId, f.alice.project.id),
          eq(controlPlaneProjectAccess.userId, f.alice.user.id),
        ),
      )
      .run();
    await expect(
      f.aliceApi.mcp.connections(f.alice.project.id),
    ).rejects.toThrow("404");
    harness.db
      .update(controlPlaneUsers)
      .set({ enabled: false })
      .where(eq(controlPlaneUsers.id, f.alice.user.id))
      .run();
    expect(
      (await f.request("/control-plane/user/mcp/connectors", f.aliceToken))
        .status,
    ).toBe(401);
  });
});

it("validates catalog endpoints, strict fields and page cursors without exposing credentials", async () => {
  await withTestHarness(async (harness) => {
    const f = await fixture(harness);
    for (const endpoint of [
      "invalid",
      "http://untrusted.example/mcp",
      "https://user:password@mcp.example/",
      "https://mcp.example/?token=private",
      "https://mcp.example/#private",
    ])
      expect(
        (
          await f.request(
            "/control-plane/admin/mcp/connectors",
            f.adminToken,
            "POST",
            { slug: "invalid", name: "Invalid", endpoint },
          )
        ).status,
      ).toBe(400);
    expect(
      (
        await f.request(
          "/control-plane/admin/mcp/connectors",
          f.adminToken,
          "POST",
          {
            slug: "invalid",
            name: "Invalid",
            endpoint: "https://mcp.example/",
            command: "/bin/sh",
          },
        )
      ).status,
    ).toBe(400);
    await expect(
      f.admin.admin.mcp.create({
        slug: "jira",
        name: "Conflict",
        endpoint: "https://mcp.example/",
      }),
    ).rejects.toThrow("409");
    const second = await f.admin.admin.mcp.create({
      slug: "confluence",
      name: "Confluence",
      endpoint: "https://mcp.example/confluence",
    });
    await f.admin.admin.mcp.grant(second.id, f.alice.user.id, true);
    const first = await f.aliceApi.mcp.list({ limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const next = await f.aliceApi.mcp.list({
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(next.connectors).toHaveLength(1);
    expect(next.connectors[0]?.id).not.toBe(first.connectors[0]?.id);
    expect((await f.bobApi.mcp.list()).connectors.map((row) => row.id)).toEqual(
      [f.connector.id],
    );
    const initial = await f.aliceApi.mcp.configure(f.alice.project.id, {
      connectorId: f.connector.id,
      connectorRevision: 1,
      expectedRevision: 0,
    });
    await expect(
      f.aliceApi.mcp.remove(
        f.alice.project.id,
        initial.id,
        initial.revision + 1,
      ),
    ).rejects.toThrow("409");
    await f.aliceApi.mcp.remove(
      f.alice.project.id,
      initial.id,
      initial.revision,
    );
    expect(
      (await f.aliceApi.mcp.connections(f.alice.project.id)).connections,
    ).toEqual([]);
  });
});

it("requires a current personal credential for activation through the typed SDK and persists explicit disabling", async () => {
  await withTestHarness(async (harness) => {
    const f = await fixture(harness);
    const input = {
      connectorId: f.connector.id,
      connectorRevision: 1,
      expectedRevision: 0,
      enabled: true,
    };
    await expect(
      f.aliceApi.mcp.configure(f.alice.project.id, input),
    ).rejects.toThrow();
    await f.aliceApi.mcp.setCredential(f.connector.id, {
      token: "activation-personal-token",
      connectorRevision: 1,
      expectedRevision: 0,
    });
    const active = await f.aliceApi.mcp.configure(f.alice.project.id, input);
    expect(active).toMatchObject({
      enabled: true,
      executionState: "enabled",
      revision: 1,
    });
    expect(
      (await f.aliceApi.mcp.connections(f.alice.project.id)).executionSupported,
    ).toBe(true);
    const disabled = await f.aliceApi.mcp.configure(f.alice.project.id, {
      ...input,
      expectedRevision: 1,
      enabled: false,
    });
    expect(disabled).toMatchObject({
      enabled: false,
      executionState: "not_activated",
      revision: 2,
    });
    await expect(
      f.aliceApi.mcp.configure(f.alice.project.id, {
        ...input,
        expectedRevision: 1,
      }),
    ).rejects.toThrow("409");
  });
});
