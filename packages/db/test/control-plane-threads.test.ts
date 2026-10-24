import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { createMigratedConnection } from "../src/testing.js";
import {
  ControlPlaneRegistry,
  listControlPlaneThreads,
  getControlPlaneThread,
  ControlPlaneThreadError,
  controlPlaneThreads,
  controlPlaneProjectAccess,
  controlPlaneUsers,
  createControlPlaneProject,
  createProject,
  createControlPlaneProfile,
  publishControlPlaneProfileVersion,
  setControlPlaneProfileAccess,
  setControlPlaneProfileEnabled,
  createEnvironment,
  createThread,
  createConnection,
  environments,
  noopNotifier,
  projectSources,
  threads,
  upsertHost,
  requireControlPlaneThreadDispatch,
  resolveControlPlaneQwenContext,
} from "../src/index.js";

function fixture() {
  const db = createMigratedConnection();
  const registry = new ControlPlaneRegistry(db, {
    usersRoot: "/srv/users",
    firstUid: 200000,
    lastUid: 299999,
  });
  const host = upsertHost(db, noopNotifier, { name: "Execution host" });
  const users = ["alice", "bob"].map((login) => {
    const user = registry.reserve(login, 1);
    registry.environmentState(user.id, "ready");
    const { project } = createControlPlaneProject(db, noopNotifier, {
      userId: user.id,
      hostId: host.id,
      name: login,
      slug: "app",
    });
    const cwd = `${user.projectsRoot}/app`;
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: cwd,
      providerOwnsPath: false,
      status: "ready",
    });
    const profile = createControlPlaneProfile(db, {
      slug: login,
      name: login,
      definition: {
        prompt: "Fixture",
        providerId: "qwen-server",
        model: "qwen-job-test",
        reasoningLevel: "none",
        permissionMode: "full",
        tools: [],
        mcpServers: [],
      },
    });
    setControlPlaneProfileAccess(db, profile.profileId, user.id, true);
    return { user, project, cwd, environment, profile };
  });
  const alice = users[0],
    bob = users[1];
  if (!alice || !bob) throw new Error("Missing fixture users");
  const start = (
    owner = alice,
    overrides: Partial<Parameters<typeof createThread>[2]> = {},
  ) =>
    createThread(db, noopNotifier, {
      projectId: owner.project.id,
      environmentId: owner.environment.id,
      providerId: "qwen-server",
      status: "starting",
      controlPlaneOwnerUserId: owner.user.id,
      controlPlaneProfileVersionId: owner.profile.versionId,
      ...overrides,
    });
  return { db, alice, bob, start };
}

it("commits ownership before notifications and rolls back missing or foreign authority without creating rows", () => {
  const { db, alice, bob, start } = fixture();
  try {
    const observed: string[] = [];
    createThread(
      db,
      {
        ...noopNotifier,
        notifyThread: (id) => {
          const owner = db
            .select()
            .from(controlPlaneThreads)
            .where(eq(controlPlaneThreads.threadId, id))
            .get();
          if (!owner) throw new Error("Published a thread before its owner");
          expect(owner.profileVersionId).toBe(alice.profile.versionId);
          observed.push(owner.ownerUserId);
        },
      },
      {
        projectId: alice.project.id,
        providerId: "qwen-server",
        controlPlaneOwnerUserId: alice.user.id,
        controlPlaneProfileVersionId: alice.profile.versionId,
      },
    );
    expect(observed).toEqual([alice.user.id]);
    expect(() => start(alice, { controlPlaneOwnerUserId: undefined })).toThrow(
      ControlPlaneThreadError,
    );
    expect(() =>
      start(alice, { controlPlaneOwnerUserId: bob.user.id }),
    ).toThrow(ControlPlaneThreadError);
    expect(() => start(alice, { environmentId: bob.environment.id })).toThrow(
      ControlPlaneThreadError,
    );
    expect(() => start(alice, { providerId: "codex" })).toThrow(
      ControlPlaneThreadError,
    );
    const parent = start();
    expect(start(alice, { parentThreadId: parent.id }).parentThreadId).toBe(
      parent.id,
    );
    const another = createControlPlaneProject(db, noopNotifier, {
      userId: alice.user.id,
      hostId: alice.environment.hostId,
      name: "Another",
      slug: "another",
    }).project;
    db.delete(controlPlaneProjectAccess)
      .where(eq(controlPlaneProjectAccess.projectId, alice.project.id))
      .run();
    expect(() =>
      start(alice, {
        projectId: another.id,
        environmentId: null,
        parentThreadId: parent.id,
      }),
    ).toThrow(ControlPlaneThreadError);
    db.insert(controlPlaneProjectAccess)
      .values({
        projectId: alice.project.id,
        userId: alice.user.id,
        role: "owner",
      })
      .run();
    for (const field of [
      "parentThreadId",
      "sourceThreadId",
      "lifecycleOwnerThreadId",
    ] as const)
      expect(() => start(bob, { [field]: parent.id })).toThrow(
        ControlPlaneThreadError,
      );
    expect(db.select().from(threads).all()).toHaveLength(3);
  } finally {
    db.$client.close();
  }
});

