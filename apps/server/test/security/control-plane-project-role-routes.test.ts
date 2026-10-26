import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import { ControlPlaneRegistry, controlPlaneUserSessions } from "@bb/db";
import { createControlPlaneClient } from "@bb/sdk/node";
import { createApp } from "../../src/server.js";
import { createControlPlaneAccess } from "../../src/control-plane/access.js";
import { createControlPlaneUserAccess } from "../../src/control-plane/user-access.js";
import { installControlPlaneProjectRoleRoutes } from "../../src/control-plane/project-role-routes.js";
import { hashAdminPassword } from "../../src/control-plane/credentials.js";
import { withTestHarness } from "../helpers/test-app.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";

it("scopes role inspection and mutation to an active administrator request", async () => {
  await withTestHarness(async (h) => {
    const registry = new ControlPlaneRegistry(h.db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 299999,
    });
    const { alice, bob } = seedControlPlaneJobSubjects(h.db);
    const origin = "https://bb.example";
    h.config.appUrl = origin;
    const server = createApp(h.deps, {
      controlPlane: createControlPlaneAccess(
        {
          version: 1,
          publicOrigin: origin,
          admin: {
            login: "admin",
            passwordHash: await hashAdminPassword("test-only-role-password"),
          },
        },
        Date.now,
        createControlPlaneUserAccess(registry, origin),
      ),
    });
    installControlPlaneProjectRoleRoutes(server.app, h.deps);
    const base = `/control-plane/admin/projects/${alice.project.id}/access`;
    const send = (
      method: string,
      path: string,
      token?: string,
      body?: object,
    ) =>
      server.app.request(path, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const personalToken = `agt_${randomBytes(32).toString("base64url")}`;
    h.db
      .insert(controlPlaneUserSessions)
      .values({
        userId: alice.user.id,
        digest: createHash("sha256").update(personalToken).digest("hex"),
        expiresAt: Date.now() + 60000,
      })
      .run();
    const login = await send("POST", "/control-plane/login", undefined, {
      login: "admin",
      password: "test-only-role-password",
    });
    const adminToken = z
      .object({ token: z.string() })
      .parse(await login.json()).token;
    const adminClient = createControlPlaneClient({
      origin,
      token: () => adminToken,
      fetch: async (input, init) => server.app.fetch(new Request(input, init)),
    }).admin.projectRoles;
    const usersClient = createControlPlaneClient({
      origin,
      token: () => adminToken,
      fetch: async (input, init) => server.app.fetch(new Request(input, init)),
    }).admin.users;
    expect((await send("GET", "/control-plane/admin/users")).status).toBe(401);
    expect(
      (await send("GET", "/control-plane/admin/users", personalToken)).status,
    ).toBe(401);
    expect(
      (await send("GET", "/control-plane/admin/users?limit=101", adminToken))
        .status,
    ).toBe(400);
    const firstUserPage = await usersClient.list({ limit: 1 });
    expect(firstUserPage.users).toHaveLength(1);
    expect(firstUserPage.nextCursor).toBe(firstUserPage.users[0]?.login);
    const nextUserPage = await usersClient.list({
      cursor: firstUserPage.nextCursor ?? undefined,
      limit: 1,
    });
    expect(nextUserPage.users[0]?.login).not.toBe(
      firstUserPage.users[0]?.login,
    );
    expect((await usersClient.list({ prefix: "ali" })).users).toContainEqual(
      expect.objectContaining({
        userId: alice.user.id,
        login: alice.user.login,
      }),
    );
    expect((await send("GET", base)).status).toBe(401);
    expect((await send("GET", base, personalToken)).status).toBe(401);
    expect(
      (
        await send("PUT", `${base}/${bob.user.id}`, personalToken, {
          role: "runner",
          expectedRevision: 1,
        })
      ).status,
    ).toBe(401);
    const response = await send("GET", base, adminToken);
    expect(response.status).toBe(200);
    const policy = z
      .object({
        projectId: z.string(),
        revision: z.number().int(),
        appliedRevision: z.number().int().nullable(),
        grants: z.array(z.object({ userId: z.string(), role: z.string() })),
        pendingOperationId: z.string().nullable(),
      })
      .parse(await response.json());
    expect((await adminClient.list(alice.project.id)).revision).toBe(
      policy.revision,
    );
    expect(policy.grants).toContainEqual(
      expect.objectContaining({ userId: alice.user.id, role: "owner" }),
    );
    expect(
      (
        await send("PUT", `${base}/${bob.user.id}`, adminToken, {
          role: "owner",
          expectedRevision: policy.revision,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send("PUT", `${base}/${bob.user.id}`, adminToken, {
          role: "runner",
          expectedRevision: policy.revision - 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (await send("GET", `${base}/maintenance/${randomUUID()}`, adminToken))
        .status,
    ).toBe(404);
    await expect(
      adminClient.set(alice.project.id, bob.user.id, {
        role: "runner",
        expectedRevision: policy.revision - 1,
      }),
    ).rejects.toThrow("409");
    expect((await send("GET", base, adminToken)).status).toBe(200);
  });
});
