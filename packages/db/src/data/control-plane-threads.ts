import { getControlPlaneUidMaintenance } from "./control-plane-uid-maintenance.js";
import {
  CONTROL_PLANE_AUTOMATIONS_PLUGIN_ID,
  CONTROL_PLANE_WORKFLOWS_PLUGIN_ID,
} from "@bb/domain";
import {
  requireControlPlaneJobDispatch,
  ControlPlaneJobError,
} from "./control-plane-jobs.js";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import {
  controlPlaneProjects,
  controlPlaneJobBindings,
  controlPlaneProjectAccess,
  controlPlaneProfileVersions,
  controlPlaneThreads,
  controlPlaneUsers,
  environments,
  threads,
} from "../schema.js";
import {
  accessibleControlPlaneProjects,
  getControlPlaneProject,
} from "./control-plane-projects.js";
import { getControlPlaneProfile } from "./control-plane-profiles.js";

export class ControlPlaneThreadError extends Error {
  constructor(
    readonly reason: "unauthorized" | "maintenance" = "unauthorized",
  ) {
    super("Thread execution is not authorized");
    this.name = "ControlPlaneThreadError";
  }
}

export function getControlPlaneProjectOwner(
  db: DbQueryConnection,
  projectId: string,
) {
  return db
    .select()
    .from(controlPlaneProjects)
    .where(eq(controlPlaneProjects.projectId, projectId))
    .get();
}

export function requireControlPlaneThreadOwner(
  db: DbQueryConnection,
  input: {
    projectId: string;
    ownerUserId: string | undefined;
    profileVersionId: string | undefined;
    providerId: string;
    jobBindingId?: string;
    originPluginId?: string | null;
    relatedThreadIds: readonly (string | null | undefined)[];
  },
): {
  user: typeof controlPlaneUsers.$inferSelect;
  project: NonNullable<ReturnType<typeof getControlPlaneProject>>;
  profileVersion: NonNullable<
    ReturnType<typeof getControlPlaneProfile>
  >["version"];
  maintenanceGeneration: number;
} | null {
  const managed = getControlPlaneProjectOwner(db, input.projectId);
  if (!managed) {
    if (
      input.ownerUserId !== undefined ||
      input.profileVersionId !== undefined ||
      input.jobBindingId !== undefined ||
      input.providerId === "qwen-server"
    )
      throw new ControlPlaneThreadError();
    return null;
  }
  if (!input.ownerUserId || input.providerId !== "qwen-server")
    throw new ControlPlaneThreadError();
  const maintenance = getControlPlaneUidMaintenance(db, input.ownerUserId);
  const project = getControlPlaneProject(
    db,
    input.ownerUserId,
    input.projectId,
  );
  const user = db
    .select()
    .from(controlPlaneUsers)
    .where(eq(controlPlaneUsers.id, input.ownerUserId))
    .get();
  if (
    !project ||
    !["owner", "runner"].includes(project.role) ||
    !user?.enabled ||
    user.environmentStatus !== "ready"
  )
    throw new ControlPlaneThreadError();
  for (const id of input.relatedThreadIds) {
    if (!id) continue;
    const owner = db
      .select({
        ownerUserId: controlPlaneThreads.ownerUserId,
        projectId: threads.projectId,
      })
      .from(controlPlaneThreads)
      .innerJoin(threads, eq(threads.id, controlPlaneThreads.threadId))
      .where(
        and(
          eq(controlPlaneThreads.threadId, id),
          isNull(threads.deletedAt),
          isNull(threads.archivedAt),
        ),
      )
      .get();
    if (
      owner?.ownerUserId !== input.ownerUserId ||
      !getControlPlaneProject(db, input.ownerUserId, owner.projectId)
    )
      throw new ControlPlaneThreadError();
  }
  const version = input.profileVersionId
    ? db
        .select()
        .from(controlPlaneProfileVersions)
        .where(eq(controlPlaneProfileVersions.id, input.profileVersionId))
        .get()
    : null;
  const profile = version
    ? getControlPlaneProfile(db, user.id, version.profileId, version.id)
    : null;
  if (!profile || profile.version.definition.providerId !== input.providerId)
    throw new ControlPlaneThreadError();
  if (maintenance !== undefined && maintenance.phase !== "idle")
    throw new ControlPlaneThreadError("maintenance");
  if (
    input.jobBindingId !== undefined ||
    input.originPluginId === CONTROL_PLANE_WORKFLOWS_PLUGIN_ID ||
    input.originPluginId === CONTROL_PLANE_AUTOMATIONS_PLUGIN_ID
  ) {
    if (!input.jobBindingId) throw new ControlPlaneThreadError();
    try {
      const job = requireControlPlaneJobDispatch(db, input.jobBindingId);
      if (
        (job.binding.kind !== "workflow-worker" &&
          job.binding.kind !== "automation-worker") ||
        input.originPluginId !==
          (job.binding.kind === "workflow-worker"
            ? CONTROL_PLANE_WORKFLOWS_PLUGIN_ID
            : CONTROL_PLANE_AUTOMATIONS_PLUGIN_ID) ||
        job.user.id !== user.id ||
        job.project.projectId !== project.projectId ||
        job.profileVersion.id !== profile.version.id
      )
        throw new ControlPlaneThreadError();
    } catch (error) {
      if (error instanceof ControlPlaneJobError)
        throw new ControlPlaneThreadError(error.reason);
      throw error;
    }
  }
  return {
    user,
    project,
    profileVersion: profile.version,
    maintenanceGeneration: maintenance?.generation ?? 0,
  };
}

