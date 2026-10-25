import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, asc, gt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type { InternalDoNotUseBackgroundJobs } from "@get-bb/plugin-sdk";
import {
  controlPlaneThreads,
  accessibleControlPlaneProjects,
  controlPlaneProjectAccess,
  controlPlaneJobBindings,
  threads,
  createControlPlaneJobBinding,
  deleteControlPlaneJobBinding,
  setControlPlaneJobEnabled,
  getThread,
  getThreadPluginMetadata,
  getEnvironment,
  requireControlPlaneThreadDispatch,
} from "@bb/db";
import type { AppDeps } from "../types.js";
import { archiveThreadWithLifecycleEffects } from "../services/threads/thread-archive.js";
import { ApiError } from "../errors.js";
import {
  getLastThreadOutput,
  getLastThreadError,
  listThreadEventRows,
} from "../services/threads/thread-data.js";
import { createControlPlaneThreadService } from "./threads.js";
import {
  currentControlPlanePrincipal,
  withControlPlaneService,
  withControlPlaneUser,
} from "./access.js";
import { withControlPlaneJobAuthority } from "./job-authority.js";
import { stopThreadForCurrentState } from "../services/threads/thread-lifecycle.js";
import { resolveThreadHostCommandEnvironment } from "../services/threads/thread-command-environment.js";

const inputSchema = z
  .object({
    callId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u),
    prompt: z.string().min(1).max(131072),
    title: z.string().min(1).max(200).nullable(),
    profileVersionId: z.string().uuid().nullable(),
  })
  .strict();
function denied(): never {
  throw new ApiError(
    403,
    "worker_not_authorized",
    "Workflow worker is not authorized",
  );
}

