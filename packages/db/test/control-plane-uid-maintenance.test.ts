import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  ControlPlaneRegistry,
  createControlPlaneProject,
  createEnvironment,
  createControlPlaneProfile,
  setControlPlaneProfileAccess,
  createThread,
  createControlPlaneJobBinding,
  requireControlPlaneThreadDispatch,
  requireControlPlaneJobDispatch,
  resolveControlPlaneQwenContext,
  getControlPlaneThread,
  noopNotifier,
  upsertHost,
  reserveControlPlaneUidMaintenance,
  getControlPlaneUidMaintenance,
  checkpointControlPlaneUidMaintenance,
  controlPlaneUidGeneration,
  controlPlaneUidMaintenanceBlocksExecution,
  getControlPlaneProjectAccessPolicy,
  acknowledgeControlPlaneProjectAccessPolicy,
  controlPlaneProjects,
  migrate,
} from "../src/index.js";
import { createMigratedConnection } from "../src/testing.js";

function fixture() {
  const db = createMigratedConnection();
  const registry = new ControlPlaneRegistry(db, {
    usersRoot: "/srv/users",
    firstUid: 200000,
    lastUid: 299999,
  });
  const host = upsertHost(db, noopNotifier, { name: "Maintenance" });
  const subjects = ["alice", "bob"].map((login) => {
    const user = registry.reserve(login, 1);
    registry.environmentState(user.id, "ready");
    const { project } = createControlPlaneProject(db, noopNotifier, {
      userId: user.id,
      hostId: host.id,
      slug: "app",
      name: login,
    });
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: user.projectsRoot + "/app",
      providerOwnsPath: false,
      status: "ready",
    });
    const profile = createControlPlaneProfile(db, {
      slug: login,
      name: login,
      definition: {
        prompt: "Test",
        providerId: "qwen-server",
        model: "test",
        reasoningLevel: "none",
        permissionMode: "full",
        tools: [],
        mcpServers: [],
      },
    });
    setControlPlaneProfileAccess(db, profile.profileId, user.id, true);
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "qwen-server",
      status: "starting",
      controlPlaneOwnerUserId: user.id,
      controlPlaneProfileVersionId: profile.versionId,
    });
    const binding = createControlPlaneJobBinding(db, {
      userId: user.id,
      kind: "automation",
      objectId: randomUUID(),
      revision: 1,
      projectId: project.id,
      profileVersionId: profile.versionId,
      originThreadId: thread.id,
      sourceBindingId: null,
    });
    return { user, project, environment, profile, thread, binding };
  });
  const alice = subjects[0],
    bob = subjects[1];
  if (!alice || !bob) throw new Error("Missing actors");
  const reserve = (
    operationId = randomUUID(),
    rootGeneration = 0,
    restartGeneration?: number,
  ) =>
    reserveControlPlaneUidMaintenance(db, {
      userId: alice.user.id,
      projectId: alice.project.id,
      operationId,
      rootGeneration,
      ...(restartGeneration === undefined ? {} : { restartGeneration }),
    });
  const acknowledge = () => {
    const p = getControlPlaneProjectAccessPolicy(db, alice.project.id);
    if (!p) throw new Error("Missing policy");
    expect(
      acknowledgeControlPlaneProjectAccessPolicy(
        db,
        alice.project.id,
        p.revision,
      ),
    ).toBe(true);
  };
  return { db, alice, bob, reserve, acknowledge };
}
let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
afterEach(() => f.db.$client.close());
it("blocks every owned thread/job while preserving metadata and the other user's execution", () => {
  const original = resolveControlPlaneQwenContext(f.db, {
    threadId: f.alice.thread.id,
    sessionId: randomUUID(),
    cwd: f.alice.environment.path!,
  });
  expect(original.maintenanceGeneration).toBe(0);
  const state = f.reserve();
  expect(state.phase).toBe("blocking");
  expect(() =>
    requireControlPlaneThreadDispatch(f.db, f.alice.thread.id),
  ).toThrow();
  expect(() =>
    requireControlPlaneJobDispatch(f.db, f.alice.binding.id),
  ).toThrow();
  expect(
    getControlPlaneThread(f.db, f.alice.user.id, f.alice.thread.id),
  ).not.toBeNull();
  expect(
    requireControlPlaneThreadDispatch(f.db, f.bob.thread.id)
      ?.maintenanceGeneration,
  ).toBe(0);
  expect(
    requireControlPlaneJobDispatch(f.db, f.bob.binding.id)
      .maintenanceGeneration,
  ).toBe(0);
});
it("keeps idempotent pending reservations and refuses overlapping or closed operations", () => {
  const a = f.reserve();
  expect(f.reserve(a.operationId)).toEqual(a);
  expect(() => f.reserve()).toThrow("busy");
  expect(
    checkpointControlPlaneUidMaintenance(
      f.db,
      a.userId,
      a.operationId,
      a.generation,
      "blocked",
    ),
  ).toBe(true);
  f.acknowledge();
  expect(
    checkpointControlPlaneUidMaintenance(
      f.db,
      a.userId,
      a.operationId,
      a.generation,
      "releasing",
    ),
  ).toBe(true);
  expect(
    checkpointControlPlaneUidMaintenance(
      f.db,
      a.userId,
      a.operationId,
      a.generation,
      "idle",
    ),
  ).toBe(true);
  expect(() => f.reserve(a.operationId)).toThrow("closed");
  expect(controlPlaneUidMaintenanceBlocksExecution(f.db, a.userId)).toBe(false);
  expect(controlPlaneUidGeneration(f.db, a.userId)).toBe(1);
});
it("pins root high-water generation and emits a new context only after current-policy release", () => {
  const a = f.reserve(randomUUID(), 8);
  expect(a.generation).toBe(9);
  expect(
    checkpointControlPlaneUidMaintenance(
      f.db,
      a.userId,
      a.operationId,
      a.generation,
      "idle",
    ),
  ).toBe(false);
  expect(
    checkpointControlPlaneUidMaintenance(
      f.db,
      a.userId,
      a.operationId,
      a.generation,
      "blocked",
    ),
  ).toBe(true);
  expect(
    checkpointControlPlaneUidMaintenance(
      f.db,
      a.userId,
      a.operationId,
      a.generation,
      "releasing",
    ),
  ).toBe(false);
  f.acknowledge();
  expect(
    checkpointControlPlaneUidMaintenance(
      f.db,
      a.userId,
      a.operationId,
      a.generation,
      "releasing",
    ),
  ).toBe(true);
  expect(
    checkpointControlPlaneUidMaintenance(
      f.db,
      a.userId,
      a.operationId,
      8,
      "idle",
    ),
  ).toBe(false);
  expect(
    checkpointControlPlaneUidMaintenance(
      f.db,
      a.userId,
      a.operationId,
      a.generation,
      "idle",
    ),
  ).toBe(true);
  expect(
    requireControlPlaneThreadDispatch(f.db, f.alice.thread.id)
      ?.maintenanceGeneration,
  ).toBe(9);
  expect(
    requireControlPlaneJobDispatch(f.db, f.alice.binding.id)
      .maintenanceGeneration,
  ).toBe(9);
});
it("keeps admission closed if authority changes after root release and requires explicit rebase", () => {
  const a = f.reserve();
  checkpointControlPlaneUidMaintenance(
    f.db,
    a.userId,
    a.operationId,
    a.generation,
    "blocked",
  );
  f.acknowledge();
  checkpointControlPlaneUidMaintenance(
    f.db,
    a.userId,
    a.operationId,
    a.generation,
    "releasing",
  );
  f.db
    .update(controlPlaneProjects)
    .set({ slug: "changed" })
    .where(eq(controlPlaneProjects.projectId, f.alice.project.id))
    .run();
  expect(
    checkpointControlPlaneUidMaintenance(
      f.db,
      a.userId,
      a.operationId,
      a.generation,
      "idle",
    ),
  ).toBe(false);
  expect(() => f.reserve(a.operationId, 1)).toThrow("revision changed");
  const b = f.reserve(a.operationId, 1, 1);
  expect(b.generation).toBe(2);
  expect(b.projectRevision).toBeGreaterThan(a.projectRevision);
  expect(
    checkpointControlPlaneUidMaintenance(
      f.db,
      a.userId,
      a.operationId,
      a.generation,
      "idle",
    ),
  ).toBe(false);
  expect(controlPlaneUidMaintenanceBlocksExecution(f.db, a.userId)).toBe(true);
});
it("rejects unsafe generations and rolls back reservations with their enclosing transaction", () => {
  expect(() => f.reserve(randomUUID(), Number.MAX_SAFE_INTEGER)).toThrow();
  expect(() => f.reserve(randomUUID(), -1)).toThrow();
  expect(() => f.reserve("forged")).toThrow();
  expect(() =>
    f.db.transaction(() => {
      f.reserve();
      throw new Error("Rollback");
    }),
  ).toThrow("Rollback");
  expect(getControlPlaneUidMaintenance(f.db, f.alice.user.id)).toBeUndefined();
  const last = f.reserve(randomUUID(), Number.MAX_SAFE_INTEGER - 1);
  expect(last.generation).toBe(Number.MAX_SAFE_INTEGER);
  expect(f.reserve(last.operationId, Number.MAX_SAFE_INTEGER)).toEqual(last);
});
it("upgrades existing users without blocking them and retains saved phases on repeated migration", () => {
  f.db.$client.exec("DROP TABLE control_plane_uid_maintenance");
  const hash = createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../drizzle/0160_control_plane_uid_maintenance.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex");
  expect(
    f.db.$client
      .prepare("DELETE FROM __drizzle_migrations WHERE hash = ?")
      .run(hash).changes,
  ).toBe(1);
  migrate(f.db);
  expect(controlPlaneUidGeneration(f.db, f.alice.user.id)).toBe(0);
  const a = f.reserve(randomUUID(), 4);
  migrate(f.db);
  expect(getControlPlaneUidMaintenance(f.db, a.userId)).toEqual(a);
});

