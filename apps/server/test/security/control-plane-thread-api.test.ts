import {
  dispatchControlPlaneDispatchRead,
  withControlPlaneDispatchRead,
} from "../../src/control-plane/sdk-dispatch-read.js";
import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  ControlPlaneRegistry,
  listRunningThreads,
  controlPlaneUserSessions,
  controlPlaneUsers,
  controlPlaneProjectAccess,
  createControlPlaneProject,
  createEnvironment,
  createThread,
  appendStoredThreadEvent,
  setControlPlaneProfileAccess,
  setControlPlaneProfileEnabled,
} from "@bb/db";
import { threadScope } from "@bb/domain";
import { createControlPlaneClient } from "@bb/sdk/node";
import { createApp } from "../../src/server.js";
import {
  dispatchControlPlaneEnvironmentRead,
  withControlPlaneEnvironmentRead,
} from "../../src/control-plane/sdk-environment-read.js";
import { createControlPlaneAccess } from "../../src/control-plane/access.js";
import { createControlPlaneUserAccess } from "../../src/control-plane/user-access.js";
import { createControlPlaneThreadService } from "../../src/control-plane/threads.js";
import { hashAdminPassword } from "../../src/control-plane/credentials.js";
import { withTestHarness } from "../helpers/test-app.js";
import { seedHostSession } from "../helpers/seed.js";
import { seedControlPlaneProfile } from "../helpers/control-plane-profile.js";

