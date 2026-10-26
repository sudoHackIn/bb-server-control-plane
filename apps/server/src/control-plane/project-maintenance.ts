import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  controlPlaneUsers,
  controlPlaneProjectAccess,
  changeControlPlaneProjectRoleAndReserveMaintenance,
  getControlPlaneProjectAccessPolicy,
  getControlPlaneProjectMaintenance,
  reserveControlPlaneProjectMaintenance,
  claimControlPlaneProjectMaintenance,
  checkpointControlPlaneProjectMaintenance,
  releaseControlPlaneProjectMaintenanceClaim,
  getControlPlaneUidMaintenance,
  checkpointControlPlaneUidMaintenance,
  acknowledgeControlPlaneProjectAccessPolicy,
  type DbConnection,
} from "@bb/db";
import {
  controlPlaneUidMaintenance,
  inspectProjectAccess,
  listUidMaintenanceJobs,
  stopUidMaintenanceJob,
  prepareProjectAccess,
} from "./provisioning.js";

type Group = NonNullable<ReturnType<typeof getControlPlaneProjectMaintenance>>;
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}
export function createControlPlaneProjectMaintenanceCoordinator(options: {
  db: DbConnection;
  stopThreads: (userId: string) => Promise<void>;
}) {
  const { db } = options;
  const active = new Map<
    string,
    { signature: string; promise: Promise<Group> }
  >();
  const current = (id: string, attempt: number, workerId: string) => {
    const row = getControlPlaneProjectMaintenance(db, id);
    if (!row || row.attempt !== attempt || row.workerId !== workerId)
      throw new Error("Maintenance worker ownership changed");
    return row;
  };
  const user = (userId: string, uid: number) => {
    const row = db
      .select()
      .from(controlPlaneUsers)
      .where(eq(controlPlaneUsers.id, userId))
      .get();
    if (!row || row.uid !== uid || row.gid !== uid)
      throw new Error("Maintenance user identity changed");
    return row;
  };
  async function execute(input: {
    projectId: string;
    operationId: string;
    expectedAttempt?: number;
  }) {
    const workerId = randomUUID();
    let claimed = false;
    let safeToRelease = true;
    try {
      let group = getControlPlaneProjectMaintenance(db, input.operationId);
      if (group) {
        if (group.projectId !== input.projectId)
          throw new Error("Maintenance project changed");
        if (group.phase === "complete") {
          if (input.expectedAttempt !== undefined)
            throw new Error("Maintenance operation is closed");
          return group;
        }
        if (
          group.workerId !== null &&
          group.workerPid !== null &&
          alive(group.workerPid)
        )
          throw new Error("Previous maintenance worker is still alive");
        group = claimControlPlaneProjectMaintenance(db, {
          id: input.operationId,
          workerId,
          workerPid: process.pid,
          previousWorkerId: group.workerId,
        });
        claimed = true;
      }
      const policy = getControlPlaneProjectAccessPolicy(db, input.projectId);
      if (!policy) throw new Error("Maintenance project unavailable");
      const root = await inspectProjectAccess(
        policy.owner,
        policy.project.projectId,
        policy.project.slug,
      );
      const identities = new Map<string, { userId: string; uid: number }>();
      for (const row of [
        { userId: policy.owner.id, uid: policy.owner.uid },
        ...policy.members.map((row) => ({ userId: row.id, uid: row.uid })),
        ...root.writers,
        ...(group?.participants ?? []),
      ]) {
        const prior = identities.get(row.userId);
        if (prior && prior.uid !== row.uid)
          throw new Error("Maintenance identity changed");
        identities.set(row.userId, { userId: row.userId, uid: row.uid });
      }
      const participants = [];
      for (const row of [...identities.values()].sort((a, b) =>
        a.userId.localeCompare(b.userId),
      )) {
        const identity = user(row.userId, row.uid);
        const state = await controlPlaneUidMaintenance(identity, {
          action: "status",
        });
        participants.push({ ...row, rootGeneration: state.generation });
      }
      if (!group || input.expectedAttempt !== undefined) {
        group = reserveControlPlaneProjectMaintenance(db, {
          id: input.operationId,
          projectId: input.projectId,
          projectRevision: policy.revision,
          workerId,
          workerPid: process.pid,
          participants,
          ...(input.expectedAttempt === undefined
            ? {}
            : { expectedAttempt: input.expectedAttempt }),
        });
        claimed = true;
      } else if (
        group.projectRevision !== policy.revision ||
        participants.some(
          (row) =>
            !group?.participants.some(
              (member) =>
                member.userId === row.userId && member.uid === row.uid,
            ),
        )
      )
        throw new Error("Maintenance policy changed; explicit rebase required");
      const attempt = group.attempt;
      const check = () => {
        const row = current(input.operationId, attempt, workerId);
        const latest = getControlPlaneProjectAccessPolicy(db, input.projectId);
        if (latest?.revision !== row.projectRevision)
          throw new Error("Maintenance policy changed");
        return latest;
      };
      for (const member of group.participants) {
        const state = getControlPlaneUidMaintenance(db, member.userId);
        if (
          state?.operationId !== group.id ||
          state.generation !== member.generation ||
          state.projectRevision !== group.projectRevision
        )
          throw new Error("Maintenance participant changed");
      }
      if (group.phase === "preparing") {
        for (const member of group.participants) {
          check();
          await controlPlaneUidMaintenance(user(member.userId, member.uid), {
            action: "begin",
            generation: member.generation,
          });
          if (
            !checkpointControlPlaneUidMaintenance(
              db,
              member.userId,
              group.id,
              member.generation,
              "blocked",
            )
          )
            throw new Error("Maintenance activation changed");
        }
        group = checkpointControlPlaneProjectMaintenance(
          db,
          group.id,
          attempt,
          workerId,
          "draining",
        );
      }
      if (group.phase === "draining") {
        for (const member of group.participants) {
          check();
          safeToRelease = false;
          await options.stopThreads(member.userId);
          safeToRelease = true;
          check();
          const identity = user(member.userId, member.uid);
          for (const jobId of await listUidMaintenanceJobs(
            identity,
            member.generation,
          )) {
            check();
            safeToRelease = false;
            await stopUidMaintenanceJob(identity, jobId);
            safeToRelease = true;
          }
          if (
            (await listUidMaintenanceJobs(identity, member.generation)).length
          )
            throw new Error("UID job cleanup remains pending");
        }
        group = checkpointControlPlaneProjectMaintenance(
          db,
          group.id,
          attempt,
          workerId,
          "applying",
        );
        safeToRelease = true;
      }
      if (group.phase === "applying") {
        const latest = check();
        await prepareProjectAccess({
          owner: latest.owner,
          projectId: latest.project.projectId,
          slug: latest.project.slug,
          revision: latest.revision,
          members: latest.members,
        });
        check();
        if (
          !acknowledgeControlPlaneProjectAccessPolicy(
            db,
            input.projectId,
            group.projectRevision,
          )
        )
          throw new Error("Maintenance policy acknowledgement changed");
        group = checkpointControlPlaneProjectMaintenance(
          db,
          group.id,
          attempt,
          workerId,
          "releasing",
        );
      }
      if (group.phase !== "releasing")
        throw new Error("Unexpected project maintenance phase");
      for (const member of group.participants) {
        check();
        await controlPlaneUidMaintenance(user(member.userId, member.uid), {
          action: "finish",
          generation: member.generation,
        });
      }
      check();
      return checkpointControlPlaneProjectMaintenance(
        db,
        group.id,
        attempt,
        workerId,
        "complete",
      );
    } finally {
      if (claimed && safeToRelease)
        releaseControlPlaneProjectMaintenanceClaim(
          db,
          input.operationId,
          workerId,
        );
    }
  }
  const reconcile = (input: {
    projectId: string;
    operationId: string;
    expectedAttempt?: number;
  }) => {
    const key = input.operationId;
    const signature = JSON.stringify([
      input.projectId,
      input.expectedAttempt ?? null,
    ]);
    const pending = active.get(key);
    if (pending) {
      if (pending.signature !== signature)
        return Promise.reject(
          new Error(
            "Maintenance request is already running with different parameters",
          ),
        );
      return pending.promise;
    }
    const result = execute(input).then(() => {
      const latest = getControlPlaneProjectMaintenance(db, input.operationId);
      if (!latest) throw new Error("Maintenance operation disappeared");
      return latest;
    });
    active.set(key, { signature, promise: result });
    void result
      .finally(() => {
        if (active.get(key)?.promise === result) active.delete(key);
      })
      .catch(() => {});
    return result;
  };
  return {
    status(operationId: string) {
      return getControlPlaneProjectMaintenance(db, operationId);
    },
    reconcile,
    async changeRole(input: {
      projectId: string;
      userId: string;
      role: "runner" | "viewer" | null;
      expectedRevision: number;
      operationId: string;
    }) {
      const policy = getControlPlaneProjectAccessPolicy(db, input.projectId);
      if (!policy || policy.revision !== input.expectedRevision)
        throw new Error("Project role revision changed");
      const root = await inspectProjectAccess(
        policy.owner,
        policy.project.projectId,
        policy.project.slug,
      );
      const identities = new Map<string, { userId: string; uid: number }>();
      const grants = db
        .select({ userId: controlPlaneProjectAccess.userId })
        .from(controlPlaneProjectAccess)
        .where(eq(controlPlaneProjectAccess.projectId, input.projectId))
        .all();
      for (const row of [
        policy.owner.id,
        input.userId,
        ...grants.map((grant) => grant.userId),
        ...root.writers.map((writer) => writer.userId),
      ]) {
        const identity = db
          .select()
          .from(controlPlaneUsers)
          .where(eq(controlPlaneUsers.id, row))
          .get();
        if (!identity || identity.gid !== identity.uid)
          throw new Error("Project role participant identity changed");
        const prior = identities.get(identity.id);
        const writer = root.writers.find((item) => item.userId === identity.id);
        if (
          (prior && prior.uid !== identity.uid) ||
          (writer && writer.uid !== identity.uid)
        )
          throw new Error("Project role participant identity changed");
        identities.set(identity.id, { userId: identity.id, uid: identity.uid });
      }
      const participants = [];
      for (const member of [...identities.values()].sort((a, b) =>
        a.userId.localeCompare(b.userId),
      )) {
        const identity = user(member.userId, member.uid);
        const state = await controlPlaneUidMaintenance(identity, {
          action: "status",
        });
        participants.push({ ...member, rootGeneration: state.generation });
      }
      const changed = changeControlPlaneProjectRoleAndReserveMaintenance(db, {
        ...input,
        workerId: randomUUID(),
        workerPid: process.pid,
        participants,
      });
      if (!changed.changed) return changed;
      const operation = await reconcile({
        projectId: input.projectId,
        operationId: input.operationId,
      });
      return { ...changed, operation };
    },
  };
}