it("retains active operation context but lets an idle generation survive project deletion", () => {
  const project = createControlPlaneProject(f.db, noopNotifier, {
    userId: f.alice.user.id,
    hostId: f.alice.environment.hostId,
    name: "Delete",
    slug: "delete",
  }).project;
  const state = reserveControlPlaneUidMaintenance(f.db, {
    userId: f.alice.user.id,
    projectId: project.id,
    operationId: randomUUID(),
    rootGeneration: 0,
  });
  expect(() =>
    f.db
      .delete(controlPlaneProjects)
      .where(eq(controlPlaneProjects.projectId, project.id))
      .run(),
  ).toThrow();
  expect(getControlPlaneProjectAccessPolicy(f.db, project.id)).not.toBeNull();
  checkpointControlPlaneUidMaintenance(
    f.db,
    state.userId,
    state.operationId,
    state.generation,
    "blocked",
  );
  const policy = getControlPlaneProjectAccessPolicy(f.db, project.id);
  if (!policy) throw new Error("Missing policy");
  acknowledgeControlPlaneProjectAccessPolicy(f.db, project.id, policy.revision);
  checkpointControlPlaneUidMaintenance(
    f.db,
    state.userId,
    state.operationId,
    state.generation,
    "releasing",
  );
  checkpointControlPlaneUidMaintenance(
    f.db,
    state.userId,
    state.operationId,
    state.generation,
    "idle",
  );
  f.db
    .delete(controlPlaneProjects)
    .where(eq(controlPlaneProjects.projectId, project.id))
    .run();
  expect(getControlPlaneUidMaintenance(f.db, state.userId)).toMatchObject({
    projectId: null,
    phase: "idle",
    generation: 1,
  });
  expect(controlPlaneUidGeneration(f.db, state.userId)).toBe(1);
});
