import { and, eq } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import {
  controlPlaneUidMaintenance,
  controlPlaneUsers,
  controlPlaneProjectPolicies,
} from "../schema.js";

export function getControlPlaneUidMaintenance(
  db: DbQueryConnection,
  userId: string,
) {
  return db
    .select()
    .from(controlPlaneUidMaintenance)
    .where(eq(controlPlaneUidMaintenance.userId, userId))
    .get();
}
export function controlPlaneUidMaintenanceBlocksExecution(
  db: DbQueryConnection,
  userId: string,
) {
  const state = getControlPlaneUidMaintenance(db, userId);
  return state !== undefined && state.phase !== "idle";
}
export function controlPlaneUidGeneration(
  db: DbQueryConnection,
  userId: string,
) {
  return getControlPlaneUidMaintenance(db, userId)?.generation ?? 0;
}
export function reserveControlPlaneUidMaintenance(
  db: DbConnection,
  input: {
    userId: string;
    projectId: string;
    operationId: string;
    rootGeneration: number;
    restartGeneration?: number;
  },
) {
  if (
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(input.operationId) ||
    !Number.isSafeInteger(input.rootGeneration) ||
    input.rootGeneration < 0 ||
    input.rootGeneration > Number.MAX_SAFE_INTEGER
  )
    throw new Error("Invalid maintenance request");
  return db.transaction(
    (tx) => {
      if (
        !tx
          .select({ id: controlPlaneUsers.id })
          .from(controlPlaneUsers)
          .where(eq(controlPlaneUsers.id, input.userId))
          .get()
      )
        throw new Error("Unknown maintenance user");
      const policy = tx
        .select()
        .from(controlPlaneProjectPolicies)
        .where(eq(controlPlaneProjectPolicies.projectId, input.projectId))
        .get();
      if (!policy) throw new Error("Unknown maintenance project");
      const old = getControlPlaneUidMaintenance(tx, input.userId);
      if (old?.phase !== "idle" && old !== undefined) {
        if (
          old.operationId !== input.operationId ||
          old.projectId !== input.projectId
        )
          throw new Error("UID maintenance is busy");
        if (input.restartGeneration === undefined) {
          if (
            old.projectRevision !== policy.revision ||
            input.rootGeneration > old.generation
          )
            throw new Error("Maintenance revision changed");
          return old;
        }
        if (old.generation !== input.restartGeneration)
          throw new Error("Stale maintenance restart");
      } else {
        if (
          input.restartGeneration !== undefined ||
          old?.operationId === input.operationId
        )
          throw new Error("Maintenance operation is closed");
      }
      const generation =
        Math.max(old?.generation ?? 0, input.rootGeneration) + 1;
      if (!Number.isSafeInteger(generation))
        throw new Error("Maintenance generation exhausted");
      return tx
        .insert(controlPlaneUidMaintenance)
        .values({
          userId: input.userId,
          generation,
          operationId: input.operationId,
          projectId: input.projectId,
          projectRevision: policy.revision,
          phase: "blocking",
          updatedAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: controlPlaneUidMaintenance.userId,
          set: {
            generation,
            operationId: input.operationId,
            projectId: input.projectId,
            projectRevision: policy.revision,
            phase: "blocking",
            updatedAt: Date.now(),
          },
        })
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );
}
export function checkpointControlPlaneUidMaintenance(
  db: DbConnection,
  userId: string,
  operationId: string,
  generation: number,
  phase: "blocked" | "releasing" | "idle",
) {
  return db.transaction(
    (tx) => {
      const row = getControlPlaneUidMaintenance(tx, userId);
      if (
        !row ||
        row.operationId !== operationId ||
        row.generation !== generation
      )
        return false;
      if (row.phase === phase && phase !== "releasing") return true;
      if (
        phase === "blocked"
          ? row.phase !== "blocking"
          : phase === "releasing"
            ? row.phase !== "blocked" && row.phase !== "releasing"
            : row.phase !== "releasing"
      )
        return false;
      if (phase !== "blocked") {
        if (row.projectId === null) return false;
        const policy = tx
          .select()
          .from(controlPlaneProjectPolicies)
          .where(eq(controlPlaneProjectPolicies.projectId, row.projectId))
          .get();
        if (
          !policy ||
          policy.revision !== row.projectRevision ||
          policy.appliedRevision !== row.projectRevision
        )
          return false;
      }
      return (
        tx
          .update(controlPlaneUidMaintenance)
          .set({ phase, updatedAt: Date.now() })
          .where(
            and(
              eq(controlPlaneUidMaintenance.userId, userId),
              eq(controlPlaneUidMaintenance.operationId, operationId),
              eq(controlPlaneUidMaintenance.generation, generation),
            ),
          )
          .run().changes === 1
      );
    },
    { behavior: "immediate" },
  );
}
