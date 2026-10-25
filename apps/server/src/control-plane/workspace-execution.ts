import { eq, sql } from "drizzle-orm";
import {
  controlPlaneProjects,
  controlPlaneUsers,
  getControlPlaneProject,
  type DbQueryConnection,
} from "@bb/db";
import { workspaceExecutionResponseSchema } from "@bb/host-daemon-contract";
import { posix } from "node:path";
import { ApiError } from "../errors.js";

export function resolveControlPlaneWorkspaceExecution(
  db: DbQueryConnection,
  cwd: string,
) {
  if (posix.resolve(cwd) !== cwd || cwd.includes("\0"))
    throw new ApiError(
      403,
      "workspace_execution_denied",
      "Workspace execution is not authorized",
    );
  const row = db
    .select({
      projectId: controlPlaneProjects.projectId,
      userId: controlPlaneUsers.id,
      uid: controlPlaneUsers.uid,
      state: controlPlaneUsers.environmentStatus,
    })
    .from(controlPlaneProjects)
    .innerJoin(
      controlPlaneUsers,
      eq(controlPlaneUsers.id, controlPlaneProjects.ownerUserId),
    )
    .where(eq(controlPlaneProjects.cwd, cwd))
    .get();
  if (row) {
    const project = getControlPlaneProject(db, row.userId, row.projectId);
    if (
      !project ||
      row.state !== "ready" ||
      !["owner", "runner"].includes(project.role)
    )
      throw new ApiError(
        403,
        "workspace_execution_denied",
        "Workspace execution is not authorized",
      );
    return workspaceExecutionResponseSchema.parse({
      kind: "managed",
      identity: {
        userId: row.userId,
        uid: row.uid,
        projectId: row.projectId,
        cwd,
      },
    });
  }
  const registered = db
    .select({ id: controlPlaneUsers.id })
    .from(controlPlaneUsers)
    .where(
      sql`${cwd} = ${controlPlaneUsers.home} OR substr(${cwd}, 1, length(${controlPlaneUsers.home}) + 1) = ${controlPlaneUsers.home} || '/' OR ${cwd} = ${controlPlaneUsers.projectsRoot} OR substr(${cwd}, 1, length(${controlPlaneUsers.projectsRoot}) + 1) = ${controlPlaneUsers.projectsRoot} || '/'`,
    )
    .limit(1)
    .get();
  if (registered)
    throw new ApiError(
      403,
      "workspace_execution_denied",
      "Workspace execution is not authorized",
    );
  return workspaceExecutionResponseSchema.parse({ kind: "unmanaged" });
}