it("pins an authorized version before creation and denies revoked, retired or legacy unbound execution without upgrading the version", () => {
  const { db, alice, bob, start } = fixture();
  try {
    expect(() =>
      start(alice, { controlPlaneProfileVersionId: undefined }),
    ).toThrow(ControlPlaneThreadError);
    expect(() =>
      start(alice, { controlPlaneProfileVersionId: bob.profile.versionId }),
    ).toThrow(ControlPlaneThreadError);
    const unmanaged = createProject(db, noopNotifier, {
      name: "Unmanaged",
      source: {
        type: "local_path",
        hostId: alice.environment.hostId,
        path: "/srv/unmanaged",
      },
    });
    expect(() =>
      createThread(db, noopNotifier, {
        projectId: unmanaged.project.id,
        providerId: "test",
        controlPlaneProfileVersionId: alice.profile.versionId,
      }),
    ).toThrow(ControlPlaneThreadError);
    expect(
      createThread(db, noopNotifier, {
        projectId: unmanaged.project.id,
        providerId: "test",
      }).projectId,
    ).toBe(unmanaged.project.id);
    const thread = start();
    const original = requireControlPlaneThreadDispatch(
      db,
      thread.id,
    )?.profileVersion;
    if (!original) throw new Error("Missing admitted version");
    const revised = publishControlPlaneProfileVersion(
      db,
      alice.profile.profileId,
      { ...original.definition, prompt: "Published later" },
    );
    expect(
      requireControlPlaneThreadDispatch(db, thread.id)?.profileVersion.id,
    ).toBe(original.id);
    setControlPlaneProfileAccess(
      db,
      alice.profile.profileId,
      alice.user.id,
      false,
    );
    expect(() => requireControlPlaneThreadDispatch(db, thread.id)).toThrow(
      ControlPlaneThreadError,
    );
    expect(() =>
      resolveControlPlaneQwenContext(db, {
        threadId: thread.id,
        cwd: alice.cwd,
        sessionId: randomUUID(),
      }),
    ).toThrow(ControlPlaneThreadError);
    setControlPlaneProfileAccess(
      db,
      alice.profile.profileId,
      alice.user.id,
      true,
    );
    setControlPlaneProfileEnabled(
      db,
      alice.profile.profileId,
      false,
      original.id,
    );
    expect(() => requireControlPlaneThreadDispatch(db, thread.id)).toThrow(
      ControlPlaneThreadError,
    );
    expect(revised.id).not.toBe(original.id);
    setControlPlaneProfileEnabled(
      db,
      alice.profile.profileId,
      true,
      original.id,
    );
    setControlPlaneProfileEnabled(db, alice.profile.profileId, false);
    expect(() => requireControlPlaneThreadDispatch(db, thread.id)).toThrow(
      ControlPlaneThreadError,
    );
    setControlPlaneProfileEnabled(db, alice.profile.profileId, true);
    expect(
      requireControlPlaneThreadDispatch(db, thread.id)?.profileVersion.id,
    ).toBe(original.id);
    db.update(controlPlaneThreads)
      .set({ profileVersionId: null })
      .where(eq(controlPlaneThreads.threadId, thread.id))
      .run();
    expect(() => requireControlPlaneThreadDispatch(db, thread.id)).toThrow(
      ControlPlaneThreadError,
    );
    expect(
      db.select().from(threads).where(eq(threads.id, thread.id)).get()?.id,
    ).toBe(thread.id);
  } finally {
    db.$client.close();
  }
});

