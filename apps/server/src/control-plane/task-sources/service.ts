import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, asc, eq, gt, lte } from "drizzle-orm";
import { z } from "zod";
import {
  controlPlaneTaskSources as sources,
  controlPlaneTaskSourceItems as items,
  requireControlPlaneThreadOwner,
  getControlPlaneProject,
  type DbConnection,
} from "@bb/db";
import {
  controlPlaneTaskSourceCreateSchema,
  controlPlaneTaskSourceSchema,
  controlPlaneTaskSourceItemSchema,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import { withControlPlaneUser } from "../access.js";
import { runControlPlaneManagedScript } from "../automation-script-runner.js";
import type { ControlPlaneAgentWorkflowService } from "../agent-workflows.js";
import { taskSourceBatchSchema, type TaskSourceAdapter } from "./adapter.js";
import { beadsTaskSourceAdapter } from "./beads.js";
const exec = promisify(execFile);
type Source = typeof sources.$inferSelect;
export function createControlPlaneTaskSourceService(
  db: DbConnection,
  agents: Pick<ControlPlaneAgentWorkflowService, "start">,
  options: {
    adapters?: readonly TaskSourceAdapter[];
    run?: (
      source: Source,
      code: string,
      signal: AbortSignal,
      check: () => void,
    ) => Promise<string>;
    now?: () => number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const adapters = new Map(
    (options.adapters ?? [beadsTaskSourceAdapter]).map((adapter) => [
      adapter.kind,
      adapter,
    ]),
  );
  const active = new Map<
    string,
    { controller: AbortController; task: Promise<void> }
  >();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const view = (row: Source) =>
    controlPlaneTaskSourceSchema.parse({
      id: row.id,
      projectId: row.projectId,
      profileVersionId: row.profileVersionId,
      kind: row.kind,
      name: row.name,
      intervalSeconds: row.intervalSeconds,
      enabled: row.enabled,
      checkpoint: row.checkpoint,
      nextPollAt: row.nextPollAt,
      lastPollAt: row.lastPollAt,
      failures: row.failures,
      error: row.error,
      createdAt: row.createdAt,
    });
  function owned(userId: string, id: string) {
    const row = db
      .select()
      .from(sources)
      .where(and(eq(sources.id, id), eq(sources.ownerUserId, userId)))
      .get();
    if (!row || !getControlPlaneProject(db, userId, row.projectId))
      throw new ApiError(404, "source_not_found", "Task source not found");
    return row;
  }
  function authority(row: Source) {
    const context = requireControlPlaneThreadOwner(db, {
      projectId: row.projectId,
      ownerUserId: row.ownerUserId,
      profileVersionId: row.profileVersionId,
      providerId: "qwen-server",
      relatedThreadIds: [],
    });
    if (!context) throw new Error("Task source execution denied");
    return context;
  }
  function check(row: Source, signal: AbortSignal) {
    signal.throwIfAborted();
    const current = db
      .select()
      .from(sources)
      .where(eq(sources.id, row.id))
      .get();
    if (closed || !current?.enabled) throw new Error("Task source paused");
    return authority(row);
  }
  async function managedRun(row: Source, code: string, signal: AbortSignal) {
    const context = check(row, signal);
    await exec(
      "/usr/bin/sudo",
      [
        "-n",
        "--",
        "/opt/bb-control-plane/launcher/helper.py",
        "stop",
        context.user.id,
        String(context.user.uid),
        row.readerJobId,
      ],
      {
        cwd: "/tmp",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
        timeout: 12000,
        maxBuffer: 16384,
      },
    );
    check(row, signal);
    const jobId = randomUUID();
    db.update(sources)
      .set({ readerJobId: jobId })
      .where(eq(sources.id, row.id))
      .run();
    const result = await runControlPlaneManagedScript(
      db,
      () => {
        const current = check(row, signal);
        return {
          user: {
            id: current.user.id,
            uid: current.user.uid,
            home: current.user.home,
          },
          project: { projectId: row.projectId, cwd: current.project.cwd },
          maintenanceGeneration: current.maintenanceGeneration,
          policyIdentity: JSON.stringify([row.id, row.profileVersionId]),
        };
      },
      { jobId, source: code, timeoutMs: 30000 },
      signal,
    );
    if (result.status !== "succeeded")
      throw new Error("Task source read failed");
    return result.stdout;
  }
  async function admit(row: Source, signal: AbortSignal) {
    const pending = db
      .select()
      .from(items)
      .where(and(eq(items.sourceId, row.id), eq(items.state, "pending")))
      .orderBy(asc(items.id))
      .limit(10)
      .all();
    for (const item of pending) {
      check(row, signal);
      try {
        const run = await withControlPlaneUser(row.ownerUserId, () =>
          agents.start(row.ownerUserId, {
            projectId: row.projectId,
            profileVersionId: row.profileVersionId,
            input: item.input,
            source: "manual",
            idempotencyKey: `task-source:${item.id}`,
          }),
        );
        db.update(items)
          .set({ state: "accepted", runId: run.runId, error: null })
          .where(eq(items.id, item.id))
          .run();
      } catch {
        db.update(items)
          .set({ error: "launch_not_available" })
          .where(eq(items.id, item.id))
          .run();
        throw new Error("Admission failed");
      }
    }
  }
  async function poll(row: Source, signal: AbortSignal) {
    try {
      check(row, signal);
      await admit(row, signal);
      check(row, signal);
      if (
        !db
          .select({ id: items.id })
          .from(items)
          .where(and(eq(items.sourceId, row.id), eq(items.state, "pending")))
          .limit(1)
          .get()
      ) {
        const adapter = adapters.get(row.kind);
        if (!adapter) throw new Error("Adapter unavailable");
        const batch = taskSourceBatchSchema.parse(
          await adapter.poll({
            sourceId: row.id,
            userId: row.ownerUserId,
            projectId: row.projectId,
            checkpoint: row.checkpoint,
            signal,
            run: (code) =>
              options.run
                ? options.run(row, code, signal, () => {
                    check(row, signal);
                  })
                : managedRun(row, code, signal),
          }),
        );
        check(row, signal);
        if (Buffer.byteLength(JSON.stringify(batch)) > 1048576)
          throw new Error("Batch exceeds limit");
        if (
          new Set(batch.tasks.map((task) => task.id)).size !==
          batch.tasks.length
        )
          throw new Error("Duplicate task ID");
        db.transaction((tx) => {
          for (const task of batch.tasks)
            tx.insert(items)
              .values({
                id: randomUUID(),
                sourceId: row.id,
                externalId: task.id,
                title: task.title,
                input: task.input,
                createdAt: now(),
              })
              .onConflictDoNothing({
                target: [items.sourceId, items.externalId],
              })
              .run();
          tx.update(sources)
            .set({ checkpoint: batch.checkpoint })
            .where(eq(sources.id, row.id))
            .run();
        });
        await admit(row, signal);
      }
      db.update(sources)
        .set({
          failures: 0,
          error: null,
          lastPollAt: now(),
          nextPollAt: now() + row.intervalSeconds * 1000,
        })
        .where(eq(sources.id, row.id))
        .run();
    } catch {
      if (closed || signal.aborted) return;
      const failures = Math.min(row.failures + 1, 20);
      db.update(sources)
        .set({
          failures,
          error: "poll_or_admission_failed",
          lastPollAt: now(),
          nextPollAt:
            now() +
            Math.min(
              Math.max(3600000, row.intervalSeconds * 1000),
              row.intervalSeconds * 1000 * 2 ** Math.min(failures, 10),
            ),
        })
        .where(eq(sources.id, row.id))
        .run();
    }
  }
  function launch(row: Source) {
    const previous = active.get(row.id);
    if (previous) return previous.task;
    if (closed || active.size >= 4) return Promise.resolve();
    const controller = new AbortController();
    const task = poll(row, controller.signal).finally(() =>
      active.delete(row.id),
    );
    active.set(row.id, { controller, task });
    return task;
  }
  async function tick() {
    if (closed) return;
    const due = db
      .select()
      .from(sources)
      .where(and(eq(sources.enabled, true), lte(sources.nextPollAt, now())))
      .orderBy(asc(sources.nextPollAt))
      .limit(4)
      .all();
    await Promise.all(due.map(launch));
  }
  return {
    create(
      userId: string,
      input: z.input<typeof controlPlaneTaskSourceCreateSchema>,
    ) {
      const value = controlPlaneTaskSourceCreateSchema.parse(input);
      const row = {
        ...value,
        id: randomUUID(),
        ownerUserId: userId,
        enabled: false,
        checkpoint: null,
        nextPollAt: now(),
        lastPollAt: null,
        failures: 0,
        error: null,
        readerJobId: randomUUID(),
        createdAt: now(),
      };
      authority(row);
      const saved = db
        .insert(sources)
        .values(row)
        .onConflictDoNothing({ target: [sources.projectId, sources.kind] })
        .returning()
        .get();
      if (!saved)
        throw new ApiError(
          409,
          "source_exists",
          "This project already has a task source of this kind",
        );
      return view(saved);
    },
    get(userId: string, id: string) {
      return view(owned(userId, id));
    },
    list(userId: string, projectId: string, cursor?: string) {
      if (!getControlPlaneProject(db, userId, projectId))
        throw new ApiError(404, "project_not_found", "Project not found");
      const rows = db
        .select()
        .from(sources)
        .where(
          and(
            eq(sources.ownerUserId, userId),
            eq(sources.projectId, projectId),
            cursor ? gt(sources.id, cursor) : undefined,
          ),
        )
        .orderBy(asc(sources.id))
        .limit(21)
        .all();
      return {
        sources: rows.slice(0, 20).map(view),
        nextCursor: rows.length > 20 ? rows[19].id : null,
      };
    },
    setEnabled(userId: string, id: string, enabled: boolean) {
      const row = owned(userId, id);
      if (enabled) authority(row);
      else active.get(id)?.controller.abort();
      return view(
        db
          .update(sources)
          .set({ enabled, nextPollAt: now() })
          .where(eq(sources.id, id))
          .returning()
          .get(),
      );
    },
    async pollNow(userId: string, id: string) {
      const row = owned(userId, id);
      if (!row.enabled)
        throw new ApiError(
          409,
          "source_paused",
          "Enable the task source first",
        );
      authority(row);
      await launch(row);
      return view(owned(userId, id));
    },
    history(userId: string, id: string, cursor?: string) {
      owned(userId, id);
      const rows = db
        .select()
        .from(items)
        .where(
          and(
            eq(items.sourceId, id),
            cursor ? gt(items.id, cursor) : undefined,
          ),
        )
        .orderBy(asc(items.id))
        .limit(21)
        .all();
      return {
        items: rows
          .slice(0, 20)
          .map((row) => controlPlaneTaskSourceItemSchema.parse(row)),
        nextCursor: rows.length > 20 ? rows[19].id : null,
      };
    },
    tick,
    start() {
      if (!timer && !closed) {
        timer = setInterval(() => {
          void tick().catch(() => {});
        }, 1000);
        timer.unref();
      }
    },
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      for (const item of active.values()) item.controller.abort();
    },
  };
}
export type ControlPlaneTaskSourceService = ReturnType<
  typeof createControlPlaneTaskSourceService
>;
