import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import {
  controlPlaneJobBindingSchema,
  controlPlaneJobListSchema,
  type ControlPlaneJobBinding,
} from "@bb/domain";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import {
  controlPlaneJobBindings,
  controlPlaneThreads,
  controlPlaneProjectAccess,
  threads,
} from "../schema.js";
import { accessibleControlPlaneProjects } from "./control-plane-projects.js";
import {
  requireControlPlaneThreadOwner,
  ControlPlaneThreadError,
} from "./control-plane-threads.js";

type Job = typeof controlPlaneJobBindings.$inferSelect;
export class ControlPlaneJobError extends Error {
  constructor(
    readonly reason: "unauthorized" | "maintenance" = "unauthorized",
  ) {
    super("Background execution is not authorized");
    this.name = "ControlPlaneJobError";
  }
}

function row(db: DbQueryConnection, id: string) {
  return db
    .select()
    .from(controlPlaneJobBindings)
    .where(eq(controlPlaneJobBindings.id, id))
    .get();
}
function authority(db: DbQueryConnection, job: Job, allowDisabled = false) {
  if (job.deletedAt !== null || (!allowDisabled && !job.enabled))
    throw new ControlPlaneJobError();
  try {
    const context = requireControlPlaneThreadOwner(db, {
      projectId: job.projectId,
      ownerUserId: job.ownerUserId,
      profileVersionId: job.profileVersionId,
      providerId: "qwen-server",
      relatedThreadIds: job.kind.startsWith("automation")
        ? []
        : [job.originThreadId],
    });
    if (!context) throw new ControlPlaneJobError();
    if (job.originThreadId !== null && job.kind.startsWith("automation")) {
      const origin = db
        .select({
          owner: controlPlaneThreads.ownerUserId,
          projectId: threads.projectId,
        })
        .from(controlPlaneThreads)
        .innerJoin(threads, eq(threads.id, controlPlaneThreads.threadId))
        .where(eq(controlPlaneThreads.threadId, job.originThreadId))
        .get();
      if (
        !origin ||
        origin.owner !== job.ownerUserId ||
        origin.projectId !== job.projectId
      )
        throw new ControlPlaneJobError();
    }

    if (job.originThreadId !== null && !job.kind.startsWith("automation")) {
      const origin = db
        .select({ projectId: threads.projectId })
        .from(threads)
        .where(eq(threads.id, job.originThreadId))
        .get();
      if (origin?.projectId !== job.projectId) throw new ControlPlaneJobError();
    }
    return context;
  } catch (error) {
    if (error instanceof ControlPlaneThreadError)
      throw new ControlPlaneJobError(error.reason);
    throw error;
  }
}
function lineage(db: DbQueryConnection, job: Job, allowDisabled = false) {
  const context = authority(db, job, allowDisabled);
  const active = new Set<string>();
  const visited = new Set<string>();
  function visit(current: Job) {
    if (active.has(current.id)) throw new ControlPlaneJobError();
    if (visited.has(current.id)) return;
    if (active.size + visited.size >= 32) throw new ControlPlaneJobError();
    if (
      current.ownerUserId !== job.ownerUserId ||
      current.projectId !== job.projectId
    )
      throw new ControlPlaneJobError();
    authority(db, current, current.id === job.id && allowDisabled);
    active.add(current.id);
    const originBindingId =
      !current.kind.startsWith("automation") && current.originThreadId
        ? db
            .select({ jobBindingId: controlPlaneThreads.jobBindingId })
            .from(controlPlaneThreads)
            .where(eq(controlPlaneThreads.threadId, current.originThreadId))
            .get()?.jobBindingId
        : null;
    if (
      current.kind === "workflow-worker" ||
      current.kind === "automation-worker"
    ) {
      const parent = current.sourceBindingId
        ? row(db, current.sourceBindingId)
        : null;
      if (
        !parent ||
        parent.kind !==
          (current.kind === "workflow-worker"
            ? "workflow-run"
            : "automation-run") ||
        (current.kind === "workflow-worker" &&
          current.originThreadId === null) ||
        parent.originThreadId !== current.originThreadId ||
        (current.kind === "automation-worker" &&
          parent.profileVersionId !== current.profileVersionId)
      )
        throw new ControlPlaneJobError();
    }
    for (const id of new Set([current.sourceBindingId, originBindingId])) {
      if (!id) continue;
      const parent = row(db, id);
      if (!parent) throw new ControlPlaneJobError();
      visit(parent);
    }
    active.delete(current.id);
    visited.add(current.id);
  }
  visit(job);
  return context;
}