export function createControlPlaneWorkflowWorkers(deps: AppDeps) {
  const service = createControlPlaneThreadService({ deps });
  let closed = false;
  let sweep: Promise<void> | null = null;
  function read(parentId: string, threadId: string) {
    if (!getThread(deps.db, threadId))
      throw new ApiError(
        404,
        "thread_not_found",
        "Workflow worker was deleted",
      );
    const record = deps.db
      .select({ owner: controlPlaneThreads, binding: controlPlaneJobBindings })
      .from(controlPlaneThreads)
      .innerJoin(
        controlPlaneJobBindings,
        eq(controlPlaneJobBindings.id, controlPlaneThreads.jobBindingId),
      )
      .where(
        and(
          eq(controlPlaneThreads.threadId, threadId),
          eq(controlPlaneJobBindings.sourceBindingId, parentId),
        ),
      )
      .get();
    const principal = currentControlPlanePrincipal();
    if (
      !record ||
      record.binding.kind !== "workflow-worker" ||
      record.binding.ownerUserId !== record.owner.ownerUserId ||
      (principal?.kind === "user" &&
        principal.userId !== record.owner.ownerUserId)
    )
      return denied();
    if (principal?.kind === "user")
      service.get(record.owner.ownerUserId, threadId);
    const thread = getThread(deps.db, threadId);
    if (
      !thread ||
      thread.projectId !== record.binding.projectId ||
      record.owner.profileVersionId !== record.binding.profileVersionId
    )
      return denied();
    return { ...record, thread };
  }
  async function stop(threadId: string) {
    const thread = getThread(deps.db, threadId);
    if (!thread) return;
    const environment = resolveThreadHostCommandEnvironment({
      db: deps.db,
      thread,
    });
    await stopThreadForCurrentState(deps, thread, environment);
  }
  async function stopWorker(parentId: string, threadId: string) {
    if (!getThread(deps.db, threadId)) return;
    const record = read(parentId, threadId);
    setControlPlaneJobEnabled(
      deps.db,
      currentControlPlanePrincipal()?.kind === "user"
        ? record.owner.ownerUserId
        : null,
      record.binding.id,
      false,
    );
    await withControlPlaneUser(record.owner.ownerUserId, () => stop(threadId));
  }
  const timer = withControlPlaneService(() =>
    setInterval(() => {
      if (closed || sweep) return;
      sweep = (async () => {
        const active = deps.db
          .select({ id: threads.id })
          .from(threads)
          .innerJoin(
            controlPlaneThreads,
            eq(controlPlaneThreads.threadId, threads.id),
          )
          .where(
            and(
              isNotNull(controlPlaneThreads.jobBindingId),
              inArray(threads.status, ["pending", "starting", "active"]),
            ),
          )
          .all();
        const revoked = active.filter((thread) => {
          try {
            requireControlPlaneThreadDispatch(deps.db, thread.id);
            return false;
          } catch {
            return true;
          }
        });
        await Promise.all(
          revoked.map(async (thread) => {
            try {
              await stop(thread.id);
            } catch (error) {
              deps.logger.error(
                { error, threadId: thread.id },
                "Could not stop a revoked workflow worker",
              );
            }
          }),
        );
      })()
        .catch((error) =>
          deps.logger.error(
            { error },
            "Workflow worker authority reconciliation failed",
          ),
        )
        .finally(() => {
          sweep = null;
        });
    }, 500),
  );
  timer.unref();
  return {
    listWorkers(
      input: Parameters<InternalDoNotUseBackgroundJobs["listWorkers"]>[0],
    ) {
      const parsed = z
        .object({
          cursor: z.string().min(1).nullable(),
          includeArchived: z.boolean(),
          limit: z.number().int().min(1).max(100),
        })
        .strict()
        .parse(input);
      const principal = currentControlPlanePrincipal();
      const parent = alias(controlPlaneJobBindings, "worker_parent_binding");
      const accessible =
        principal?.kind === "user"
          ? accessibleControlPlaneProjects(deps.db)
              .where(eq(controlPlaneProjectAccess.userId, principal.userId))
              .as("readable_worker_projects")
          : null;
      const rows = deps.db
        .select({
          threadId: threads.id,
          bindingId: controlPlaneJobBindings.id,
          parentBindingId: parent.id,
          runId: parent.objectId,
          originThreadId: parent.originThreadId,
        })
        .from(controlPlaneJobBindings)
        .innerJoin(
          controlPlaneThreads,
          eq(controlPlaneThreads.jobBindingId, controlPlaneJobBindings.id),
        )
        .innerJoin(threads, eq(threads.id, controlPlaneThreads.threadId))
        .innerJoin(
          parent,
          eq(parent.id, controlPlaneJobBindings.sourceBindingId),
        )
        .where(
          and(
            eq(controlPlaneJobBindings.kind, "workflow-worker"),
            eq(parent.kind, "workflow-run"),
            eq(threads.originPluginId, "workflows"),
            isNull(threads.deletedAt),
            parsed.includeArchived ? undefined : isNull(threads.archivedAt),
            eq(parent.ownerUserId, controlPlaneJobBindings.ownerUserId),
            eq(parent.projectId, controlPlaneJobBindings.projectId),
            eq(parent.originThreadId, controlPlaneJobBindings.originThreadId),
            isNotNull(parent.originThreadId),
            eq(
              controlPlaneThreads.ownerUserId,
              controlPlaneJobBindings.ownerUserId,
            ),
            eq(
              controlPlaneThreads.profileVersionId,
              controlPlaneJobBindings.profileVersionId,
            ),
            eq(threads.projectId, parent.projectId),
            principal?.kind === "user"
              ? eq(controlPlaneJobBindings.ownerUserId, principal.userId)
              : undefined,
            accessible
              ? sql`EXISTS (SELECT 1 FROM ${accessible} WHERE ${accessible.projectId} = ${parent.projectId})`
              : undefined,
            parsed.cursor
              ? gt(controlPlaneJobBindings.id, parsed.cursor)
              : undefined,
          ),
        )
        .orderBy(asc(controlPlaneJobBindings.id))
        .limit(parsed.limit + 1)
        .all();
      const found = rows.slice(0, parsed.limit);
      return {
        workers: found.map((row) => {
          const metadata = z
            .object({
              workflowWorker: z.literal(1),
              runId: z.literal(row.runId),
              callId: z.string().min(1).max(200),
            })
            .safeParse(
              getThreadPluginMetadata(deps.db, row.threadId, "workflows")
                .metadata,
            );
          if (row.originThreadId === null) return denied();
          return {
            threadId: row.threadId,
            parentBindingId: row.parentBindingId,
            runId: row.runId,
            callId: metadata.success ? metadata.data.callId : null,
            originThreadId: row.originThreadId,
          };
        }),
        nextCursor:
          rows.length > parsed.limit ? (found.at(-1)?.bindingId ?? null) : null,
      };
    },
    async startWorker(
      parentId: string,
      input: Parameters<InternalDoNotUseBackgroundJobs["startWorker"]>[1],
      signal?: AbortSignal,
    ) {
      if (closed) return denied();
      const parsed = inputSchema.parse(input);
      if (signal?.aborted)
        throw new Error("Workflow worker cancelled before creation");
      return withControlPlaneJobAuthority(deps.db, parentId, async (parent) => {
        if (
          parent.binding.kind !== "workflow-run" ||
          parent.binding.originThreadId === null
        )
          return denied();
        const binding = createControlPlaneJobBinding(deps.db, {
          kind: "workflow-worker",
          objectId: randomUUID(),
          revision: 1,
          userId: parent.user.id,
          projectId: parent.project.projectId,
          profileVersionId: parsed.profileVersionId ?? parent.profileVersion.id,
          originThreadId: parent.binding.originThreadId,
          sourceBindingId: parentId,
        });
        const cancel = () => {
          try {
            setControlPlaneJobEnabled(deps.db, null, binding.id, false);
          } catch (error) {
            deps.logger.warn(
              { error, bindingId: binding.id },
              "Could not fence cancelled workflow worker",
            );
          }
        };
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          if (signal?.aborted) {
            cancel();
            throw new Error("Workflow worker cancelled before creation");
          }
          const thread = await service.start(
            parent.user.id,
            {
              projectId: parent.project.projectId,
              profileVersionId: binding.profileVersionId,
              message: parsed.prompt,
              ...(parsed.title === null ? {} : { title: parsed.title }),
            },
            { bindingId: binding.id, callId: parsed.callId },
          );
          if (signal?.aborted) {
            await stop(thread.id);
            throw new Error("Workflow worker cancelled during creation");
          }
          return { threadId: thread.id, bindingId: binding.id };
        } catch (error) {
          deleteControlPlaneJobBinding(deps.db, null, binding.id);
          throw error;
        } finally {
          signal?.removeEventListener("abort", cancel);
        }
      });
    },
    async getWorker(parentId: string, threadId: string) {
      const record = read(parentId, threadId);
      const completed = listThreadEventRows(deps.db, {
        threadId,
        types: ["turn/completed"],
        limit: 1,
        order: "desc",
      })[0];
      const terminal =
        completed?.type === "turn/completed" ? completed.data : null;
      const failure =
        record.thread.status === "error"
          ? getLastThreadError(deps.db, threadId)
          : null;
      const error =
        record.thread.status === "error"
          ? failure && failure.sequence > (completed?.seq ?? 0)
            ? [failure.message, failure.detail].filter(Boolean).join("\n")
            : (terminal?.error?.message ??
              (failure
                ? [failure.message, failure.detail].filter(Boolean).join("\n")
                : "Workflow worker failed"))
          : record.thread.status === "idle" &&
              terminal &&
              terminal.status !== "completed"
            ? terminal.status === "failed"
              ? (terminal.error?.message ?? "Workflow worker failed")
              : `Workflow worker interrupted${terminal.error?.message ? `: ${terminal.error.message}` : ""}`
            : null;
      return {
        threadId,
        error: error?.slice(0, 8192) ?? null,
        idleSequence:
          record.thread.status === "idle" ? (completed?.seq ?? null) : null,
        status: record.thread.status,
        output: getLastThreadOutput(deps.db, threadId),
      };
    },
    async sendWorker(parentId: string, threadId: string, message: string) {
      read(parentId, threadId);
      await withControlPlaneJobAuthority(deps.db, parentId, async (context) => {
        requireControlPlaneThreadDispatch(deps.db, threadId);
        await service.send(context.user.id, threadId, {
          message: z.string().min(1).max(131072).parse(message),
          mode: "queue-if-active",
        });
      });
    },
    stopWorker,
    async archiveWorker(parentId: string, threadId: string) {
      if (!getThread(deps.db, threadId)) return;
      read(parentId, threadId);
      await stopWorker(parentId, threadId);
      const record = read(parentId, threadId);
      const thread = record.thread;
      if (thread.archivedAt !== null) return;
      const environment = thread.environmentId
        ? getEnvironment(deps.db, thread.environmentId)
        : null;
      withControlPlaneUser(record.owner.ownerUserId, () =>
        archiveThreadWithLifecycleEffects(deps, {
          thread,
          environment: environment
            ? { id: environment.id, hostId: environment.hostId }
            : null,
        }),
      );
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await sweep;
      service.close();
    },
  };
}
