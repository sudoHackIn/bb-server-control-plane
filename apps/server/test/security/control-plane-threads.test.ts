import {
  createControlPlaneProject,
  setControlPlaneProfileAccess,
  setControlPlaneProfileEnabled,
  createEnvironment,
  ControlPlaneRegistry,
  ControlPlaneThreadError,
  controlPlaneUsers,
  createThread,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import { eq } from "drizzle-orm";
import { createMigratedConnection } from "@bb/db/testing";
import { Hono } from "hono";
import { expect, it } from "vitest";
import {
  createControlPlaneAccess,
  currentControlPlanePrincipal,
  withControlPlaneUser,
} from "../../src/control-plane/access.js";
import { hashAdminPassword } from "../../src/control-plane/credentials.js";
import { controlPlaneThreadOwnerForCreate } from "../../src/control-plane/thread-authority.js";
import { createThreadRecord } from "../../src/services/threads/thread-create-helpers.js";
import type { ThreadCreateServiceRequest } from "../../src/services/threads/thread-create-request.js";
import { attemptDispatch } from "../../src/services/threads/dispatch-attempt.js";
import { withTestHarness } from "../helpers/test-app.js";
import { textInput } from "../helpers/prompt-input.js";
import { seedControlPlaneProfile } from "../helpers/control-plane-profile.js";

it("rechecks the saved profile grant and version before inline or queued dispatch", async () => {
  await withTestHarness(async (harness) => {
    const registry = new ControlPlaneRegistry(harness.db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 299999,
    });
    const user = registry.reserve("alice", 1);
    registry.environmentState(user.id, "ready");
    const host = upsertHost(harness.db, harness.hub, { name: "Host" });
    const { project } = createControlPlaneProject(harness.db, harness.hub, {
      userId: user.id,
      hostId: host.id,
      name: "App",
      slug: "app",
    });
    const profile = seedControlPlaneProfile(harness.db, user.id);
    const thread = createThread(harness.db, harness.hub, {
      projectId: project.id,
      providerId: "qwen-server",
      controlPlaneOwnerUserId: user.id,
      controlPlaneProfileVersionId: profile.versionId,
      status: "pending",
    });
    for (const revoke of [
      () =>
        setControlPlaneProfileAccess(
          harness.db,
          profile.profileId,
          user.id,
          false,
        ),
      () =>
        setControlPlaneProfileEnabled(
          harness.db,
          profile.profileId,
          false,
          profile.versionId,
        ),
      () => setControlPlaneProfileEnabled(harness.db, profile.profileId, false),
    ]) {
      revoke();
      for (const source of [
        { kind: "inline" },
        {
          kind: "drain",
          claimed: [],
          respectManualStopPause: false,
          sendNow: false,
        },
      ] satisfies Parameters<typeof attemptDispatch>[1]["source"][]) {
        await expect(
          attemptDispatch(harness.deps, {
            thread,
            source,
            payload: { input: textInput("Must not execute"), mode: "start" },
            queuePayload: { kind: "inline" },
            pluginSubmission: null,
            origin: null,
            originPluginId: null,
            startedOnBehalfOf: null,
            trigger: source.kind === "inline" ? "user" : "auto-dispatch",
          }),
        ).rejects.toThrow(ControlPlaneThreadError);
      }
      setControlPlaneProfileAccess(
        harness.db,
        profile.profileId,
        user.id,
        true,
      );
      setControlPlaneProfileEnabled(
        harness.db,
        profile.profileId,
        true,
        profile.versionId,
      );
      setControlPlaneProfileEnabled(harness.db, profile.profileId, true);
    }
  });
});