export function createControlPlaneJobBinding(
  db: DbConnection,
  input: ControlPlaneJobBinding,
) {
  const value = controlPlaneJobBindingSchema.parse(input);
  return db.transaction(
    (tx) => {
      const candidate = {
        id: randomUUID(),
        kind: value.kind,
        objectId: value.objectId,
        revision: value.revision,
        ownerUserId: value.userId,
        projectId: value.projectId,
        profileVersionId: value.profileVersionId,
        originThreadId: value.originThreadId,
        sourceBindingId: value.sourceBindingId,
        enabled: true,
        deletedAt: null,
        createdAt: Date.now(),
      };
      lineage(tx, candidate);
      const object = tx
        .select()
        .from(controlPlaneJobBindings)
        .where(
          and(
            eq(controlPlaneJobBindings.kind, value.kind),
            eq(controlPlaneJobBindings.objectId, value.objectId),
          ),
        )
        .limit(1)
        .get();
      if (
        object &&
        (object.ownerUserId !== value.userId ||
          object.projectId !== value.projectId)
      )
        throw new ControlPlaneJobError();
      const existing = tx
        .select()
        .from(controlPlaneJobBindings)
        .where(
          and(
            eq(controlPlaneJobBindings.kind, value.kind),
            eq(controlPlaneJobBindings.objectId, value.objectId),
            eq(controlPlaneJobBindings.revision, value.revision),
          ),
        )
        .get();
      if (existing) {
        if (
          existing.ownerUserId !== value.userId ||
          existing.projectId !== value.projectId ||
          existing.profileVersionId !== value.profileVersionId ||
          existing.originThreadId !== value.originThreadId ||
          existing.sourceBindingId !== value.sourceBindingId
        )
          throw new ControlPlaneJobError();
        lineage(tx, existing);
        return existing;
      }
      const created = tx
        .insert(controlPlaneJobBindings)
        .values(candidate)
        .returning()
        .get();
      if (!created) throw new ControlPlaneJobError();
      return created;
    },
    { behavior: "immediate" },
  );
}

export function listControlPlaneJobBindings(
  db: DbQueryConnection,
  userId: string | null,
  input: {
    kind?: Job["kind"];
    projectId?: string;
    cursor: string | null;
    limit: number;
  },
) {
  const options = controlPlaneJobListSchema.parse(input);
  if (userId === null) {
    const rows = db
      .select()
      .from(controlPlaneJobBindings)
      .where(
        and(
          isNull(controlPlaneJobBindings.deletedAt),
          options.kind
            ? eq(controlPlaneJobBindings.kind, options.kind)
            : undefined,
          options.projectId
            ? eq(controlPlaneJobBindings.projectId, options.projectId)
            : undefined,
          options.cursor
            ? gt(controlPlaneJobBindings.id, options.cursor)
            : undefined,
        ),
      )
      .orderBy(asc(controlPlaneJobBindings.id))
      .limit(options.limit + 1)
      .all();
    const bindings = rows.slice(0, options.limit);
    return {
      bindings,
      nextCursor:
        rows.length > options.limit ? (bindings.at(-1)?.id ?? null) : null,
    };
  }
  const accessible = accessibleControlPlaneProjects(db)
    .where(eq(controlPlaneProjectAccess.userId, userId))
    .as("accessible_job_projects");
  const rows = db
    .select({ binding: controlPlaneJobBindings })
    .from(controlPlaneJobBindings)
    .innerJoin(
      accessible,
      eq(accessible.projectId, controlPlaneJobBindings.projectId),
    )
    .where(
      and(
        eq(controlPlaneJobBindings.ownerUserId, userId),
        isNull(controlPlaneJobBindings.deletedAt),
        options.kind
          ? eq(controlPlaneJobBindings.kind, options.kind)
          : undefined,
        options.projectId
          ? eq(controlPlaneJobBindings.projectId, options.projectId)
          : undefined,
        options.cursor
          ? gt(controlPlaneJobBindings.id, options.cursor)
          : undefined,
      ),
    )
    .orderBy(asc(controlPlaneJobBindings.id))
    .limit(options.limit + 1)
    .all();
  const bindings = rows.slice(0, options.limit).map(({ binding }) => binding);
  return {
    bindings,
    nextCursor:
      rows.length > options.limit ? (bindings.at(-1)?.id ?? null) : null,
  };
}

export function getControlPlaneJobBinding(
  db: DbQueryConnection,
  userId: string | null,
  id: string,
) {
  if (userId === null) return row(db, id) ?? null;
  const accessible = accessibleControlPlaneProjects(db)
    .where(eq(controlPlaneProjectAccess.userId, userId))
    .as("accessible_job_projects");
  return (
    db
      .select({ binding: controlPlaneJobBindings })
      .from(controlPlaneJobBindings)
      .innerJoin(
        accessible,
        eq(accessible.projectId, controlPlaneJobBindings.projectId),
      )
      .where(
        and(
          eq(controlPlaneJobBindings.id, id),
          eq(controlPlaneJobBindings.ownerUserId, userId),
          isNull(controlPlaneJobBindings.deletedAt),
        ),
      )
      .get()?.binding ?? null
  );
}

export function requireControlPlaneJobDispatch(
  db: DbQueryConnection,
  id: string,
) {
  const job = row(db, id);
  if (!job) throw new ControlPlaneJobError();
  return { binding: job, ...lineage(db, job) };
}

export function setControlPlaneJobEnabled(
  db: DbConnection,
  userId: string | null,
  id: string,
  enabled: boolean,
) {
  return db.transaction(
    (tx) => {
      const job = getControlPlaneJobBinding(tx, userId, id);
      if (!job) throw new ControlPlaneJobError();
      if (enabled) lineage(tx, job, true);
      return tx
        .update(controlPlaneJobBindings)
        .set({ enabled })
        .where(eq(controlPlaneJobBindings.id, id))
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );
}

export function deleteControlPlaneJobBinding(
  db: DbConnection,
  userId: string | null,
  id: string,
) {
  return db.transaction(
    (tx) => {
      if (!getControlPlaneJobBinding(tx, userId, id))
        throw new ControlPlaneJobError();
      tx.update(controlPlaneJobBindings)
        .set({ enabled: false, deletedAt: Date.now() })
        .where(eq(controlPlaneJobBindings.id, id))
        .run();
    },
    { behavior: "immediate" },
  );
}
