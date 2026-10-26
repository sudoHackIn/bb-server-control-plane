import { and, asc, eq, ne } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import {
  controlPlaneProjectMaintenance,
  controlPlaneProjectPolicies,
  controlPlaneUsers,
  controlPlaneUidMaintenance,
} from "../schema.js";
import {
  getControlPlaneUidMaintenance,
  reserveControlPlaneUidMaintenance,
} from "./control-plane-uid-maintenance.js";

export function getControlPlaneProjectMaintenance(
  db: DbConnection,
  id: string,
) {
  return db
    .select()
    .from(controlPlaneProjectMaintenance)
    .where(eq(controlPlaneProjectMaintenance.id, id))
    .get();
}
export function listPendingControlPlaneProjectMaintenance(
  db: DbConnection,
  limit = 100,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("Invalid maintenance page size");
  return db
    .select()
    .from(controlPlaneProjectMaintenance)
    .where(ne(controlPlaneProjectMaintenance.phase, "complete"))
    .orderBy(
      asc(controlPlaneProjectMaintenance.updatedAt),
      asc(controlPlaneProjectMaintenance.id),
    )
    .limit(limit)
    .all();
}
export function claimControlPlaneProjectMaintenance(
  db: DbConnection,
  input: {
    id: string;
    workerId: string;
    workerPid: number;
    previousWorkerId: string | null;
  },
) {
  return db.transaction(
    (tx) => {
      const row = tx
        .select()
        .from(controlPlaneProjectMaintenance)
        .where(eq(controlPlaneProjectMaintenance.id, input.id))
        .get();
      if (
        !row ||
        row.phase === "complete" ||
        row.workerId !== input.previousWorkerId
      )
        throw new Error("Maintenance claim changed");
      return tx
        .update(controlPlaneProjectMaintenance)
        .set({
          workerId: input.workerId,
          workerPid: input.workerPid,
          updatedAt: Date.now(),
        })
        .where(eq(controlPlaneProjectMaintenance.id, input.id))
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );
}
export function reserveControlPlaneProjectMaintenance(
  db: DbConnection,
  input: {
    id: string;
    projectId: string;
    projectRevision: number;
    workerId: string;
    workerPid: number;
    expectedAttempt?: number;
    participants: readonly {
      userId: string;
      uid: number;
      rootGeneration: number;
    }[];
  },
) {
  if (
    !input.participants.length ||
    input.participants.length > 1024 ||
    new Set(input.participants.map((row) => row.userId)).size !==
      input.participants.length ||
    new Set(input.participants.map((row) => row.uid)).size !==
      input.participants.length
  )
    throw new Error("Invalid maintenance participants");
  return db.transaction(
    () => {
      const policy = db
        .select()
        .from(controlPlaneProjectPolicies)
        .where(eq(controlPlaneProjectPolicies.projectId, input.projectId))
        .get();
      if (policy?.revision !== input.projectRevision)
        throw new Error("Maintenance policy changed");
      const old = getControlPlaneProjectMaintenance(db, input.id);
      if (old) {
        if (
          old.phase === "complete" ||
          old.projectId !== input.projectId ||
          old.workerId !== input.workerId ||
          old.attempt !== input.expectedAttempt
        )
          throw new Error("Maintenance ownership changed");
        if (
          old.participants.some(
            (member) =>
              !input.participants.some(
                (row) => row.userId === member.userId && row.uid === member.uid,
              ),
          )
        )
          throw new Error("Previous maintenance participant omitted");
      } else if (input.expectedAttempt !== undefined)
        throw new Error("Missing maintenance attempt");
      const attempt = (old?.attempt ?? 0) + 1;
      if (!Number.isSafeInteger(attempt))
        throw new Error("Maintenance attempt exhausted");
      const participants = input.participants
        .map((member) => {
          const user = db
            .select()
            .from(controlPlaneUsers)
            .where(eq(controlPlaneUsers.id, member.userId))
            .get();
          if (user?.uid !== member.uid || user.gid !== member.uid)
            throw new Error("Maintenance identity changed");
          const previous = old?.participants.find(
            (row) => row.userId === member.userId,
          );
          if (previous) {
            const current = getControlPlaneUidMaintenance(db, member.userId);
            if (
              current?.operationId !== input.id ||
              current.generation !== previous.generation ||
              current.phase === "idle"
            )
              throw new Error("Maintenance participant ownership changed");
          }
          const row = reserveControlPlaneUidMaintenance(db, {
            userId: member.userId,
            projectId: input.projectId,
            operationId: input.id,
            rootGeneration: member.rootGeneration,
            ...(previous ? { restartGeneration: previous.generation } : {}),
          });
          return {
            userId: member.userId,
            uid: member.uid,
            generation: row.generation,
          };
        })
        .sort((a, b) => a.userId.localeCompare(b.userId));
      const value = {
        projectId: input.projectId,
        projectRevision: input.projectRevision,
        attempt,
        phase: "preparing" as const,
        participants,
        workerId: input.workerId,
        workerPid: input.workerPid,
        updatedAt: Date.now(),
      };
      return db
        .insert(controlPlaneProjectMaintenance)
        .values({ id: input.id, ...value })
        .onConflictDoUpdate({
          target: controlPlaneProjectMaintenance.id,
          set: value,
        })
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );
}
export function checkpointControlPlaneProjectMaintenance(
  db: DbConnection,
  id: string,
  attempt: number,
  workerId: string,
  phase: "draining" | "applying" | "releasing" | "complete",
) {
  return db.transaction(
    (tx) => {
      const row = tx
        .select()
        .from(controlPlaneProjectMaintenance)
        .where(eq(controlPlaneProjectMaintenance.id, id))
        .get();
      if (
        !row ||
        row.attempt !== attempt ||
        row.workerId !== workerId ||
        row.projectId === null
      )
        throw new Error("Maintenance attempt changed");
      const policy = tx
        .select()
        .from(controlPlaneProjectPolicies)
        .where(eq(controlPlaneProjectPolicies.projectId, row.projectId))
        .get();
      if (policy?.revision !== row.projectRevision)
        throw new Error("Maintenance policy changed");
      const prior =
        phase === "draining"
          ? "preparing"
          : phase === "applying"
            ? "draining"
            : phase === "releasing"
              ? "applying"
              : "releasing";
      if (row.phase !== prior) throw new Error("Unexpected maintenance phase");
      if (
        (phase === "releasing" || phase === "complete") &&
        policy.appliedRevision !== row.projectRevision
      )
        throw new Error("Maintenance policy is not acknowledged");
      for (const member of row.participants) {
        const current = tx
          .select()
          .from(controlPlaneUidMaintenance)
          .where(eq(controlPlaneUidMaintenance.userId, member.userId))
          .get();
        if (
          current?.operationId !== id ||
          current.generation !== member.generation ||
          current.projectRevision !== row.projectRevision ||
          current.projectId !== row.projectId ||
          current.phase !== (phase === "complete" ? "releasing" : "blocked")
        )
          throw new Error("Maintenance participant changed");
        if (phase === "releasing" || phase === "complete")
          tx.update(controlPlaneUidMaintenance)
            .set({
              phase: phase === "complete" ? "idle" : "releasing",
              updatedAt: Date.now(),
            })
            .where(eq(controlPlaneUidMaintenance.userId, member.userId))
            .run();
      }
      return tx
        .update(controlPlaneProjectMaintenance)
        .set({ phase, updatedAt: Date.now() })
        .where(eq(controlPlaneProjectMaintenance.id, id))
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );
}
export function releaseControlPlaneProjectMaintenanceClaim(
  db: DbConnection,
  id: string,
  workerId: string,
) {
  return (
    db
      .update(controlPlaneProjectMaintenance)
      .set({ workerId: null, workerPid: null, updatedAt: Date.now() })
      .where(
        and(
          eq(controlPlaneProjectMaintenance.id, id),
          eq(controlPlaneProjectMaintenance.workerId, workerId),
        ),
      )
      .run().changes === 1
  );
}
