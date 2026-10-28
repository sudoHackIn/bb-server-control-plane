import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { createMigratedConnection } from "../src/testing.js";
import {
  ControlPlaneRegistry,
  ControlPlaneJobError,
  createControlPlaneJobBinding,
  createControlPlaneProject,
  createControlPlaneProfile,
  createThread,
  createConnection,
  controlPlaneJobBindings,
  controlPlaneThreads,
  controlPlaneProjectAccess,
  controlPlaneUsers,
  deleteControlPlaneJobBinding,
  getControlPlaneJobBinding,
  listControlPlaneJobBindings,
  noopNotifier,
  projects,
  publishControlPlaneProfileVersion,
  requireControlPlaneJobDispatch,
  setControlPlaneJobEnabled,
  setControlPlaneProfileAccess,
  setControlPlaneProfileEnabled,
  threads,
  upsertHost,
} from "../src/index.js";
import {
  controlPlaneJobKindValues,
  type ControlPlaneJobBinding,
} from "@bb/domain";

function fixture() {
  const db = createMigratedConnection();
  const registry = new ControlPlaneRegistry(db, {
    usersRoot: "/srv/users",
    firstUid: 200000,
    lastUid: 299999,
  });
  const host = upsertHost(db, noopNotifier, { name: "Jobs host" });
  function user(login: string) {
    const user = registry.reserve(login, 1);
    registry.environmentState(user.id, "ready");
    const { project } = createControlPlaneProject(db, noopNotifier, {
      userId: user.id,
      hostId: host.id,
      name: login,
      slug: "app",
    });
    const profile = createControlPlaneProfile(db, {
      slug: login,
      name: login,
      definition: {
        prompt: "Job",
        providerId: "qwen-server",
        model: "qwen-job-test",
        reasoningLevel: "none",
        permissionMode: "full",
        tools: [],
        mcpServers: [],
      },
    });
    setControlPlaneProfileAccess(db, profile.profileId, user.id, true);
    const origin = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "qwen-server",
      controlPlaneOwnerUserId: user.id,
      controlPlaneProfileVersionId: profile.versionId,
    });
    const input: ControlPlaneJobBinding = {
      kind: "automation",
      revision: 1,
      objectId: randomUUID(),
      userId: user.id,
      projectId: project.id,
      profileVersionId: profile.versionId,
      originThreadId: origin.id,
      sourceBindingId: null,
    };
    return { user, project, profile, origin, input };
  }
  const alice = user("alice"),
    bob = user("bob");
  return { db, registry, host, alice, bob };
}