it("rejects unauthenticated service creation, foreign identities and workspace overrides before creating a managed thread", () => {
  const db = createMigratedConnection();
  try {
    const registry = new ControlPlaneRegistry(db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 299999,
    });
    const alice = registry.reserve("alice", 1),
      bob = registry.reserve("bob", 1);
    registry.environmentState(alice.id, "ready");
    registry.environmentState(bob.id, "ready");
    const host = upsertHost(db, noopNotifier, { name: "Host" });
    const { project } = createControlPlaneProject(db, noopNotifier, {
      userId: alice.id,
      hostId: host.id,
      name: "App",
      slug: "app",
    });
    const path = `${alice.projectsRoot}/app`;
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path,
      providerOwnsPath: false,
      status: "ready",
    });
    const request: ThreadCreateServiceRequest = {
      controlPlaneProfileVersionId: seedControlPlaneProfile(db, alice.id)
        .versionId,
      projectId: project.id,
      providerId: "qwen-server",
      environment: { type: "reuse", environmentId: environment.id },
      input: [],
      origin: "app",
      pluginMetadata: null,
      startedOnBehalfOf: null,
      visibility: "visible",
      parentNotifications: "auto",
      titleFallback: null,
    };
    expect(() => controlPlaneThreadOwnerForCreate(db, request)).toThrow(
      "Project not found",
    );
    expect(() =>
      withControlPlaneUser(bob.id, () =>
        controlPlaneThreadOwnerForCreate(db, request),
      ),
    ).toThrow("Project not found");
    const thread = withControlPlaneUser(alice.id, () =>
      createThreadRecord(
        { db, hub: noopNotifier },
        { request, environmentId: environment.id },
      ),
    );
    expect(thread.projectId).toBe(project.id);
    for (const override of [
      {
        type: "host",
        hostId: host.id,
        workspace: { type: "unmanaged", path: bob.projectsRoot },
      },
      { type: "host", hostId: host.id, workspace: { type: "personal" } },
      {
        type: "host",
        hostId: host.id,
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "default" },
        },
      },
    ] satisfies ThreadCreateServiceRequest["environment"][])
      expect(() =>
        withControlPlaneUser(alice.id, () =>
          controlPlaneThreadOwnerForCreate(db, {
            ...request,
            environment: override,
          }),
        ),
      ).toThrow("Project not found");
    expect(() =>
      withControlPlaneUser(alice.id, () =>
        controlPlaneThreadOwnerForCreate(db, {
          ...request,
          projectId: "foreign",
        }),
      ),
    ).toThrow("Project not found");
  } finally {
    db.$client.close();
  }
});

it("preserves user authority across private SDK calls without granting it to other requests", async () => {
  const access = createControlPlaneAccess({
    version: 1,
    publicOrigin: "https://bb.example",
    admin: {
      login: "admin",
      passwordHash: await hashAdminPassword("long-test-password"),
    },
  });
  const app = new Hono();
  access.install(app);
  app.get("/api/v1/probe", (context) =>
    context.json(currentControlPlanePrincipal()),
  );
  const url = "https://bb.example/api/v1/probe";
  const user = await withControlPlaneUser("alice", () =>
    access.dispatch(app, url),
  );
  expect(await user.json()).toEqual({ kind: "user", userId: "alice" });
  const service = await access.dispatch(app, url);
  expect(await service.json()).toEqual({ kind: "service" });
  expect((await app.request(url)).status).toBe(401);
  expect(currentControlPlanePrincipal()).toBeNull();
});

it("blocks initial and queued dispatch after revocation without depending on a policy plugin", async () => {
  await withTestHarness(async (harness) => {
    const registry = new ControlPlaneRegistry(harness.db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 299999,
    });
    const user = registry.reserve("alice", 1);
    registry.environmentState(user.id, "ready");
    const host = upsertHost(harness.db, harness.hub, { name: "Host" });
    const { project } = createControlPlaneProject(harness.db, harness.hub, {
      userId: user.id,
      hostId: host.id,
      name: "App",
      slug: "app",
    });
    const thread = createThread(harness.db, harness.hub, {
      projectId: project.id,
      providerId: "qwen-server",
      controlPlaneOwnerUserId: user.id,
      controlPlaneProfileVersionId: seedControlPlaneProfile(harness.db, user.id)
        .versionId,
      status: "pending",
    });
    harness.db
      .update(controlPlaneUsers)
      .set({ enabled: false })
      .where(eq(controlPlaneUsers.id, user.id))
      .run();
    for (const source of [
      { kind: "inline" },
      {
        kind: "drain",
        claimed: [],
        respectManualStopPause: false,
        sendNow: false,
      },
    ] satisfies Parameters<typeof attemptDispatch>[1]["source"][]) {
      await expect(
        attemptDispatch(harness.deps, {
          thread,
          source,
          payload: { input: textInput("Must not run"), mode: "start" },
          queuePayload: { kind: "inline" },
          pluginSubmission: null,
          origin: null,
          originPluginId: null,
          startedOnBehalfOf: null,
          trigger: source.kind === "inline" ? "user" : "auto-dispatch",
        }),
      ).rejects.toBeInstanceOf(ControlPlaneThreadError);
    }
  });
});
