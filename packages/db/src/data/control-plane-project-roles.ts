import { and, eq, ne } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import {
  controlPlaneProjectAccess,
  controlPlaneProjectMaintenance,
  controlPlaneProjectPolicies,
  controlPlaneProjects,
  controlPlaneUsers,
} from "../schema.js";
import {
  releaseControlPlaneProjectMaintenanceClaim,
  reserveControlPlaneProjectMaintenance,
} from "./control-plane-project-maintenance.js";

export function changeControlPlaneProjectRoleAndReserveMaintenance(
  db: DbConnection,
  input: {
    projectId: string;
    userId: string;
    role: "runner" | "viewer" | null;
    expectedRevision: number;
    operationId: string;
    workerId: string;
    workerPid: number;
    participants: readonly {
      userId: string;
      uid: number;
      rootGeneration: number;
    }[];
  },
) {
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  )
    throw new Error("Invalid expected project revision");
  return db.transaction(
    (tx) => {
      const binding = tx
        .select({
          project: controlPlaneProjects,
          policy: controlPlaneProjectPolicies,
        })
        .from(controlPlaneProjects)
        .innerJoin(
          controlPlaneProjectPolicies,
          eq(
            controlPlaneProjectPolicies.projectId,
            controlPlaneProjects.projectId,
          ),
        )
        .where(eq(controlPlaneProjects.projectId, input.projectId))
        .get();
      if (!binding) throw new Error("Project role context unavailable");
      if (binding.policy.revision !== input.expectedRevision)
        throw new Error("Project role revision changed");
      if (binding.project.ownerUserId === input.userId)
        throw new Error("Project owner role is immutable");
      const pending = tx
        .select({ id: controlPlaneProjectMaintenance.id })
        .from(controlPlaneProjectMaintenance)
        .where(
          and(
            eq(controlPlaneProjectMaintenance.projectId, input.projectId),
            ne(controlPlaneProjectMaintenance.phase, "complete"),
          ),
        )
        .get();
      if (pending) throw new Error("Project maintenance is already pending");
      const target = tx
        .select()
        .from(controlPlaneUsers)
        .where(eq(controlPlaneUsers.id, input.userId))
        .get();
      if (!target || !target.enabled || target.environmentStatus !== "ready")
        throw new Error("Project role target unavailable");
      const grants = tx
        .select({ userId: controlPlaneProjectAccess.userId })
        .from(controlPlaneProjectAccess)
        .where(eq(controlPlaneProjectAccess.projectId, input.projectId))
        .all();
      const covered = new Set(input.participants.map((row) => row.userId));
      if (
        !covered.has(binding.project.ownerUserId) ||
        !covered.has(input.userId) ||
        grants.some((row) => !covered.has(row.userId))
      )
        throw new Error("Project role maintenance participant omitted");
      const current = tx
        .select({ role: controlPlaneProjectAccess.role })
        .from(controlPlaneProjectAccess)
        .where(
          and(
            eq(controlPlaneProjectAccess.projectId, input.projectId),
            eq(controlPlaneProjectAccess.userId, input.userId),
          ),
        )
        .get();
      if ((current?.role ?? null) === input.role)
        return { changed: false as const, revision: binding.policy.revision };
      if (input.role === null)
        tx.delete(controlPlaneProjectAccess)
          .where(
            and(
              eq(controlPlaneProjectAccess.projectId, input.projectId),
              eq(controlPlaneProjectAccess.userId, input.userId),
            ),
          )
          .run();
      else
        tx.insert(controlPlaneProjectAccess)
          .values({
            projectId: input.projectId,
            userId: input.userId,
            role: input.role,
          })
          .onConflictDoUpdate({
            target: [
              controlPlaneProjectAccess.projectId,
              controlPlaneProjectAccess.userId,
            ],
            set: { role: input.role },
          })
          .run();
      const policy = tx
        .select({ revision: controlPlaneProjectPolicies.revision })
        .from(controlPlaneProjectPolicies)
        .where(eq(controlPlaneProjectPolicies.projectId, input.projectId))
        .get();
      if (!policy || policy.revision !== input.expectedRevision + 1)
        throw new Error("Project role revision changed unexpectedly");
      const operation = reserveControlPlaneProjectMaintenance(db, {
        id: input.operationId,
        projectId: input.projectId,
        projectRevision: policy.revision,
        workerId: input.workerId,
        workerPid: input.workerPid,
        participants: input.participants,
      });
      if (
        !releaseControlPlaneProjectMaintenanceClaim(
          db,
          operation.id,
          input.workerId,
        )
      )
        throw new Error("Project role maintenance claim changed");
      return {
        changed: true as const,
        revision: policy.revision,
        operationId: operation.id,
      };
    },
    { behavior: "immediate" },
  );
}
