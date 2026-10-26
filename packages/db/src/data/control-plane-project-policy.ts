import { join } from "node:path";
import { and, asc, eq, ne } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import {
  controlPlaneProjects,
  controlPlaneProjectPolicies,
  controlPlaneProjectAccess,
  controlPlaneUsers,
  projectSources,
} from "../schema.js";
import { getControlPlaneProject } from "./control-plane-projects.js";

export function getControlPlaneProjectAccessPolicy(
  db: DbConnection,
  projectId: string,
) {
  return db.transaction((tx) => {
    const binding = tx
      .select({
        project: controlPlaneProjects,
        policy: controlPlaneProjectPolicies,
        owner: controlPlaneUsers,
      })
      .from(controlPlaneProjectPolicies)
      .innerJoin(
        controlPlaneProjects,
        eq(
          controlPlaneProjects.projectId,
          controlPlaneProjectPolicies.projectId,
        ),
      )
      .innerJoin(
        controlPlaneUsers,
        eq(controlPlaneUsers.id, controlPlaneProjects.ownerUserId),
      )
      .where(eq(controlPlaneProjectPolicies.projectId, projectId))
      .get();
    if (!binding) return null;
    const { owner, project, policy } = binding;
    const source = tx
      .select({ id: projectSources.id })
      .from(projectSources)
      .where(
        and(
          eq(projectSources.projectId, projectId),
          eq(projectSources.hostId, project.hostId),
          eq(projectSources.path, project.cwd),
          eq(projectSources.type, "local_path"),
          eq(projectSources.ownsPath, false),
        ),
      )
      .get();
    const active =
      /^[a-z][a-z0-9-]{0,47}$/u.test(project.slug) &&
      project.cwd === join(owner.projectsRoot, project.slug) &&
      owner.enabled &&
      owner.environmentStatus === "ready" &&
      source !== undefined &&
      getControlPlaneProject(tx, owner.id, projectId)?.role === "owner";
    const members = active
      ? tx
          .select({ user: controlPlaneUsers })
          .from(controlPlaneProjectAccess)
          .innerJoin(
            controlPlaneUsers,
            eq(controlPlaneUsers.id, controlPlaneProjectAccess.userId),
          )
          .where(
            and(
              eq(controlPlaneProjectAccess.projectId, projectId),
              eq(controlPlaneProjectAccess.role, "runner"),
              ne(controlPlaneUsers.id, owner.id),
              eq(controlPlaneUsers.enabled, true),
              eq(controlPlaneUsers.environmentStatus, "ready"),
            ),
          )
          .orderBy(asc(controlPlaneUsers.id))
          .all()
          .map((row) => row.user)
      : [];
    return {
      project,
      owner,
      revision: policy.revision,
      appliedRevision: policy.appliedRevision,
      members,
    };
  });
}

export function acknowledgeControlPlaneProjectAccessPolicy(
  db: DbConnection,
  projectId: string,
  revision: number,
) {
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new Error("Invalid project policy revision");
  return (
    db
      .update(controlPlaneProjectPolicies)
      .set({ appliedRevision: revision })
      .where(
        and(
          eq(controlPlaneProjectPolicies.projectId, projectId),
          eq(controlPlaneProjectPolicies.revision, revision),
        ),
      )
      .run().changes === 1
  );
}