it("scopes personal SDK reads and action admission to the persisted owner and current project/profile grants", async () => {
  await withTestHarness(async (harness) => {
    const registry = new ControlPlaneRegistry(harness.db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 299999,
    });
    const { host } = seedHostSession(harness.deps);
    const identities = ["alice", "bob"].map((login) => {
      const user = registry.reserve(login, 1);
      registry.environmentState(user.id, "ready");
      const { project } = createControlPlaneProject(harness.db, harness.hub, {
        userId: user.id,
        hostId: host.id,
        name: login,
        slug: "app",
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        hostId: host.id,
        projectId: project.id,
        path: `${user.projectsRoot}/app`,
        status: "ready",
        providerOwnsPath: false,
      });
      const profile = seedControlPlaneProfile(harness.db, user.id);
      const thread = createThread(harness.db, harness.hub, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "qwen-server",
        controlPlaneOwnerUserId: user.id,
        controlPlaneProfileVersionId: profile.versionId,
        status: "idle",
      });
      for (let index = 0; index < 3; index++)
        appendStoredThreadEvent(harness.db, harness.hub, {
          threadId: thread.id,
          type: "system/manager/user_message",
          scope: threadScope(),
          data: { text: `${login}-owned-answer-${index}` },
        });
      const token = `agt_${randomBytes(32).toString("base64url")}`;
      harness.db
        .insert(controlPlaneUserSessions)
        .values({
          userId: user.id,
          digest: createHash("sha256").update(token).digest("hex"),
          expiresAt: Date.now() + 60000,
        })
        .run();
      return { user, project, environment, profile, thread, token };
    });
    const alice = identities[0]!,
      bob = identities[1]!;
    const origin = "https://bb.example";
    harness.config.appUrl = origin;
    const server = createApp(harness.deps, {
      controlPlane: createControlPlaneAccess(
        {
          version: 1,
          publicOrigin: origin,
          admin: {
            login: "admin",
            passwordHash: await hashAdminPassword("long-test-only-password"),
          },
        },
        Date.now,
        createControlPlaneUserAccess(
          registry,
          origin,
          Date.now,
          undefined,
          createControlPlaneThreadService({ deps: harness.deps }),
        ),
      ),
    });
    const request = (
      token: string | null,
      path: string,
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
    const client = (token: string) =>
      createControlPlaneClient({
        origin,
        token: () => token,
        fetch: async (input, init) =>
          server.app.fetch(new Request(input, init)),
      });
    const api = client(alice.token).threads;
    const base = "/control-plane/user/threads";
    const sdkScope = <T>(run: () => T) =>
      withControlPlaneEnvironmentRead(
        {
          db: harness.db,
          userId: alice.user.id,
          projectId: alice.project.id,
          hostId: host.id,
          cwd: alice.environment.path!,
        },
        run,
      );
    const environmentRequest = (
      path = alice.environment.path!,
      method = "GET",
    ) =>
      new Request(
        `${origin}/api/v1/environments?${new URLSearchParams({ hostId: host.id, path })}`,
        { method },
      );
    const runningRequest = new Request(origin + "/api/v1/threads/running");
    const dispatchScope = <T>(run: () => T, pluginId = "concurrency-limit") =>
      withControlPlaneDispatchRead(
        {
          db: harness.db,
          threadId: alice.thread.id,
          pluginId,
          running: () => Response.json(listRunningThreads(harness.db)),
        },
        run,
      );
    try {
      expect(
        dispatchControlPlaneDispatchRead(alice.user.id, runningRequest),
      ).toBeNull();
      await dispatchScope(async () => {
        expect(
          await dispatchControlPlaneDispatchRead(
            alice.user.id,
            runningRequest,
          )?.json(),
        ).toEqual([]);
        expect(
          dispatchControlPlaneDispatchRead(bob.user.id, runningRequest),
        ).toBeNull();
        for (const path of [
          "/api/v1/threads",
          "/api/v1/threads/running?limit=1",
          "/api/v1/hosts",
        ])
          expect(
            dispatchControlPlaneDispatchRead(
              alice.user.id,
              new Request(origin + path),
            ),
          ).toBeNull();
        expect(
          dispatchControlPlaneDispatchRead(
            alice.user.id,
            new Request(runningRequest, { method: "POST" }),
          ),
        ).toBeNull();
      });
      dispatchScope(
        () =>
          expect(
            dispatchControlPlaneDispatchRead(alice.user.id, runningRequest),
          ).toBeNull(),
        "another-plugin",
      );
      expect(
        dispatchControlPlaneEnvironmentRead(
          alice.user.id,
          environmentRequest(),
        ),
      ).toBeNull();
      await sdkScope(async () => {
        const response = dispatchControlPlaneEnvironmentRead(
          alice.user.id,
          environmentRequest(),
        );
        expect(await response?.json()).toMatchObject([
          { id: alice.environment.id },
        ]);
        expect(
          dispatchControlPlaneEnvironmentRead(
            bob.user.id,
            environmentRequest(),
          ),
        ).toBeNull();
        expect(
          dispatchControlPlaneEnvironmentRead(
            alice.user.id,
            environmentRequest(bob.environment.path!),
          ),
        ).toBeNull();
        expect(
          dispatchControlPlaneEnvironmentRead(
            alice.user.id,
            environmentRequest(undefined, "POST"),
          ),
        ).toBeNull();
        for (const path of [
          "/api/v1/threads",
          "/api/v1/environments",
          "/api/v1/system",
          "/api/v1/environments?" +
            new URLSearchParams({
              hostId: host.id,
              path: alice.environment.path!,
              limit: "1",
            }),
        ])
          expect(
            dispatchControlPlaneEnvironmentRead(
              alice.user.id,
              new Request(origin + path),
            ),
          ).toBeNull();
      });
      expect((await request(null, base)).status).toBe(401);
      expect((await api.list()).threads.map((thread) => thread.id)).toEqual([
        alice.thread.id,
      ]);
      expect(await api.get(alice.thread.id)).toMatchObject({
        id: alice.thread.id,
        profileVersionId: alice.profile.versionId,
      });
      expect(await api.get(alice.thread.id)).not.toHaveProperty(
        "environmentId",
      );
      expect((await api.result(alice.thread.id)).text).toBe(
        "alice-owned-answer-2",
      );
      const first = await api.events(alice.thread.id, { limit: 2 });
      expect(first.events).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      expect(
        first.events.every((event) => event.threadId === alice.thread.id),
      ).toBe(true);
      const last = await api.events(alice.thread.id, {
        after: first.cursor,
        limit: 2,
      });
      expect(last.events).toHaveLength(1);
      expect(last.hasMore).toBe(false);
      expect(last.cursor).toBeGreaterThan(first.cursor);
      expect(await api.interactions.list(alice.thread.id)).toEqual([]);
      for (const suffix of ["", "/events", "/result", "/interactions"])
        expect(
          (await request(alice.token, `${base}/${bob.thread.id}${suffix}`))
            .status,
        ).toBe(404);
      for (const [suffix, body] of [
        ["send", { message: "foreign" }],
        ["stop", {}],
        ["interactions/pint_foreign/resolve", { decision: "deny" }],
      ] as const)
        expect(
          (
            await request(
              alice.token,
              `${base}/${bob.thread.id}/${suffix}`,
              "POST",
              body,
            )
          ).status,
        ).toBe(404);
      for (const patch of [
        { uid: alice.user.uid },
        { userId: bob.user.id },
        { cwd: "/tmp" },
        { environmentId: bob.environment.id },
        { providerId: "codex" },
        { model: "unapproved" },
        { tools: [] },
      ])
        expect(
          (
            await request(alice.token, base, "POST", {
              projectId: alice.project.id,
              profileVersionId: alice.profile.versionId,
              message: "hello",
              ...patch,
            })
          ).status,
        ).toBe(400);
      expect(
        (
          await request(alice.token, base, "POST", {
            projectId: bob.project.id,
            profileVersionId: alice.profile.versionId,
            message: "foreign project",
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(alice.token, base, "POST", {
            projectId: alice.project.id,
            profileVersionId: bob.profile.versionId,
            message: "foreign profile",
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(
            alice.token,
            `${base}/${alice.thread.id}/send`,
            "POST",
            { message: "steer", mode: "steer" },
          )
        ).status,
      ).toBe(400);
      for (const path of [
        "/api/v1/threads",
        "/api/v1/threads/running",
        "/api/v1/environments",
      ])
        expect((await request(alice.token, path)).status).toBe(401);
      for (const revoke of [
        {
          apply: () =>
            setControlPlaneProfileAccess(
              harness.db,
              alice.profile.profileId,
              alice.user.id,
              false,
            ),
          restore: () =>
            setControlPlaneProfileAccess(
              harness.db,
              alice.profile.profileId,
              alice.user.id,
              true,
            ),
        },
        {
          apply: () =>
            setControlPlaneProfileEnabled(
              harness.db,
              alice.profile.profileId,
              false,
              alice.profile.versionId,
            ),
          restore: () =>
            setControlPlaneProfileEnabled(
              harness.db,
              alice.profile.profileId,
              true,
              alice.profile.versionId,
            ),
        },
      ]) {
        revoke.apply();
        expect(() =>
          dispatchScope(() =>
            dispatchControlPlaneDispatchRead(alice.user.id, runningRequest),
          ),
        ).toThrow();
        expect(
          (
            await request(
              alice.token,
              `${base}/${alice.thread.id}/send`,
              "POST",
              { message: "must not dispatch" },
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await request(
              alice.token,
              `${base}/${alice.thread.id}/interactions/pint_missing/resolve`,
              "POST",
              { decision: "deny" },
            )
          ).status,
        ).toBe(403);
        expect((await api.result(alice.thread.id)).text).toBe(
          "alice-owned-answer-2",
        );
        expect((await api.events(alice.thread.id)).events).toHaveLength(3);
        revoke.restore();
      }
      harness.db
        .insert(controlPlaneProjectAccess)
        .values({
          projectId: alice.project.id,
          userId: bob.user.id,
          role: "viewer",
        })
        .run();
      expect(
        (await client(bob.token).threads.list({ projectId: alice.project.id }))
          .threads,
      ).toEqual([]);
      harness.db
        .delete(controlPlaneProjectAccess)
        .where(
          and(
            eq(controlPlaneProjectAccess.projectId, alice.project.id),
            eq(controlPlaneProjectAccess.userId, alice.user.id),
          ),
        )
        .run();
      sdkScope(() =>
        expect(
          dispatchControlPlaneEnvironmentRead(
            alice.user.id,
            environmentRequest(),
          ),
        ).toBeNull(),
      );
      expect((await api.list()).threads).toEqual([]);
      expect(
        (await request(alice.token, `${base}/${alice.thread.id}`)).status,
      ).toBe(404);
      harness.db
        .update(controlPlaneUsers)
        .set({ enabled: false })
        .where(eq(controlPlaneUsers.id, alice.user.id))
        .run();
      expect((await request(alice.token, base)).status).toBe(401);
    } finally {
      await server.pluginService.stop();
      await server.closeWebSockets();
    }
  });
});