it("binds a native Qwen session once to one thread and preserves the binding after reopening SQLite", () => {
  const { db, alice, bob, start } = fixture();
  try {
    const a = start(),
      b = start(bob),
      sessionId = randomUUID();
    const input = { threadId: a.id, sessionId, cwd: alice.cwd };
    expect(resolveControlPlaneQwenContext(db, input)).toMatchObject({
      id: alice.user.id,
      uid: alice.user.uid,
      home: alice.user.home,
    });
    expect(resolveControlPlaneQwenContext(db, input).sessionId).toBe(sessionId);
    expect(() =>
      resolveControlPlaneQwenContext(db, {
        ...input,
        threadId: b.id,
        cwd: bob.cwd,
      }),
    ).toThrow(ControlPlaneThreadError);
    expect(() =>
      resolveControlPlaneQwenContext(db, { ...input, sessionId: randomUUID() }),
    ).toThrow(ControlPlaneThreadError);
    expect(() =>
      resolveControlPlaneQwenContext(db, { ...input, cwd: bob.cwd }),
    ).toThrow(ControlPlaneThreadError);
    const reopened = createConnection(db.$client.serialize());
    try {
      expect(resolveControlPlaneQwenContext(reopened, input).sessionId).toBe(
        sessionId,
      );
      expect(() =>
        resolveControlPlaneQwenContext(reopened, {
          ...input,
          sessionId: randomUUID(),
        }),
      ).toThrow(ControlPlaneThreadError);
    } finally {
      reopened.$client.close();
    }
  } finally {
    db.$client.close();
  }
});

it("rechecks grants, user status and workspace bindings on every dispatch and Qwen start", () => {
  const { db, alice, start } = fixture();
  try {
    const thread = start();
    const input = {
      threadId: thread.id,
      sessionId: randomUUID(),
      cwd: alice.cwd,
    };
    expect(requireControlPlaneThreadDispatch(db, thread.id)?.user.id).toBe(
      alice.user.id,
    );
    db.update(controlPlaneProjectAccess)
      .set({ role: "viewer" })
      .where(
        and(
          eq(controlPlaneProjectAccess.projectId, alice.project.id),
          eq(controlPlaneProjectAccess.userId, alice.user.id),
        ),
      )
      .run();
    expect(() => requireControlPlaneThreadDispatch(db, thread.id)).toThrow(
      ControlPlaneThreadError,
    );
    db.update(controlPlaneProjectAccess)
      .set({ role: "owner" })
      .where(eq(controlPlaneProjectAccess.userId, alice.user.id))
      .run();
    db.update(controlPlaneUsers)
      .set({ enabled: false })
      .where(eq(controlPlaneUsers.id, alice.user.id))
      .run();
    expect(() => resolveControlPlaneQwenContext(db, input)).toThrow(
      ControlPlaneThreadError,
    );
    db.update(controlPlaneUsers)
      .set({ enabled: true })
      .where(eq(controlPlaneUsers.id, alice.user.id))
      .run();
    db.update(environments)
      .set({ path: "/srv/elsewhere" })
      .where(eq(environments.id, alice.environment.id))
      .run();
    expect(() => requireControlPlaneThreadDispatch(db, thread.id)).toThrow(
      ControlPlaneThreadError,
    );
    db.update(environments)
      .set({ path: alice.cwd })
      .where(eq(environments.id, alice.environment.id))
      .run();
    db.update(projectSources)
      .set({ path: "/srv/elsewhere" })
      .where(eq(projectSources.projectId, alice.project.id))
      .run();
    expect(() => resolveControlPlaneQwenContext(db, input)).toThrow(
      ControlPlaneThreadError,
    );
    db.update(projectSources)
      .set({ path: alice.cwd })
      .where(eq(projectSources.projectId, alice.project.id))
      .run();
    db.update(threads)
      .set({ status: "stopping" })
      .where(eq(threads.id, thread.id))
      .run();
    expect(() => resolveControlPlaneQwenContext(db, input)).toThrow(
      ControlPlaneThreadError,
    );
  } finally {
    db.$client.close();
  }
});