export function requireControlPlaneThreadDispatch(
  db: DbQueryConnection,
  threadId: string,
) {
  const thread = db
    .select()
    .from(threads)
    .where(eq(threads.id, threadId))
    .get();
  if (!thread) throw new ControlPlaneThreadError();
  const owner = db
    .select()
    .from(controlPlaneThreads)
    .where(eq(controlPlaneThreads.threadId, threadId))
    .get();
  const context = requireControlPlaneThreadOwner(db, {
    projectId: thread.projectId,
    ownerUserId: owner?.ownerUserId,
    profileVersionId: owner?.profileVersionId ?? undefined,
    providerId: thread.providerId,
    jobBindingId: owner?.jobBindingId ?? undefined,
    originPluginId: thread.originPluginId,
    relatedThreadIds: [],
  });
  if (!context) return null;
  if (thread.deletedAt !== null || thread.archivedAt !== null)
    throw new ControlPlaneThreadError();
  if (thread.environmentId !== null) {
    const environment = db
      .select()
      .from(environments)
      .where(eq(environments.id, thread.environmentId))
      .get();
    if (
      !environment ||
      environment.providerOwnsPath ||
      environment.projectId !== thread.projectId ||
      environment.hostId !== context.project.hostId ||
      environment.path !== context.project.cwd ||
      !["ready", "provisioning"].includes(environment.status)
    )
      throw new ControlPlaneThreadError();
  }
  return { ...context, thread };
}

export function resolveControlPlaneQwenContext(
  db: DbConnection,
  input: { threadId: string; sessionId: string; cwd: string },
) {
  return db.transaction(
    (tx) => {
      const context = requireControlPlaneThreadDispatch(tx, input.threadId);
      if (
        !context ||
        context.thread.environmentId === null ||
        !["starting", "active"].includes(context.thread.status) ||
        context.project.cwd !== input.cwd
      )
        throw new ControlPlaneThreadError();
      const environment = tx
        .select()
        .from(environments)
        .where(eq(environments.id, context.thread.environmentId))
        .get();
      if (environment?.status !== "ready") throw new ControlPlaneThreadError();
      const conflict = tx
        .select({ threadId: controlPlaneThreads.threadId })
        .from(controlPlaneThreads)
        .where(eq(controlPlaneThreads.qwenSessionId, input.sessionId))
        .get();
      if (conflict && conflict.threadId !== input.threadId)
        throw new ControlPlaneThreadError();
      const bound = tx
        .update(controlPlaneThreads)
        .set({ qwenSessionId: input.sessionId })
        .where(
          and(
            eq(controlPlaneThreads.threadId, input.threadId),
            or(
              isNull(controlPlaneThreads.qwenSessionId),
              eq(controlPlaneThreads.qwenSessionId, input.sessionId),
            ),
          ),
        )
        .returning()
        .get();
      if (!bound) throw new ControlPlaneThreadError();
      return {
        id: context.user.id,
        user: context.user.login,
        uid: context.user.uid,
        maintenanceGeneration: context.maintenanceGeneration,
        gid: context.user.gid,
        home: context.user.home,
        cwd: context.project.cwd,
        threadId: input.threadId,
        sessionId: input.sessionId,
        profile: {
          versionId: context.profileVersion.id,
          definition: context.profileVersion.definition,
        },
      };
    },
    { behavior: "immediate" },
  );
}

