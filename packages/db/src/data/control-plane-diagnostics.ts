import { and, asc, eq, gt } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import { controlPlaneDiagnosticAccess, controlPlaneUsers } from "../schema.js";

export function getControlPlaneDiagnosticGrant(
  db: DbQueryConnection,
  projectId: string,
  userId: string,
) {
  return (
    db
      .select()
      .from(controlPlaneDiagnosticAccess)
      .where(
        and(
          eq(controlPlaneDiagnosticAccess.projectId, projectId),
          eq(controlPlaneDiagnosticAccess.userId, userId),
        ),
      )
      .get() ?? null
  );
}
export function listControlPlaneDiagnosticGrants(
  db: DbQueryConnection,
  projectId: string,
  after: string | null,
  limit: number,
) {
  return db
    .select({
      projectId: controlPlaneDiagnosticAccess.projectId,
      userId: controlPlaneDiagnosticAccess.userId,
      login: controlPlaneUsers.login,
      role: controlPlaneDiagnosticAccess.role,
      revision: controlPlaneDiagnosticAccess.revision,
      updatedAt: controlPlaneDiagnosticAccess.updatedAt,
      updatedBy: controlPlaneDiagnosticAccess.updatedBy,
    })
    .from(controlPlaneDiagnosticAccess)
    .innerJoin(
      controlPlaneUsers,
      eq(controlPlaneUsers.id, controlPlaneDiagnosticAccess.userId),
    )
    .where(
      and(
        eq(controlPlaneDiagnosticAccess.projectId, projectId),
        after === null
          ? undefined
          : gt(controlPlaneDiagnosticAccess.userId, after),
      ),
    )
    .orderBy(asc(controlPlaneDiagnosticAccess.userId))
    .limit(limit)
    .all();
}
export function setControlPlaneDiagnosticGrant(
  db: DbConnection,
  input: {
    projectId: string;
    userId: string;
    role: "developer" | "reviewer" | null;
    expectedRevision: number;
    updatedBy: string;
  },
) {
  return db.transaction(
    (tx) => {
      const previous = getControlPlaneDiagnosticGrant(
        tx,
        input.projectId,
        input.userId,
      );
      if ((previous?.revision ?? 0) !== input.expectedRevision) return false;
      const row = {
        projectId: input.projectId,
        userId: input.userId,
        role: input.role,
        revision: input.expectedRevision + 1,
        updatedAt: Date.now(),
        updatedBy: input.updatedBy,
      };
      if (previous)
        tx.update(controlPlaneDiagnosticAccess)
          .set(row)
          .where(
            and(
              eq(controlPlaneDiagnosticAccess.projectId, input.projectId),
              eq(controlPlaneDiagnosticAccess.userId, input.userId),
            ),
          )
          .run();
      else tx.insert(controlPlaneDiagnosticAccess).values(row).run();
      return true;
    },
    { behavior: "immediate" },
  );
}