it("lists and reads only owned threads under current project grants without duplicate shared-project rows", () => {
  const { db, alice, bob, start } = fixture();
  try {
    const first = start(),
      second = start();
    const foreign = start(bob);
    db.insert(controlPlaneProjectAccess)
      .values({
        projectId: alice.project.id,
        userId: bob.user.id,
        role: "viewer",
      })
      .run();
    const listed = listControlPlaneThreads(db, alice.user.id, {
      cursor: null,
      limit: 50,
    });
    expect(new Set(listed.threads.map((thread) => thread.id))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(listed.threads).toHaveLength(2);
    expect(listed.threads[0]).not.toHaveProperty("environmentId");
    expect(
      listControlPlaneThreads(db, bob.user.id, {
        projectId: alice.project.id,
        cursor: null,
        limit: 50,
      }).threads,
    ).toEqual([]);
    expect(getControlPlaneThread(db, bob.user.id, first.id)).toBeNull();
    expect(getControlPlaneThread(db, alice.user.id, foreign.id)).toBeNull();
    const page = listControlPlaneThreads(db, alice.user.id, {
      cursor: null,
      limit: 1,
    });
    expect(page.nextCursor).toBe(page.threads[0]?.id);
    const next = listControlPlaneThreads(db, alice.user.id, {
      cursor: page.nextCursor,
      limit: 1,
    });
    expect(next.threads).toHaveLength(1);
    expect(next.threads[0]?.id).not.toBe(page.threads[0]?.id);
    expect(next.nextCursor).toBeNull();
    setControlPlaneProfileAccess(
      db,
      alice.profile.profileId,
      alice.user.id,
      false,
    );
    expect(getControlPlaneThread(db, alice.user.id, first.id)?.id).toBe(
      first.id,
    );
    db.delete(controlPlaneProjectAccess)
      .where(
        and(
          eq(controlPlaneProjectAccess.projectId, alice.project.id),
          eq(controlPlaneProjectAccess.userId, alice.user.id),
        ),
      )
      .run();
    expect(getControlPlaneThread(db, alice.user.id, first.id)).toBeNull();
    expect(
      listControlPlaneThreads(db, alice.user.id, { cursor: null, limit: 50 })
        .threads,
    ).toEqual([]);
  } finally {
    db.$client.close();
  }
});

it("preserves owned archived history but excludes deleted and invalid-source threads", () => {
  const { db, alice, start } = fixture();
  try {
    const archived = start(),
      deleted = start();
    db.update(threads)
      .set({ archivedAt: 1 })
      .where(eq(threads.id, archived.id))
      .run();
    db.update(threads)
      .set({ deletedAt: 1 })
      .where(eq(threads.id, deleted.id))
      .run();
    expect(
      getControlPlaneThread(db, alice.user.id, archived.id)?.archivedAt,
    ).toBe(1);
    expect(getControlPlaneThread(db, alice.user.id, deleted.id)).toBeNull();
    expect(
      listControlPlaneThreads(db, alice.user.id, { cursor: null, limit: 50 })
        .threads,
    ).toMatchObject([{ id: archived.id, archived: true }]);
    db.update(projectSources)
      .set({ path: "/foreign" })
      .where(eq(projectSources.projectId, alice.project.id))
      .run();
    expect(getControlPlaneThread(db, alice.user.id, archived.id)).toBeNull();
    expect(
      listControlPlaneThreads(db, alice.user.id, { cursor: null, limit: 50 })
        .threads,
    ).toEqual([]);
  } finally {
    db.$client.close();
  }
});
