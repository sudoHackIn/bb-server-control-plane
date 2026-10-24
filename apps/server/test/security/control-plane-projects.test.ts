import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  ControlPlaneRegistry,
  createProject,
  upsertHost,
  controlPlaneUserSessions,
  controlPlaneProjectAccess,
  controlPlaneProjects,
  controlPlaneUsers,
  projectSources,
  projects,
  getControlPlaneProject,
  createControlPlaneProject,
} from "@bb/db";
import { expect, it } from "vitest";
import { z } from "zod";
import { withTestHarness } from "../helpers/test-app.js";
import { createApp } from "../../src/server.js";
import { createControlPlaneAccess } from "../../src/control-plane/access.js";
import { createControlPlaneUserAccess } from "../../src/control-plane/user-access.js";
import { createControlPlaneProjectService } from "../../src/control-plane/projects.js";
import { hashAdminPassword } from "../../src/control-plane/credentials.js";

const projectSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  cwd: z.string(),
  role: z.string(),
  canRun: z.boolean(),
  canManage: z.boolean(),
});

it("creates native BB projects with atomic ownership, scopes lists/IDs and rechecks grants, source bindings and user revocation", async () => {
  await withTestHarness(async (harness) => {
    const registry = new ControlPlaneRegistry(harness.db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 299999,
    });
    const alice = registry.reserve("alice", 1),
      bob = registry.reserve("bob", 1);
    registry.environmentState(alice.id, "ready");
    registry.environmentState(bob.id, "ready");
    const host = upsertHost(harness.db, harness.hub, {
      name: "Project test host",
    });
    const service = createControlPlaneProjectService({
      registry,
      notifier: harness.hub,
      hostId: () => host.id,
      prepare: async (user, slug) => join(user.projectsRoot, slug),
    });
    const origin = "https://bb.example";
    harness.config.appUrl = origin;
    const access = createControlPlaneAccess(
      {
        version: 1,
        publicOrigin: origin,
        admin: {
          login: "admin",
          passwordHash: await hashAdminPassword("long-test-only-password"),
        },
      },
      Date.now,
      createControlPlaneUserAccess(registry, origin, Date.now, service),
    );
    const server = createApp(harness.deps, { controlPlane: access });
    const credentials = new Map<string, string>();
    for (const user of [alice, bob]) {
      const token = `agt_${randomBytes(32).toString("base64url")}`;
      credentials.set(user.id, token);
      harness.db
        .insert(controlPlaneUserSessions)
        .values({
          digest: createHash("sha256").update(token).digest("hex"),
          userId: user.id,
          expiresAt: Date.now() + 60000,
        })
        .run();
    }
    const send = (
      userId: string,
      path: string,
      body?: object,
      headers: Record<string, string> = {},
    ) =>
      server.app.request(path, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${credentials.get(userId)}`,
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const base = "/control-plane/user/projects";
    try {
      expect((await server.app.request(base)).status).toBe(401);
      expect(
        (await send(alice.id, base, { name: "A", slug: "../bob" })).status,
      ).toBe(400);
      expect(
        (
          await send(alice.id, base, {
            name: "A",
            slug: "app",
            userId: bob.id,
            cwd: bob.projectsRoot,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await send(
            alice.id,
            base,
            { name: "A", slug: "app" },
            { origin: "https://evil.example" },
          )
        ).status,
      ).toBe(403);
      const response = await send(alice.id, base, {
        name: "Alice app",
        slug: "app",
      });
      expect(response.status).toBe(201);
      const a = projectSchema.parse(await response.json());
      expect(a).toMatchObject({
        name: "Alice app",
        cwd: `${alice.projectsRoot}/app`,
        role: "owner",
        canRun: true,
        canManage: true,
      });
      expect(
        harness.db
          .select()
          .from(controlPlaneProjects)
          .where(eq(controlPlaneProjects.projectId, a.projectId))
          .get()?.ownerUserId,
      ).toBe(alice.id);
      expect(
        harness.db
          .select()
          .from(projects)
          .where(eq(projects.id, a.projectId))
          .get()?.name,
      ).toBe("Alice app");
      expect(
        (await send(alice.id, base, { name: "Alice app", slug: "app" })).status,
      ).toBe(200);
      expect(
        (await send(alice.id, base, { name: "Renamed", slug: "app" })).status,
      ).toBe(409);
      const b = projectSchema.parse(
        await (
          await send(bob.id, base, { name: "Bob app", slug: "app" })
        ).json(),
      );
      expect(b.cwd).toBe(`${bob.projectsRoot}/app`);
      expect(b.projectId).not.toBe(a.projectId);
      const list = z
        .object({ projects: z.array(projectSchema) })
        .parse(await (await send(alice.id, base)).json());
      expect(list.projects.map((p) => p.projectId)).toEqual([a.projectId]);
      expect((await send(alice.id, `${base}/${b.projectId}`)).status).toBe(404);
      expect((await send(alice.id, "/api/v1/projects")).status).toBe(401);
      expect((await send(alice.id, `${base}?userId=${bob.id}`)).status).toBe(
        400,
      );
      harness.db
        .insert(controlPlaneProjectAccess)
        .values({ projectId: a.projectId, userId: bob.id, role: "viewer" })
        .run();
      expect(
        projectSchema.parse(
          await (await send(bob.id, `${base}/${a.projectId}`)).json(),
        ),
      ).toMatchObject({ role: "viewer", canRun: false, canManage: false });
      const page1 = z
        .object({
          projects: z.array(projectSchema),
          nextCursor: z.string().nullable(),
        })
        .parse(await (await send(bob.id, `${base}?limit=1`)).json());
      expect(page1.projects).toHaveLength(1);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = z
        .object({
          projects: z.array(projectSchema),
          nextCursor: z.string().nullable(),
        })
        .parse(
          await (
            await send(bob.id, `${base}?limit=1&cursor=${page1.nextCursor}`)
          ).json(),
        );
      expect(page2.projects).toHaveLength(1);
      expect(page2.projects[0]?.projectId).not.toBe(
        page1.projects[0]?.projectId,
      );
      expect(page2.nextCursor).toBeNull();
      harness.db
        .delete(controlPlaneProjectAccess)
        .where(
          and(
            eq(controlPlaneProjectAccess.projectId, a.projectId),
            eq(controlPlaneProjectAccess.userId, bob.id),
          ),
        )
        .run();
      expect((await send(bob.id, `${base}/${a.projectId}`)).status).toBe(404);
      harness.db
        .update(projectSources)
        .set({ path: b.cwd })
        .where(eq(projectSources.projectId, a.projectId))
        .run();
      expect((await send(alice.id, `${base}/${a.projectId}`)).status).toBe(404);
      harness.db
        .update(controlPlaneUsers)
        .set({ enabled: false })
        .where(eq(controlPlaneUsers.id, bob.id))
        .run();
      expect((await send(bob.id, base)).status).toBe(401);
    } finally {
      await server.pluginService.stop();
      await server.closeWebSockets();
    }
  });
});

it("does not adopt unowned project sources and rolls back project creation if access is revoked during preparation", async () => {
  await withTestHarness(async (harness) => {
    const registry = new ControlPlaneRegistry(harness.db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 299999,
    });
    const alice = registry.reserve("alice", 1);
    registry.environmentState(alice.id, "ready");
    const host = upsertHost(harness.db, harness.hub, {
      name: "Project test host",
    });
    const existing = createProject(harness.db, harness.hub, {
      name: "Admin object",
      source: {
        type: "local_path",
        hostId: host.id,
        path: `${alice.projectsRoot}/existing`,
      },
    });
    expect(() =>
      createControlPlaneProject(harness.db, harness.hub, {
        userId: alice.id,
        hostId: host.id,
        slug: "existing",
        name: "Admin object",
      }),
    ).toThrow("project_conflict");
    expect(
      getControlPlaneProject(harness.db, alice.id, existing.project.id),
    ).toBeUndefined();
    const service = createControlPlaneProjectService({
      registry,
      notifier: harness.hub,
      hostId: () => host.id,
      prepare: async (user, slug) => {
        harness.db
          .update(controlPlaneUsers)
          .set({ enabled: false })
          .where(eq(controlPlaneUsers.id, user.id))
          .run();
        return join(user.projectsRoot, slug);
      },
    });
    await expect(
      service.create(alice, { name: "Must not appear", slug: "new" }),
    ).rejects.toThrow("user_unavailable");
    expect(harness.db.select().from(controlPlaneProjects).all()).toHaveLength(
      0,
    );
    expect(
      harness.db
        .select()
        .from(projects)
        .where(eq(projects.name, "Must not appear"))
        .all(),
    ).toHaveLength(0);
  });
});
