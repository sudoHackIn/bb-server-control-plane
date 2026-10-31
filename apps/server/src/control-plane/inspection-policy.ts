import { and, eq, isNull } from "drizzle-orm";
import {
  controlPlaneJobBindings,
  controlPlaneProjects,
  controlPlaneProjectPolicies,
  controlPlaneThreads,
  projects,
  getControlPlaneDiagnosticGrant,
  getControlPlaneProject,
  getControlPlaneJobBinding,
  getThread,
  type DbConnection,
} from "@bb/db";
import { ApiError } from "../errors.js";

export type InspectionActor =
  | { kind: "admin"; login: string; authorized: () => boolean }
  | { kind: "user"; userId: string; authorized: () => boolean };
export function createInspectionPolicy(
  db: DbConnection,
  actor: InspectionActor,
) {
  function denied(): never {
    throw new ApiError(
      404,
      "inspection_not_found",
      "Inspection is unavailable",
    );
  }
  function project(projectId: string) {
    if (!actor.authorized()) return denied();
    if (actor.kind === "user") {
      if (!getControlPlaneProject(db, actor.userId, projectId)) return denied();
    }
    const value = db
      .select({
        projectId: controlPlaneProjects.projectId,
        name: projects.name,
        cwd: controlPlaneProjects.cwd,
      })
      .from(controlPlaneProjects)
      .innerJoin(projects, eq(projects.id, controlPlaneProjects.projectId))
      .where(eq(controlPlaneProjects.projectId, projectId))
      .get();
    if (!value) return denied();
    return value;
  }
  function reviews(projectId: string) {
    project(projectId);
    return (
      actor.kind === "admin" ||
      getControlPlaneDiagnosticGrant(db, projectId, actor.userId)?.role != null
    );
  }
  function owner(projectId: string, ownerUserId: string) {
    project(projectId);
    if (
      actor.kind === "user" &&
      actor.userId !== ownerUserId &&
      !reviews(projectId)
    )
      return denied();
  }
  function workflow(userId: string, runId: string) {
    if (actor.kind === "user" && userId !== actor.userId) return denied();
    const raw = db
      .select({ id: controlPlaneJobBindings.id })
      .from(controlPlaneJobBindings)
      .where(
        and(
          eq(controlPlaneJobBindings.kind, "workflow-run"),
          eq(controlPlaneJobBindings.objectId, runId),
          eq(controlPlaneJobBindings.revision, 1),
          isNull(controlPlaneJobBindings.deletedAt),
        ),
      )
      .get();
    const job = raw ? getControlPlaneJobBinding(db, null, raw.id) : null;
    if (!job || job.deletedAt !== null) return denied();
    owner(job.projectId, job.ownerUserId);
    return job;
  }
  function thread(id: string, rootRunId: string | null) {
    const stored = db
      .select()
      .from(controlPlaneThreads)
      .where(eq(controlPlaneThreads.threadId, id))
      .get();
    const value = getThread(db, id);
    if (
      !stored ||
      !value ||
      value.deletedAt !== null ||
      value.projectId === null
    )
      return denied();
    owner(value.projectId, stored.ownerUserId);
    if (rootRunId !== null) {
      const root = workflow(
        actor.kind === "user" ? actor.userId : "admin",
        rootRunId,
      );
      const child = stored.jobBindingId
        ? getControlPlaneJobBinding(db, null, stored.jobBindingId)
        : null;
      if (
        value.projectId !== root.projectId ||
        stored.ownerUserId !== root.ownerUserId ||
        !child ||
        child.kind !== "workflow-worker" ||
        child.sourceBindingId !== root.id ||
        child.ownerUserId !== root.ownerUserId ||
        child.projectId !== root.projectId
      )
        return denied();
    } else if (
      stored.jobBindingId &&
      getControlPlaneJobBinding(db, null, stored.jobBindingId)?.kind ===
        "workflow-worker"
    )
      return denied();
    return {
      row: { ...value, profileVersionId: stored.profileVersionId },
      thread: value,
      ownerUserId: stored.ownerUserId,
    };
  }
  function epoch(projectId: string, ownerUserId: string) {
    owner(projectId, ownerUserId);
    const revision =
      db
        .select({ value: controlPlaneProjectPolicies.revision })
        .from(controlPlaneProjectPolicies)
        .where(eq(controlPlaneProjectPolicies.projectId, projectId))
        .get()?.value ?? 0;
    return JSON.stringify([
      actor.kind,
      revision,
      actor.kind === "user"
        ? getControlPlaneProject(db, actor.userId, projectId)?.role
        : null,
      actor.kind === "user" && actor.userId !== ownerUserId
        ? getControlPlaneDiagnosticGrant(db, projectId, actor.userId)?.revision
        : null,
    ]);
  }
  return { project, reviews, owner, workflow, thread, epoch };
}
