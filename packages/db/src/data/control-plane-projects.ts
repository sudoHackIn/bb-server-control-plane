import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { DbQueryConnection } from "../connection.js";
import {
  controlPlaneProjects,
  controlPlaneProjectAccess,
  controlPlaneUsers,
  projects,
  projectSources,
  hosts,
} from "../schema.js";

function accessibleProjects(db: DbQueryConnection) {
  return db
    .select({
      projectId: projects.id,
      name: projects.name,
      slug: controlPlaneProjects.slug,
      hostId: controlPlaneProjects.hostId,
      cwd: controlPlaneProjects.cwd,
      ownerUserId: controlPlaneProjects.ownerUserId,
      role: controlPlaneProjectAccess.role,
    })
    .from(controlPlaneProjectAccess)
    .innerJoin(
      controlPlaneUsers,
      and(
        eq(controlPlaneUsers.id, controlPlaneProjectAccess.userId),
        eq(controlPlaneUsers.enabled, true),
      ),
    )
    .innerJoin(
      controlPlaneProjects,
      eq(controlPlaneProjects.projectId, controlPlaneProjectAccess.projectId),
    )
    .innerJoin(
      projects,
      and(
        eq(projects.id, controlPlaneProjects.projectId),
        eq(projects.kind, "standard"),
        isNull(projects.deletedAt),
      ),
    )
    .innerJoin(
      hosts,
      and(eq(hosts.id, controlPlaneProjects.hostId), isNull(hosts.destroyedAt)),
    )
    .innerJoin(
      projectSources,
      and(
        eq(projectSources.projectId, projects.id),
        eq(projectSources.type, "local_path"),
        eq(projectSources.hostId, controlPlaneProjects.hostId),
        eq(projectSources.path, controlPlaneProjects.cwd),
      ),
    )
    .$dynamic();
}

export function getControlPlaneProject(
  db: DbQueryConnection,
  userId: string,
  projectId: string,
) {
  return accessibleProjects(db)
    .where(
      and(
        eq(controlPlaneProjectAccess.userId, userId),
        eq(projects.id, projectId),
      ),
    )
    .get();
}

export function listControlPlaneProjects(
  db: DbQueryConnection,
  userId: string,
  options: { cursor: string | null; limit: number },
) {
  const rows = accessibleProjects(db)
    .where(
      and(
        eq(controlPlaneProjectAccess.userId, userId),
        options.cursor ? gt(projects.id, options.cursor) : undefined,
      ),
    )
    .orderBy(asc(projects.id))
    .limit(options.limit + 1)
    .all();
  const selected = rows.slice(0, options.limit);
  return {
    projects: selected,
    nextCursor:
      rows.length > options.limit ? (selected.at(-1)?.projectId ?? null) : null,
  };
}