it("filters every job kind by current owner/project before pagination, including shared projects", () => {
  const { db, alice, bob } = fixture();
  try {
    function allJobs(subject: typeof alice) {
      const parent = createControlPlaneJobBinding(db, {
        ...subject.input,
        kind: "workflow-run",
      });
      const automationParent = createControlPlaneJobBinding(db, {
        ...subject.input,
        kind: "automation-run",
      });
      return controlPlaneJobKindValues.map((kind) =>
        kind === "workflow-run"
          ? parent
          : kind === "automation-run"
            ? automationParent
            : createControlPlaneJobBinding(db, {
                ...subject.input,
                kind,
                sourceBindingId:
                  kind === "workflow-worker"
                    ? parent.id
                    : kind === "automation-worker"
                      ? automationParent.id
                      : null,
              }),
      );
    }
    const aliceJobs = allJobs(alice);
    allJobs(bob);
    db.insert(controlPlaneProjectAccess)
      .values({
        projectId: alice.project.id,
        userId: bob.user.id,
        role: "viewer",
      })
      .run();
    expect(
      getControlPlaneJobBinding(db, bob.user.id, aliceJobs[0]!.id),
    ).toBeNull();
    expect(
      listControlPlaneJobBindings(db, bob.user.id, {
        projectId: alice.project.id,
        cursor: null,
        limit: 1,
      }),
    ).toEqual({ bindings: [], nextCursor: null });
    const found: string[] = [];
    let cursor: string | null = null;
    do {
      const page = listControlPlaneJobBindings(db, alice.user.id, {
        cursor,
        limit: 1,
      });
      found.push(...page.bindings.map((job) => job.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(found.sort()).toEqual(aliceJobs.map((job) => job.id).sort());
    expect(
      listControlPlaneJobBindings(db, alice.user.id, {
        kind: "schedule",
        cursor: null,
        limit: 100,
      }).bindings,
    ).toHaveLength(1);
    expect(() =>
      listControlPlaneJobBindings(db, alice.user.id, {
        cursor: null,
        limit: 101,
      }),
    ).toThrow();
    expect(() =>
      setControlPlaneJobEnabled(db, bob.user.id, aliceJobs[0]!.id, false),
    ).toThrow(ControlPlaneJobError);
    expect(() =>
      deleteControlPlaneJobBinding(db, bob.user.id, aliceJobs[0]!.id),
    ).toThrow(ControlPlaneJobError);
  } finally {
    db.$client.close();
  }
});

it.each(["workflow-worker", "automation-worker"] as const)(
  "denies a %s under a different run kind",
  (kind) => {
    const { db, alice } = fixture();
    try {
      const parent = createControlPlaneJobBinding(db, {
        ...alice.input,
        kind: kind === "workflow-worker" ? "automation-run" : "workflow-run",
      });
      expect(() =>
        createControlPlaneJobBinding(db, {
          ...alice.input,
          kind,
          sourceBindingId: parent.id,
        }),
      ).toThrow(ControlPlaneJobError);
    } finally {
      db.$client.close();
    }
  },
);

it("registers immutable bindings idempotently and atomically rejects foreign, transplanted or extra authority", () => {
  const { db, alice, bob, host } = fixture();
  try {
    const a = createControlPlaneJobBinding(db, alice.input);
    const b = createControlPlaneJobBinding(db, bob.input);
    expect(createControlPlaneJobBinding(db, alice.input)).toEqual(a);
    const other = createControlPlaneProject(db, noopNotifier, {
      userId: alice.user.id,
      hostId: host.id,
      name: "Other",
      slug: "other",
    }).project;
    for (const overrides of [
      { userId: bob.user.id },
      { projectId: bob.project.id },
      { profileVersionId: bob.profile.versionId },
      { originThreadId: bob.origin.id },
      { sourceBindingId: b.id },
      { sourceBindingId: randomUUID() },
      { projectId: other.id },
    ])
      expect(() =>
        createControlPlaneJobBinding(db, { ...alice.input, ...overrides }),
      ).toThrow(ControlPlaneJobError);
    for (const extra of [
      { uid: bob.user.uid },
      { home: bob.user.home },
      { token: "browser-token" },
    ])
      expect(() =>
        createControlPlaneJobBinding(db, { ...alice.input, ...extra }),
      ).toThrow();
    expect(() =>
      createControlPlaneJobBinding(db, {
        ...bob.input,
        objectId: alice.input.objectId,
      }),
    ).toThrow(ControlPlaneJobError);
    expect(db.select().from(controlPlaneJobBindings).all()).toHaveLength(2);
    expect(requireControlPlaneJobDispatch(db, a.id).user.id).toBe(
      alice.user.id,
    );
  } finally {
    db.$client.close();
  }
});

it("rechecks the entire source lineage and pinned profile versions while retaining authorized history", () => {
  const { db, alice } = fixture();
  try {
    const parent = createControlPlaneJobBinding(db, alice.input);
    const version = publishControlPlaneProfileVersion(
      db,
      alice.profile.profileId,
      {
        prompt: "New",
        providerId: "qwen-server",
        model: "new-model",
        reasoningLevel: "none",
        permissionMode: "full",
        tools: [],
        mcpServers: [],
      },
    );
    const child = createControlPlaneJobBinding(db, {
      ...alice.input,
      kind: "automation-run",
      profileVersionId: version.id,
      sourceBindingId: parent.id,
    });
    expect(requireControlPlaneJobDispatch(db, child.id).profileVersion.id).toBe(
      version.id,
    );
    setControlPlaneJobEnabled(db, alice.user.id, parent.id, false);
    expect(() => requireControlPlaneJobDispatch(db, child.id)).toThrow(
      ControlPlaneJobError,
    );
    setControlPlaneJobEnabled(db, alice.user.id, parent.id, true);
    setControlPlaneProfileEnabled(
      db,
      alice.profile.profileId,
      false,
      alice.profile.versionId,
    );
    expect(() => requireControlPlaneJobDispatch(db, child.id)).toThrow(
      ControlPlaneJobError,
    );
    expect(getControlPlaneJobBinding(db, alice.user.id, child.id)?.id).toBe(
      child.id,
    );
    setControlPlaneJobEnabled(db, alice.user.id, child.id, false);
    expect(() =>
      setControlPlaneJobEnabled(db, alice.user.id, child.id, true),
    ).toThrow(ControlPlaneJobError);
    setControlPlaneProfileEnabled(
      db,
      alice.profile.profileId,
      true,
      alice.profile.versionId,
    );
    setControlPlaneJobEnabled(db, alice.user.id, child.id, true);
    expect(
      requireControlPlaneJobDispatch(db, child.id).binding.profileVersionId,
    ).toBe(version.id);
    deleteControlPlaneJobBinding(db, alice.user.id, parent.id);
    expect(() => requireControlPlaneJobDispatch(db, child.id)).toThrow(
      ControlPlaneJobError,
    );
    expect(() => createControlPlaneJobBinding(db, alice.input)).toThrow(
      ControlPlaneJobError,
    );
    expect(getControlPlaneJobBinding(db, alice.user.id, parent.id)).toBeNull();
  } finally {
    db.$client.close();
  }
});

it("revokes execution after user/project/profile loss without turning metadata or old jobs into authority", () => {
  const { db, alice } = fixture();
  try {
    const job = createControlPlaneJobBinding(db, alice.input);
    db.update(controlPlaneProjectAccess)
      .set({ role: "viewer" })
      .where(eq(controlPlaneProjectAccess.userId, alice.user.id))
      .run();
    expect(getControlPlaneJobBinding(db, alice.user.id, job.id)?.id).toBe(
      job.id,
    );
    expect(() => requireControlPlaneJobDispatch(db, job.id)).toThrow(
      ControlPlaneJobError,
    );
    db.update(controlPlaneProjectAccess)
      .set({ role: "owner" })
      .where(eq(controlPlaneProjectAccess.userId, alice.user.id))
      .run();
    setControlPlaneProfileAccess(
      db,
      alice.profile.profileId,
      alice.user.id,
      false,
    );
    expect(() => requireControlPlaneJobDispatch(db, job.id)).toThrow(
      ControlPlaneJobError,
    );
    setControlPlaneProfileAccess(
      db,
      alice.profile.profileId,
      alice.user.id,
      true,
    );
    db.update(controlPlaneUsers)
      .set({ enabled: false })
      .where(eq(controlPlaneUsers.id, alice.user.id))
      .run();
    expect(getControlPlaneJobBinding(db, alice.user.id, job.id)).toBeNull();
    expect(
      listControlPlaneJobBindings(db, alice.user.id, {
        cursor: null,
        limit: 100,
      }).bindings,
    ).toEqual([]);
    expect(() => requireControlPlaneJobDispatch(db, job.id)).toThrow(
      ControlPlaneJobError,
    );
    expect(() => requireControlPlaneJobDispatch(db, randomUUID())).toThrow(
      ControlPlaneJobError,
    );
  } finally {
    db.$client.close();
  }
});

it("preserves source references after physical origin deletion and fails closed on corrupt source cycles", () => {
  const { db, alice } = fixture();
  try {
    const parent = createControlPlaneJobBinding(db, {
      ...alice.input,
      originThreadId: null,
    });
    const child = createControlPlaneJobBinding(db, {
      ...alice.input,
      kind: "workflow-run",
      sourceBindingId: parent.id,
    });
    db.update(controlPlaneJobBindings)
      .set({ sourceBindingId: child.id })
      .where(eq(controlPlaneJobBindings.id, parent.id))
      .run();
    expect(() => requireControlPlaneJobDispatch(db, child.id)).toThrow(
      ControlPlaneJobError,
    );
    db.update(controlPlaneJobBindings)
      .set({ sourceBindingId: null })
      .where(eq(controlPlaneJobBindings.id, parent.id))
      .run();
    db.delete(threads).where(eq(threads.id, alice.origin.id)).run();
    expect(
      getControlPlaneJobBinding(db, alice.user.id, child.id)?.originThreadId,
    ).toBe(alice.origin.id);
    expect(() => requireControlPlaneJobDispatch(db, child.id)).toThrow(
      ControlPlaneJobError,
    );
    expect(requireControlPlaneJobDispatch(db, parent.id).user.id).toBe(
      alice.user.id,
    );
    db.delete(projects).where(eq(projects.id, alice.project.id)).run();
    expect(db.select().from(controlPlaneJobBindings).all()).toEqual([]);
  } finally {
    db.$client.close();
  }
});

it("survives SQLite reopening with pinned profile and registry identity without a browser credential", () => {
  const { db, registry, alice } = fixture();
  try {
    const job = createControlPlaneJobBinding(db, alice.input);
    const tokenDigest = "a".repeat(64);
    expect(
      registry.createSession(alice.user.id, tokenDigest, 1000, 1, null),
    ).toBe(true);
    registry.revoke(tokenDigest);
    const reopened = createConnection(db.$client.serialize());
    try {
      const execution = requireControlPlaneJobDispatch(reopened, job.id);
      expect(execution.user).toMatchObject({
        id: alice.user.id,
        uid: alice.user.uid,
        home: alice.user.home,
      });
      expect(execution.project.cwd).toBe(`${alice.user.projectsRoot}/app`);
      expect(execution.binding.profileVersionId).toBe(alice.profile.versionId);
      expect(execution.profileVersion.definition.model).toBe("qwen-job-test");
    } finally {
      reopened.$client.close();
    }
  } finally {
    db.$client.close();
  }
});

it("bounds durable source chains before insertion and prevents root deletion from becoming unbound execution", () => {
  const { db, alice } = fixture();
  try {
    let parent = createControlPlaneJobBinding(db, {
      ...alice.input,
      originThreadId: null,
    });
    const root = parent;
    for (let index = 1; index < 32; index++) {
      parent = createControlPlaneJobBinding(db, {
        ...alice.input,
        objectId: randomUUID(),
        originThreadId: null,
        sourceBindingId: parent.id,
      });
    }
    expect(requireControlPlaneJobDispatch(db, parent.id).user.id).toBe(
      alice.user.id,
    );
    expect(() =>
      createControlPlaneJobBinding(db, {
        ...alice.input,
        objectId: randomUUID(),
        sourceBindingId: parent.id,
      }),
    ).toThrow(ControlPlaneJobError);
    expect(db.select().from(controlPlaneJobBindings).all()).toHaveLength(32);
    deleteControlPlaneJobBinding(db, alice.user.id, root.id);
    expect(() => requireControlPlaneJobDispatch(db, parent.id)).toThrow(
      ControlPlaneJobError,
    );
  } finally {
    db.$client.close();
  }
});

it("adds a new immutable definition revision without moving its owner or changing prior run profiles", () => {
  const { db, alice, bob, host } = fixture();
  try {
    const first = createControlPlaneJobBinding(db, alice.input);
    const run = createControlPlaneJobBinding(db, {
      ...alice.input,
      kind: "automation-run",
      sourceBindingId: first.id,
    });
    const profile = publishControlPlaneProfileVersion(
      db,
      alice.profile.profileId,
      {
        prompt: "Edited definition",
        providerId: "qwen-server",
        model: "new-model",
        reasoningLevel: "none",
        permissionMode: "full",
        tools: [],
        mcpServers: [],
      },
    );
    const next = createControlPlaneJobBinding(db, {
      ...alice.input,
      revision: 2,
      profileVersionId: profile.id,
    });
    expect(next.id).not.toBe(first.id);
    expect(next.objectId).toBe(first.objectId);
    expect(
      requireControlPlaneJobDispatch(db, next.id).profileVersion.definition
        .model,
    ).toBe("new-model");
    expect(
      requireControlPlaneJobDispatch(db, run.id).profileVersion.definition
        .model,
    ).toBe("qwen-job-test");
    expect(() =>
      createControlPlaneJobBinding(db, {
        ...bob.input,
        objectId: first.objectId,
        revision: 3,
      }),
    ).toThrow(ControlPlaneJobError);
    const otherProject = createControlPlaneProject(db, noopNotifier, {
      userId: alice.user.id,
      hostId: host.id,
      name: "Other revision project",
      slug: "other-revision",
    }).project;
    expect(() =>
      createControlPlaneJobBinding(db, {
        ...alice.input,
        revision: 3,
        projectId: otherProject.id,
        originThreadId: null,
      }),
    ).toThrow(ControlPlaneJobError);
    expect(
      createControlPlaneJobBinding(db, {
        ...alice.input,
        revision: 2,
        profileVersionId: profile.id,
      }),
    ).toEqual(next);
  } finally {
    db.$client.close();
  }
});

it("checks worker-origin ancestry as a graph without rejecting convergent dependencies", () => {
  const { db, alice } = fixture();
  try {
    const parent = createControlPlaneJobBinding(db, {
      ...alice.input,
      kind: "workflow-run",
    });
    expect(() =>
      createControlPlaneJobBinding(db, {
        ...alice.input,
        kind: "workflow-worker",
      }),
    ).toThrow(ControlPlaneJobError);
    const worker = createControlPlaneJobBinding(db, {
      ...alice.input,
      kind: "workflow-worker",
      objectId: randomUUID(),
      sourceBindingId: parent.id,
    });
    const thread = createThread(db, noopNotifier, {
      projectId: alice.project.id,
      providerId: "qwen-server",
      originPluginId: "workflows",
      controlPlaneOwnerUserId: alice.user.id,
      controlPlaneProfileVersionId: alice.profile.versionId,
      controlPlaneJobBindingId: worker.id,
    });
    expect(
      db
        .select()
        .from(controlPlaneThreads)
        .where(eq(controlPlaneThreads.threadId, thread.id))
        .get()?.jobBindingId,
    ).toBe(worker.id);
    const nested = createControlPlaneJobBinding(db, {
      ...alice.input,
      objectId: randomUUID(),
      kind: "workflow-run",
      sourceBindingId: parent.id,
      originThreadId: thread.id,
    });
    expect(requireControlPlaneJobDispatch(db, nested.id).user.id).toBe(
      alice.user.id,
    );
    setControlPlaneJobEnabled(db, alice.user.id, worker.id, false);
    expect(() => requireControlPlaneJobDispatch(db, nested.id)).toThrow(
      ControlPlaneJobError,
    );
    setControlPlaneJobEnabled(db, alice.user.id, worker.id, true);
    expect(requireControlPlaneJobDispatch(db, nested.id).binding.id).toBe(
      nested.id,
    );
    db.update(controlPlaneJobBindings)
      .set({ originThreadId: thread.id })
      .where(eq(controlPlaneJobBindings.id, parent.id))
      .run();
    expect(() => requireControlPlaneJobDispatch(db, parent.id)).toThrow(
      ControlPlaneJobError,
    );
    expect(() => requireControlPlaneJobDispatch(db, nested.id)).toThrow(
      ControlPlaneJobError,
    );
  } finally {
    db.$client.close();
  }
});

it("runs pinned automation workers without a conversation and rejects a different worker version", () => {
  const { db, alice, bob } = fixture();
  try {
    const root = createControlPlaneJobBinding(db, {
      ...alice.input,
      originThreadId: null,
    });
    const run = createControlPlaneJobBinding(db, {
      ...alice.input,
      kind: "automation-run",
      objectId: randomUUID(),
      originThreadId: null,
      sourceBindingId: root.id,
    });
    const worker = createControlPlaneJobBinding(db, {
      ...alice.input,
      kind: "automation-worker",
      objectId: randomUUID(),
      originThreadId: null,
      sourceBindingId: run.id,
    });
    expect(requireControlPlaneJobDispatch(db, worker.id).user.id).toBe(
      alice.user.id,
    );
    const version = publishControlPlaneProfileVersion(
      db,
      alice.profile.profileId,
      {
        prompt: "New",
        providerId: "qwen-server",
        model: "new",
        reasoningLevel: "none",
        permissionMode: "full",
        tools: [],
        mcpServers: [],
      },
    );
    expect(() =>
      createControlPlaneJobBinding(db, {
        ...alice.input,
        kind: "automation-worker",
        objectId: randomUUID(),
        originThreadId: null,
        profileVersionId: version.id,
        sourceBindingId: run.id,
      }),
    ).toThrow(ControlPlaneJobError);
    expect(() =>
      createControlPlaneJobBinding(db, {
        ...bob.input,
        kind: "automation-worker",
        objectId: randomUUID(),
        originThreadId: null,
        sourceBindingId: run.id,
      }),
    ).toThrow(ControlPlaneJobError);
    const legacy = createControlPlaneJobBinding(db, {
      ...alice.input,
      objectId: randomUUID(),
    });
    db.update(threads)
      .set({ archivedAt: 123, deletedAt: 124 })
      .where(eq(threads.id, alice.origin.id))
      .run();
    expect(
      requireControlPlaneJobDispatch(db, legacy.id).profileVersion.id,
    ).toBe(alice.profile.versionId);
    setControlPlaneProfileAccess(
      db,
      alice.profile.profileId,
      alice.user.id,
      false,
    );
    expect(() => requireControlPlaneJobDispatch(db, worker.id)).toThrow(
      ControlPlaneJobError,
    );
    expect(() => requireControlPlaneJobDispatch(db, legacy.id)).toThrow(
      ControlPlaneJobError,
    );
  } finally {
    db.$client.close();
  }
});
