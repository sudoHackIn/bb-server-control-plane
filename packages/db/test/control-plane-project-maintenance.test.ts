import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  ControlPlaneRegistry,
  createControlPlaneProject,
  upsertHost,
  noopNotifier,
  reserveControlPlaneProjectMaintenance,
  getControlPlaneProjectMaintenance,
  checkpointControlPlaneProjectMaintenance,
  claimControlPlaneProjectMaintenance,
  releaseControlPlaneProjectMaintenanceClaim,
  getControlPlaneUidMaintenance,
  checkpointControlPlaneUidMaintenance,
  getControlPlaneProjectAccessPolicy,
  acknowledgeControlPlaneProjectAccessPolicy,
  controlPlaneProjectAccess,
  controlPlaneProjects,
  controlPlaneProjectMaintenance,
  listPendingControlPlaneProjectMaintenance,
} from "../src/index.js";
import { createMigratedConnection } from "../src/testing.js";
function fixture() {
  const db = createMigratedConnection();
  const registry = new ControlPlaneRegistry(db, {
    usersRoot: "/srv/users",
    firstUid: 200000,
    lastUid: 299999,
  });
  const users = ["alice", "bob", "charlie"].map((login) => {
    const u = registry.reserve(login, 1);
    registry.environmentState(u.id, "ready");
    return u;
  });
  const alice = users[0],
    bob = users[1],
    charlie = users[2];
  if (!alice || !bob || !charlie) throw new Error("Missing actors");
  const host = upsertHost(db, noopNotifier, { name: "Group" });
  const project = createControlPlaneProject(db, noopNotifier, {
    userId: alice.id,
    hostId: host.id,
    name: "App",
    slug: "app",
  }).project;
  const id = randomUUID(),
    workerId = randomUUID();
  const revision = () => {
    const p = getControlPlaneProjectAccessPolicy(db, project.id);
    if (!p) throw new Error("Missing policy");
    return p.revision;
  };
  const reserve = (expectedAttempt?: number, participants = [alice, bob]) =>
    reserveControlPlaneProjectMaintenance(db, {
      id,
      projectId: project.id,
      projectRevision: revision(),
      workerId,
      workerPid: process.pid,
      ...(expectedAttempt === undefined ? {} : { expectedAttempt }),
      participants: participants.map((u) => ({
        userId: u.id,
        uid: u.uid,
        rootGeneration:
          getControlPlaneUidMaintenance(db, u.id)?.generation ?? 0,
      })),
    });
  const block = () => {
    const group = getControlPlaneProjectMaintenance(db, id);
    if (!group) throw new Error("Missing group");
    for (const p of group.participants)
      expect(
        checkpointControlPlaneUidMaintenance(
          db,
          p.userId,
          id,
          p.generation,
          "blocked",
        ),
      ).toBe(true);
    return group;
  };
  const advance = (
    phase: "draining" | "applying" | "releasing" | "complete",
    attempt = 1,
  ) =>
    checkpointControlPlaneProjectMaintenance(db, id, attempt, workerId, phase);
  const acknowledge = () =>
    acknowledgeControlPlaneProjectAccessPolicy(db, project.id, revision());
  return {
    db,
    alice,
    bob,
    charlie,
    project,
    id,
    workerId,
    reserve,
    block,
    advance,
    acknowledge,
    revision,
  };
}
let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
afterEach(() => f.db.$client.close());
it("reserves the whole cohort and releases all UID admissions only with group completion", () => {
  const group = f.reserve();
  expect(group.participants).toHaveLength(2);
  for (const u of [f.alice, f.bob])
    expect(getControlPlaneUidMaintenance(f.db, u.id)?.phase).toBe("blocking");
  f.block();
  f.advance("draining");
  f.advance("applying");
  expect(() => f.advance("releasing")).toThrow("not acknowledged");
  f.acknowledge();
  f.advance("releasing");
  for (const u of [f.alice, f.bob])
    expect(getControlPlaneUidMaintenance(f.db, u.id)?.phase).toBe("releasing");
  expect(f.advance("complete").phase).toBe("complete");
  for (const u of [f.alice, f.bob])
    expect(getControlPlaneUidMaintenance(f.db, u.id)?.phase).toBe("idle");
});
it("rolls back earlier participant reservations when a later UID belongs to another operation", () => {
  f.reserve();
  const other = randomUUID();
  expect(() =>
    reserveControlPlaneProjectMaintenance(f.db, {
      id: other,
      projectId: f.project.id,
      projectRevision: f.revision(),
      workerId: randomUUID(),
      workerPid: process.pid,
      participants: [f.charlie, f.bob].map((u) => ({
        userId: u.id,
        uid: u.uid,
        rootGeneration: 0,
      })),
    }),
  ).toThrow("busy");
  expect(getControlPlaneUidMaintenance(f.db, f.charlie.id)).toBeUndefined();
  expect(getControlPlaneProjectMaintenance(f.db, other)).toBeUndefined();
  expect(getControlPlaneUidMaintenance(f.db, f.bob.id)?.operationId).toBe(f.id);
});
it("retains prior participants through explicit rebase and rejects old attempt completion", () => {
  f.reserve();
  f.block();
  f.advance("draining");
  f.advance("applying");
  f.db
    .insert(controlPlaneProjectAccess)
    .values({ projectId: f.project.id, userId: f.charlie.id, role: "viewer" })
    .run();
  expect(() => f.reserve(1, [f.alice])).toThrow("omitted");
  expect(getControlPlaneUidMaintenance(f.db, f.alice.id)?.generation).toBe(1);
  const next = f.reserve(1, [f.alice, f.bob, f.charlie]);
  expect(next.attempt).toBe(2);
  expect(next.participants).toHaveLength(3);
  expect(next.participants.find((p) => p.userId === f.bob.id)?.generation).toBe(
    2,
  );
  expect(() => f.advance("releasing", 1)).toThrow("changed");
  f.block();
  f.advance("draining", 2);
  f.advance("applying", 2);
  f.acknowledge();
  f.advance("releasing", 2);
  f.advance("complete", 2);
});
it("retains every releasing UID when current policy changes before the final DB commit", () => {
  f.reserve();
  f.block();
  f.advance("draining");
  f.advance("applying");
  f.acknowledge();
  f.advance("releasing");
  f.db
    .insert(controlPlaneProjectAccess)
    .values({ projectId: f.project.id, userId: f.charlie.id, role: "viewer" })
    .run();
  expect(() => f.advance("complete")).toThrow("policy changed");
  for (const u of [f.alice, f.bob])
    expect(getControlPlaneUidMaintenance(f.db, u.id)?.phase).toBe("releasing");
  expect(getControlPlaneProjectMaintenance(f.db, f.id)?.phase).toBe(
    "releasing",
  );
});
it("uses worker compare-and-set and preserves the claim until its exact owner releases", () => {
  f.reserve();
  expect(() =>
    claimControlPlaneProjectMaintenance(f.db, {
      id: f.id,
      workerId: randomUUID(),
      workerPid: process.pid,
      previousWorkerId: null,
    }),
  ).toThrow("changed");
  expect(releaseControlPlaneProjectMaintenanceClaim(f.db, f.id, "wrong")).toBe(
    false,
  );
  expect(
    releaseControlPlaneProjectMaintenanceClaim(f.db, f.id, f.workerId),
  ).toBe(true);
  const owner = randomUUID();
  expect(
    claimControlPlaneProjectMaintenance(f.db, {
      id: f.id,
      workerId: owner,
      workerPid: process.pid,
      previousWorkerId: null,
    }).workerId,
  ).toBe(owner);
  expect(
    releaseControlPlaneProjectMaintenanceClaim(f.db, f.id, f.workerId),
  ).toBe(false);
  expect(
    listPendingControlPlaneProjectMaintenance(f.db).map((g) => g.id),
  ).toEqual([f.id]);
});
it("prevents deleting active context and preserves completed metadata after project removal", () => {
  f.reserve();
  expect(() =>
    f.db
      .delete(controlPlaneProjects)
      .where(eq(controlPlaneProjects.projectId, f.project.id))
      .run(),
  ).toThrow();
  f.block();
  f.advance("draining");
  f.advance("applying");
  f.acknowledge();
  f.advance("releasing");
  f.advance("complete");
  f.db
    .delete(controlPlaneProjects)
    .where(eq(controlPlaneProjects.projectId, f.project.id))
    .run();
  expect(getControlPlaneProjectMaintenance(f.db, f.id)).toMatchObject({
    projectId: null,
    phase: "complete",
  });
  expect(getControlPlaneUidMaintenance(f.db, f.bob.id)).toMatchObject({
    generation: 1,
    phase: "idle",
    projectId: null,
  });
  expect(listPendingControlPlaneProjectMaintenance(f.db)).toEqual([]);
});
it("rejects malformed worker pairs and identity substitutions without reserving any UID", () => {
  expect(() =>
    reserveControlPlaneProjectMaintenance(f.db, {
      id: f.id,
      projectId: f.project.id,
      projectRevision: f.revision(),
      workerId: f.workerId,
      workerPid: process.pid,
      participants: [{ userId: f.alice.id, uid: f.bob.uid, rootGeneration: 0 }],
    }),
  ).toThrow("identity changed");
  expect(getControlPlaneUidMaintenance(f.db, f.alice.id)).toBeUndefined();
  f.reserve();
  expect(() =>
    f.db
      .update(controlPlaneProjectMaintenance)
      .set({ workerPid: null })
      .where(eq(controlPlaneProjectMaintenance.id, f.id))
      .run(),
  ).toThrow();
});
