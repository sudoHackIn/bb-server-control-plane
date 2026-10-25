import { eq } from "drizzle-orm";
import type { DbQueryConnection } from "../connection.js";
import {
  controlPlaneProjects,
  controlPlaneThreads,
  threads,
} from "../schema.js";
import { getControlPlaneProject } from "./control-plane-projects.js";
import { ControlPlaneThreadError } from "./control-plane-threads.js";

function scope(db: DbQueryConnection, threadId: string) {
  return db
    .select({
      id: threads.id,
      projectId: threads.projectId,
      providerId: threads.providerId,
      archivedAt: threads.archivedAt,
      deletedAt: threads.deletedAt,
      ownerUserId: controlPlaneThreads.ownerUserId,
      managedProjectId: controlPlaneProjects.projectId,
    })
    .from(threads)
    .leftJoin(controlPlaneThreads, eq(controlPlaneThreads.threadId, threads.id))
    .leftJoin(
      controlPlaneProjects,
      eq(controlPlaneProjects.projectId, threads.projectId),
    )
    .where(eq(threads.id, threadId))
    .get();
}
function managed(row: ReturnType<typeof scope>): boolean {
  return (
    row !== undefined &&
    (row.ownerUserId !== null ||
      row.managedProjectId !== null ||
      row.providerId === "qwen-server")
  );
}
export function isControlPlaneThreadManaged(
  db: DbQueryConnection,
  threadId: string,
): boolean {
  return managed(scope(db, threadId));
}
export function requireControlPlaneThreadRelation(
  db: DbQueryConnection,
  threadId: string,
  relatedThreadId: string,
  allowArchived: boolean,
): void {
  const target = scope(db, threadId);
  const source = scope(db, relatedThreadId);
  if (!managed(target) && !managed(source)) return;
  if (
    !target?.ownerUserId ||
    !source?.ownerUserId ||
    target.ownerUserId !== source.ownerUserId ||
    source.deletedAt !== null ||
    (!allowArchived && source.archivedAt !== null) ||
    !getControlPlaneProject(db, target.ownerUserId, target.projectId) ||
    !getControlPlaneProject(db, target.ownerUserId, source.projectId)
  )
    throw new ControlPlaneThreadError();
}