export function listControlPlaneThreads(
  db: DbQueryConnection,
  userId: string,
  options: { projectId?: string; cursor: string | null; limit: number },
) {
  const accessible = accessibleControlPlaneProjects(db)
    .where(eq(controlPlaneProjectAccess.userId, userId))
    .as("accessible_projects");
  const rows = db
    .select({
      id: threads.id,
      projectId: threads.projectId,
      profileVersionId: controlPlaneThreads.profileVersionId,
      title: threads.title,
      status: threads.status,
      createdAt: threads.createdAt,
      updatedAt: threads.updatedAt,
      archivedAt: threads.archivedAt,
    })
    .from(controlPlaneThreads)
    .innerJoin(threads, eq(threads.id, controlPlaneThreads.threadId))
    .innerJoin(accessible, eq(accessible.projectId, threads.projectId))
    .where(
      and(
        eq(controlPlaneThreads.ownerUserId, userId),
        isNull(controlPlaneThreads.runSource),
        sql`NOT EXISTS (SELECT 1 FROM ${controlPlaneJobBindings} WHERE ${controlPlaneJobBindings.id} = ${controlPlaneThreads.jobBindingId} AND ${controlPlaneJobBindings.kind} = 'automation-worker')`,
        isNull(threads.deletedAt),
        options.projectId
          ? eq(threads.projectId, options.projectId)
          : undefined,
        options.cursor ? gt(threads.id, options.cursor) : undefined,
      ),
    )
    .orderBy(asc(threads.id))
    .limit(options.limit + 1)
    .all();
  const selected = rows.slice(0, options.limit);
  return {
    threads: selected.map(({ archivedAt, ...row }) => ({
      ...row,
      archived: archivedAt !== null,
    })),
    nextCursor:
      rows.length > options.limit ? (selected.at(-1)?.id ?? null) : null,
  };
}

export function getControlPlaneAgentRunByKey(
  db: DbQueryConnection,
  userId: string,
  idempotencyKey: string,
) {
  return db
    .select({
      threadId: controlPlaneThreads.threadId,
      inputDigest: controlPlaneThreads.runInputDigest,
    })
    .from(controlPlaneThreads)
    .where(
      and(
        eq(controlPlaneThreads.ownerUserId, userId),
        eq(controlPlaneThreads.runSource, "manual"),
        eq(controlPlaneThreads.runIdempotencyKey, idempotencyKey),
      ),
    )
    .get();
}

export function listControlPlaneAgentRuns(
  db: DbQueryConnection,
  userId: string,
  options: { projectId?: string; cursor: string | null; limit: number },
) {
  const accessible = accessibleControlPlaneProjects(db)
    .where(eq(controlPlaneProjectAccess.userId, userId))
    .as("accessible_run_projects");
  const rows = db
    .select({
      runId: threads.id,
      threadId: threads.id,
      projectId: threads.projectId,
      profileId: controlPlaneProfileVersions.profileId,
      profileVersionId: controlPlaneThreads.profileVersionId,
      source: sql<
        "manual" | "automation"
      >`CASE WHEN ${controlPlaneThreads.runSource} = 'manual' THEN 'manual' ELSE 'automation' END`,
      title: threads.title,
      status: threads.status,
      createdAt: threads.createdAt,
      updatedAt: threads.updatedAt,
    })
    .from(controlPlaneThreads)
    .innerJoin(threads, eq(threads.id, controlPlaneThreads.threadId))
    .innerJoin(
      controlPlaneProfileVersions,
      eq(controlPlaneProfileVersions.id, controlPlaneThreads.profileVersionId),
    )
    .leftJoin(
      controlPlaneJobBindings,
      eq(controlPlaneJobBindings.id, controlPlaneThreads.jobBindingId),
    )
    .innerJoin(accessible, eq(accessible.projectId, threads.projectId))
    .where(
      and(
        eq(controlPlaneThreads.ownerUserId, userId),
        or(
          eq(controlPlaneThreads.runSource, "manual"),
          eq(controlPlaneJobBindings.kind, "automation-worker"),
        ),
        isNull(threads.deletedAt),
        options.projectId
          ? eq(threads.projectId, options.projectId)
          : undefined,
        options.cursor ? gt(threads.id, options.cursor) : undefined,
      ),
    )
    .orderBy(asc(threads.id))
    .limit(options.limit + 1)
    .all();
  const selected = rows.slice(0, options.limit);
  return {
    runs: selected,
    nextCursor:
      rows.length > options.limit ? (selected.at(-1)?.runId ?? null) : null,
  };
}

export function getControlPlaneThread(
  db: DbQueryConnection,
  userId: string,
  threadId: string,
) {
  const owner = db
    .select()
    .from(controlPlaneThreads)
    .innerJoin(threads, eq(threads.id, controlPlaneThreads.threadId))
    .where(
      and(
        eq(controlPlaneThreads.threadId, threadId),
        eq(controlPlaneThreads.ownerUserId, userId),
        isNull(threads.deletedAt),
      ),
    )
    .get();
  if (!owner || !getControlPlaneProject(db, userId, owner.threads.projectId))
    return null;
  return {
    ...owner.threads,
    profileVersionId: owner.control_plane_threads.profileVersionId,
  };
}
