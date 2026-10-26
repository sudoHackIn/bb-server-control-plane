import { spawn } from "node:child_process";
import { once } from "node:events";
import { withTestHarness } from "../helpers/test-app.js";
import { runControlPlaneProjectMaintenanceSweep } from "../../src/control-plane/native-project-maintenance.js";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createMigratedConnection } from "@bb/db/testing";
import {
  getControlPlaneProjectAccessPolicy,
  getControlPlaneProjectMaintenance,
  reserveControlPlaneProjectMaintenance,
} from "@bb/db";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { createControlPlaneProjectMaintenanceCoordinator } from "../../src/control-plane/project-maintenance.js";
import { createControlPlaneUidMaintenanceCoordinator } from "../../src/control-plane/uid-maintenance.js";

it("refuses to steal a live worker and preserves its group and participant intent", async () => {
  const db = createMigratedConnection();
  try {
    const { alice } = seedControlPlaneJobSubjects(db);
    const policy = getControlPlaneProjectAccessPolicy(db, alice.project.id);
    if (!policy) throw new Error("Missing policy");
    const group = reserveControlPlaneProjectMaintenance(db, {
      id: randomUUID(),
      projectId: alice.project.id,
      projectRevision: policy.revision,
      workerId: randomUUID(),
      workerPid: process.pid,
      participants: [
        { userId: alice.user.id, uid: alice.user.uid, rootGeneration: 0 },
      ],
    });
    let stopped = false;
    const coordinator = createControlPlaneProjectMaintenanceCoordinator({
      db,
      async stopThreads() {
        stopped = true;
      },
    });
    await expect(
      coordinator.reconcile({
        operationId: group.id,
        projectId: alice.project.id,
      }),
    ).rejects.toThrow("still alive");
    expect(getControlPlaneProjectMaintenance(db, group.id)).toEqual(group);
    expect(stopped).toBe(false);
    const uid = createControlPlaneUidMaintenanceCoordinator(db);
    await expect(
      uid.begin({
        userId: alice.user.id,
        operationId: group.id,
        projectId: alice.project.id,
      }),
    ).rejects.toThrow("Grouped maintenance");
    await expect(
      uid.finish({
        userId: alice.user.id,
        operationId: group.id,
        generation: 1,
      }),
    ).rejects.toThrow("Grouped maintenance");
    expect(getControlPlaneProjectMaintenance(db, group.id)).toEqual(group);
  } finally {
    db.$client.close();
  }
});

it("deduplicates identical operation arguments independently of property order and rejects changed parameters", async () => {
  const db = createMigratedConnection();
  try {
    const coordinator = createControlPlaneProjectMaintenanceCoordinator({
      db,
      async stopThreads() {
        throw new Error("Unexpected stop");
      },
    });
    const operationId = randomUUID();
    const first = coordinator.reconcile({ operationId, projectId: "missing" });
    const same = coordinator.reconcile({ projectId: "missing", operationId });
    expect(same).toBe(first);
    const changedProject = coordinator.reconcile({
      operationId,
      projectId: "other",
    });
    const changedAttempt = coordinator.reconcile({
      operationId,
      projectId: "missing",
      expectedAttempt: 1,
    });
    await expect(changedProject).rejects.toThrow("different parameters");
    await expect(changedAttempt).rejects.toThrow("different parameters");
    await expect(first).rejects.toThrow("unavailable");
    await expect(same).rejects.toThrow("unavailable");
  } finally {
    db.$client.close();
  }
});

it("defers saved maintenance recovery until its native daemon is available", async () => {
  const child = spawn(process.execPath, ["-e", ""]);
  await once(child, "exit");
  const workerPid = child.pid;
  if (workerPid === undefined) throw new Error("Missing completed worker PID");
  await withTestHarness(async (h) => {
    const { alice } = seedControlPlaneJobSubjects(h.db);
    const policy = getControlPlaneProjectAccessPolicy(h.db, alice.project.id);
    if (!policy) throw new Error("Missing policy");
    const saved = reserveControlPlaneProjectMaintenance(h.db, {
      id: randomUUID(),
      projectId: alice.project.id,
      projectRevision: policy.revision,
      workerId: randomUUID(),
      workerPid,
      participants: [
        { userId: alice.user.id, uid: alice.user.uid, rootGeneration: 0 },
      ],
    });
    expect(h.hub.hasDaemonForHost(alice.environment.hostId)).toBe(false);
    await runControlPlaneProjectMaintenanceSweep(h.deps);
    expect(getControlPlaneProjectMaintenance(h.db, saved.id)).toEqual(saved);
  });
});
