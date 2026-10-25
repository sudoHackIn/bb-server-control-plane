import type { InternalDoNotUseBackgroundJobs } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { AutomationService, ServiceApi } from "./service.js";
import { applyAgentExecutionUpdate } from "./service.js";
import {
  claimAutomationScheduledRun,
  closeAutomationRun,
  createAutomation,
  createManualRun,
  decodeAutomationRow,
  deleteAutomation,
  getAutomation,
  getAutomationRun,
  listAutomationRuns,
  listDueAutomations,
  listRunningAutomationRuns,
  markAutomationThread,
  parseAutomationExecution,
  parseAutomationTrigger,
  setAutomationEnabled,
  setAutomationRunThread,
  toAutomationResponse,
  toAutomationRunResponse,
  updateAutomation,
  type AutomationRow,
  type AutomationRunRow,
  type Db,
} from "./data.js";
import {
  type AutomationResponse,
  automationExecutionSchema,
  type AutomationExecution,
  type AutomationTrigger,
} from "./rpc-types.js";
import { createAutomationId } from "./ids.js";
import {
  computeInitialNextRunAt,
  computeNextScheduledTime,
  validateOnceDefinition,
  validateScheduleDefinition,
} from "./schedule-helpers.js";
import { publishAutomationChange } from "./realtime.js";

const authoritySchema = z.object({
  automationId: z.string(),
  ownerUserId: z.string().uuid(),
  bindingId: z.string().uuid(),
  revision: z.number().int().positive(),
});
const runAuthoritySchema = z.object({
  runId: z.string(),
  automationId: z.string(),
  definitionBindingId: z.string().uuid(),
  definitionRevision: z.number().int().positive(),
  executionJson: z.string(),
  bindingId: z.string().uuid().nullable(),
});
function detail(value: AutomationResponse) {
  return value.execution.mode === "script"
    ? {
        ...value,
        execution: { ...value.execution, resolvedWorkingDirectory: null },
      }
    : { ...value, execution: value.execution };
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createManagedAutomationService({
  bb,
  db,
  jobs,
}: {
  bb: ServiceApi;
  db: Db;
  jobs: InternalDoNotUseBackgroundJobs;
}): AutomationService {
  const dispatching = new Set<string>();
  let ticking = false;
  let lifecycleSignal: AbortSignal | undefined;
  function head(row: AutomationRow) {
    const raw = db
      .prepare(
        `SELECT automation_id AS automationId,owner_user_id AS ownerUserId,binding_id AS bindingId,revision FROM automation_authorities WHERE automation_id=?${jobs.userId === null ? "" : " AND owner_user_id=?"}`,
      )
      .get(...(jobs.userId === null ? [row.id] : [row.id, jobs.userId]));
    if (!raw)
      throw new Error(
        jobs.userId === null
          ? "Automation requires an explicit owner assignment"
          : "Automation not found",
      );
    const saved = authoritySchema.parse(raw);
    const binding = jobs.get(saved.bindingId);
    if (
      !binding ||
      binding.kind !== "automation" ||
      binding.objectId !== row.id ||
      binding.revision !== 1 ||
      binding.ownerUserId !== saved.ownerUserId ||
      binding.projectId !== row.projectId ||
      binding.originThreadId !== row.createdByThreadId ||
      binding.deletedAt !== null
    )
      throw new Error("Automation not found");
    return { ...saved, binding };
  }
  function required(input: { automationId: string; projectId: string }) {
    const row = getAutomation(db, input.automationId, jobs.userId ?? undefined);
    if (!row || row.projectId !== input.projectId)
      throw new Error("Automation not found");
    if (jobs.userId !== null) head(row);
    return row;
  }
  function validate(trigger: AutomationTrigger, now: number) {
    if (trigger.triggerType === "once")
      validateOnceDefinition({ runAt: trigger.runAt, now });
    else
      validateScheduleDefinition({
        cron: trigger.cron,
        timezone: trigger.timezone,
      });
  }
  function execution(
    row: Pick<AutomationRow, "projectId" | "createdByThreadId">,
    value: AutomationExecution,
  ) {
    if (!row.createdByThreadId)
      throw new Error("Managed automations require an owned origin thread");
    const origin = jobs.readOrigin(row.createdByThreadId);
    if (origin.projectId !== row.projectId)
      throw new Error("Automation origin project mismatch");
    if (value.mode !== "agent")
      throw new Error(
        "Managed script automations require the isolated script launcher",
      );
    if (value.targetThreadId !== undefined)
      throw new Error("Managed target-thread automations are not supported");
    if (value.serviceTier !== undefined)
      throw new Error(
        "Managed automation service tier overrides are not supported",
      );
    if (
      value.providerId !== origin.providerId ||
      value.model !== origin.model ||
      value.reasoningLevel !== origin.reasoningLevel ||
      value.permissionMode !== origin.permissionMode
    )
      throw new Error(
        "Automation execution must match the origin's approved profile",
      );
    if (
      value.environment.type === "host" ||
      (value.environment.type === "reuse" &&
        value.environment.environmentId !== origin.environmentId)
    )
      throw new Error(
        "Automation environment must use the owned origin or project default",
      );
    if (Buffer.byteLength(value.prompt, "utf8") > 131072)
      throw new Error("Automation prompt exceeds 128 KiB");
    return value;
  }
  function rows(input: { projectId?: string; targetThreadId?: string }) {
    const ids = db
      .prepare(
        `SELECT a.id FROM automations a ${jobs.userId === null ? "" : "JOIN automation_authorities o ON o.automation_id=a.id"} WHERE 1=1 ${jobs.userId === null ? "" : "AND o.owner_user_id=@owner"} ${input.projectId ? "AND a.project_id=@project" : ""} ${input.targetThreadId ? "AND a.target_thread_id=@target" : ""} ORDER BY a.created_at DESC,a.id DESC`,
      )
      .all({
        owner: jobs.userId,
        project: input.projectId ?? null,
        target: input.targetThreadId ?? null,
      });
    return z
      .array(z.object({ id: z.string() }))
      .parse(ids)
      .flatMap(({ id }) => {
        const row = getAutomation(db, id);
        if (!row) return [];
        try {
          if (jobs.userId !== null) head(row);
          return [row];
        } catch {
          return [];
        }
      });
  }
  function emit(row: AutomationRow) {
    publishAutomationChange(bb, row.projectId, [
      "automations-changed",
      "automation-runs-changed",
    ]);
  }
  function runHead(id: string) {
    const raw = db
      .prepare(
        "SELECT run_id AS runId,automation_id AS automationId,definition_binding_id AS definitionBindingId,definition_revision AS definitionRevision,execution_json AS executionJson,binding_id AS bindingId FROM automation_run_authorities WHERE run_id=?",
      )
      .get(id);
    return raw ? runAuthoritySchema.parse(raw) : null;
  }
  function recordVersion(row: AutomationRow, revision: number) {
    db.prepare(
      "INSERT INTO automation_versions(automation_id,revision,execution_json,definition_json) VALUES(?,?,?,?)",
    ).run(
      row.id,
      revision,
      row.execution,
      JSON.stringify({
        projectId: row.projectId,
        originThreadId: row.createdByThreadId,
        name: row.name,
        trigger: parseAutomationTrigger(row.triggerConfig),
        execution: parseAutomationExecution(row.execution),
      }),
    );
  }
  function snapshot(row: AutomationRow, run: AutomationRunRow) {
    const saved = head(row);
    db.prepare(
      "INSERT INTO automation_run_authorities(run_id,automation_id,definition_binding_id,definition_revision,execution_json) VALUES(?,?,?,?,?)",
    ).run(run.id, row.id, saved.bindingId, saved.revision, row.execution);
  }
  async function dispatch(row: AutomationRow, run: AutomationRunRow) {
    dispatching.add(run.id);
    let parentId: string | null = null;
    try {
      const saved = runHead(run.id);
      if (!saved) throw new Error("Automation run is missing saved authority");
      const version = z
        .object({ executionJson: z.string() })
        .parse(
          db
            .prepare(
              "SELECT execution_json AS executionJson FROM automation_versions WHERE automation_id=? AND revision=?",
            )
            .get(row.id, saved.definitionRevision),
        );
      if (version.executionJson !== saved.executionJson)
        throw new Error("Automation run version mismatch");
      await jobs.withAuthority(saved.definitionBindingId, async (root) => {
        const selected = execution(
          row,
          automationExecutionSchema.parse(JSON.parse(saved.executionJson)),
        );
        const binding = await jobs.bind({
          kind: "automation-run",
          objectId: run.id,
          revision: 1,
          projectId: root.projectId,
          originThreadId: root.originThreadId,
          profileVersionId: root.profileVersionId,
          sourceBindingId: root.id,
        });
        parentId = binding.id;
        db.prepare(
          "UPDATE automation_run_authorities SET binding_id=? WHERE run_id=? AND binding_id IS NULL",
        ).run(binding.id, run.id);
        const worker = await jobs.startWorker(
          binding.id,
          {
            callId: run.id,
            prompt: `[bb automation due:${row.id}]\n\n${selected.prompt}`,
            title: row.name,
            profileVersionId: null,
          },
          lifecycleSignal,
        );
        setAutomationRunThread(db, {
          runId: run.id,
          threadId: worker.threadId,
        });
        markAutomationThread(db, {
          automationId: row.id,
          runId: run.id,
          threadId: worker.threadId,
          now: Date.now(),
        });
      });
    } catch (error) {
      closeAutomationRun(db, {
        runId: run.id,
        status: "failed",
        error: message(error),
        now: Date.now(),
      });
      if (parentId)
        await jobs
          .setEnabled(parentId, false)
          .catch((cleanup: unknown) =>
            bb.log.error(
              `Cannot fence automation run ${run.id}: ${message(cleanup)}`,
            ),
          );
    } finally {
      dispatching.delete(run.id);
      emit(row);
    }
  }
  async function releaseCompletedRuntimes() {
    const pending = z
      .array(
        z.object({
          runId: z.string(),
          bindingId: z.string().uuid(),
          threadId: z.string(),
          sequence: z.number().int().nonnegative(),
        }),
      )
      .parse(
        db
          .prepare(`SELECT a.run_id AS runId,a.binding_id AS bindingId,r.thread_id AS threadId,a.completed_sequence AS sequence
      FROM automation_run_authorities a JOIN automation_runs r ON r.id=a.run_id
      WHERE r.status='succeeded' AND a.binding_id IS NOT NULL AND r.thread_id IS NOT NULL
      AND a.completed_sequence IS NOT NULL AND a.runtime_released_at IS NULL AND a.runtime_retained=0
      ORDER BY a.run_id LIMIT 100`)
          .all(),
      );
    for (const saved of pending) {
      try {
        const worker = await jobs.getWorker(saved.bindingId, saved.threadId);
        if (
          worker.status !== "idle" ||
          worker.idleSequence !== saved.sequence
        ) {
          db.prepare(
            "UPDATE automation_run_authorities SET runtime_retained=1 WHERE run_id=?",
          ).run(saved.runId);
          continue;
        }
        if (
          await jobs.releaseWorker(
            saved.bindingId,
            saved.threadId,
            saved.sequence,
          )
        )
          db.prepare(
            "UPDATE automation_run_authorities SET runtime_released_at=? WHERE run_id=?",
          ).run(Date.now(), saved.runId);
      } catch (error) {
        bb.log.warn(
          `Cannot release completed automation runtime ${saved.runId}: ${message(error)}`,
        );
      }
    }
  }
  async function reconcile(startup: boolean) {
    let workers: Awaited<
      ReturnType<InternalDoNotUseBackgroundJobs["listWorkers"]>
    >["workers"] = [];
    if (startup) {
      let cursor: string | null = null;
      do {
        const page = jobs.listWorkers({
          cursor,
          limit: 100,
          includeArchived: false,
        });
        workers.push(...page.workers);
        cursor = page.nextCursor;
      } while (cursor);
    }
    for (const run of listRunningAutomationRuns(db)) {
      if (dispatching.has(run.id)) continue;
      const saved = runHead(run.id);
      const row = getAutomation(db, run.automationId);
      if (!row) continue;
      let threadId = run.threadId;
      try {
        if (!saved?.bindingId)
          throw new Error(
            "Automation run has no durable execution authority after restart",
          );
        if (!threadId && startup) {
          const found = workers.find(
            (worker) =>
              worker.parentBindingId === saved.bindingId &&
              worker.runId === run.id,
          );
          if (found) {
            threadId = found.threadId;
            setAutomationRunThread(db, { runId: run.id, threadId });
            markAutomationThread(db, {
              automationId: row.id,
              runId: run.id,
              threadId,
              now: Date.now(),
            });
          }
        }
        if (!threadId) {
          if (!startup) continue;
          throw new Error(
            "Automation dispatch was interrupted before an owned worker was attached",
          );
        }
        jobs.withAuthority(saved.bindingId, () => undefined);
        const worker = await jobs.getWorker(saved.bindingId, threadId);
        if (worker.error || worker.status === "error")
          throw new Error(worker.error ?? "Automation worker failed");
        if (worker.status === "idle" && worker.idleSequence !== null) {
          db.transaction(() => {
            closeAutomationRun(db, {
              runId: run.id,
              status: "succeeded",
              output: worker.output,
              threadId,
              now: Date.now(),
            });
            db.prepare(
              "UPDATE automation_run_authorities SET completed_sequence=? WHERE run_id=?",
            ).run(worker.idleSequence, run.id);
          }).immediate();
          emit(row);
        }
      } catch (error) {
        if (saved?.bindingId && threadId)
          await jobs
            .stopWorker(saved.bindingId, threadId)
            .catch((cleanup: unknown) =>
              bb.log.error(
                `Cannot stop automation ${run.id}: ${message(cleanup)}`,
              ),
            );
        closeAutomationRun(db, {
          runId: run.id,
          status: "failed",
          error: message(error),
          now: Date.now(),
        });
        emit(row);
      }
    }
  }
  return {
    async managedTick(startup, signal) {
      if (jobs.userId !== null)
        throw new Error("Managed automation sweep requires service scope");
      if (signal.aborted) return;
      lifecycleSignal = signal;
      if (ticking) return;
      ticking = true;
      try {
        if (startup)
          db.prepare(
            "UPDATE automations SET enabled=0,next_run_at=NULL,last_error='Owner assignment required before managed execution' WHERE NOT EXISTS (SELECT 1 FROM automation_authorities o WHERE o.automation_id=automations.id)",
          ).run();
        await reconcile(startup);
        await releaseCompletedRuntimes();
        for (const row of listDueAutomations(db, {
          now: Date.now(),
          limit: 100,
        })) {
          if (signal.aborted) break;
          try {
            const root = head(row);
            const claim = jobs.withAuthority(root.bindingId, () =>
              db
                .transaction(() => {
                  const current = getAutomation(db, row.id);
                  if (!current || current.nextRunAt === null) return null;
                  const trigger = parseAutomationTrigger(current.triggerConfig);
                  execution(
                    current,
                    parseAutomationExecution(current.execution),
                  );
                  const result = claimAutomationScheduledRun(db, {
                    automationId: current.id,
                    expectedNextRunAt: current.nextRunAt,
                    newNextRunAt:
                      trigger.triggerType === "once"
                        ? null
                        : computeNextScheduledTime({
                            ...trigger,
                            now: Date.now(),
                          }),
                    now: Date.now(),
                  });
                  if (result.advanced) snapshot(current, result.run);
                  return result;
                })
                .immediate(),
            );
            if (claim?.advanced)
              void dispatch(claim.automation, claim.run).catch(
                (error: unknown) =>
                  bb.log.error(
                    `Managed automation dispatch failed: ${message(error)}`,
                  ),
              );
          } catch (error) {
            setAutomationEnabled(db, {
              automationId: row.id,
              projectId: row.projectId,
              enabled: false,
              nextRunAt: null,
              lastError: message(error),
            });
            emit(row);
          }
        }
      } finally {
        ticking = false;
      }
    },
    async overview() {
      return {
        automations: rows({}).map((row) => ({
          automation: decodeAutomationRow(row).automation,
          project: { id: row.projectId, name: row.projectId },
        })),
      };
    },
    list(input) {
      return rows(input).map((row) => decodeAutomationRow(row).automation);
    },
    async get(input) {
      const value = decodeAutomationRow(required(input)).automation;
      return "problem" in value ? value : detail(value);
    },
    async create(input) {
      const now = Date.now();
      validate(input.trigger, now);
      const value = execution(
        {
          projectId: input.projectId,
          createdByThreadId: input.createdByThreadId ?? null,
        },
        input.execution.mode === "agent"
          ? input.execution
          : automationExecutionSchema.parse(input.execution),
      );
      if (
        input.createdByThreadId &&
        db
          .prepare("SELECT 1 FROM automation_thread_marks WHERE thread_id=?")
          .get(input.createdByThreadId)
      )
        throw new Error("Automation-spawned threads cannot create automations");
      const id = createAutomationId();
      const binding = await jobs.bind({
        kind: "automation",
        objectId: id,
        revision: 1,
        projectId: input.projectId,
        originThreadId: input.createdByThreadId ?? null,
        profileVersionId: null,
        sourceBindingId: null,
      });
      let created: AutomationRow;
      try {
        created = jobs.withAuthority(binding.id, () =>
          db
            .transaction(() => {
              const row = createAutomation(db, {
                ...input,
                id,
                execution: value,
                runMode: "agent",
                createdByThreadId: input.createdByThreadId ?? null,
                nextRunAt: computeInitialNextRunAt({
                  trigger: input.trigger,
                  enabled: input.enabled,
                  now,
                }),
              });
              db.prepare(
                "INSERT INTO automation_authorities(automation_id,owner_user_id,binding_id,revision) VALUES(?,?,?,1)",
              ).run(id, binding.ownerUserId, binding.id);
              recordVersion(row, 1);
              return row;
            })
            .immediate(),
        );
        if (!input.enabled) await jobs.setEnabled(binding.id, false);
      } catch (error) {
        await jobs.remove(binding.id);
        throw error;
      }
      emit(created);
      return detail(toAutomationResponse(created));
    },
    async update(input) {
      const row = required(input),
        root = head(row);
      const canonical = toAutomationResponse(row);
      if (input.script)
        throw new Error(
          "Managed script automations require the isolated script launcher",
        );
      const value = execution(
        row,
        input.execution
          ? input.execution.mode === "agent"
            ? input.execution
            : automationExecutionSchema.parse(input.execution)
          : input.agent
            ? applyAgentExecutionUpdate(canonical.execution, input.agent)
            : canonical.execution,
      );
      const now = Date.now();
      if (input.trigger) validate(input.trigger, now);
      const updated = db
        .transaction(() => {
          if (head(row).revision !== root.revision)
            throw new Error("Automation revision conflict");
          const next = updateAutomation(db, {
            projectId: row.projectId,
            automationId: row.id,
            patch: {
              ...(input.name ? { name: input.name } : {}),
              execution: value,
              ...(input.trigger
                ? {
                    trigger: input.trigger,
                    nextRunAt: computeInitialNextRunAt({
                      trigger: input.trigger,
                      enabled: row.enabled,
                      now,
                    }),
                  }
                : {}),
            },
          });
          if (!next) throw new Error("Automation not found");
          db.prepare(
            "UPDATE automation_authorities SET revision=revision+1 WHERE automation_id=? AND revision=?",
          ).run(row.id, root.revision);
          recordVersion(next, root.revision + 1);
          return next;
        })
        .immediate();
      emit(updated);
      return detail(toAutomationResponse(updated));
    },
    async delete(input) {
      const row = required(input);
      const raw = db
        .prepare("SELECT 1 FROM automation_authorities WHERE automation_id=?")
        .get(row.id);
      if (raw) await jobs.remove(head(row).bindingId);
      else if (jobs.userId !== null) throw new Error("Automation not found");
      deleteAutomation(db, input);
      emit(row);
      return { ok: true };
    },
    async pause(input) {
      const row = required(input);
      await jobs.setEnabled(head(row).bindingId, false);
      const next = setAutomationEnabled(db, {
        ...input,
        enabled: false,
        nextRunAt: null,
      });
      if (!next) throw new Error("Automation not found");
      emit(next);
      return toAutomationResponse(next);
    },
    async resume(input) {
      const row = required(input),
        root = head(row);
      execution(row, parseAutomationExecution(row.execution));
      const trigger = parseAutomationTrigger(row.triggerConfig),
        now = Date.now();
      validate(trigger, now);
      await jobs.setEnabled(root.bindingId, true);
      const next = setAutomationEnabled(db, {
        ...input,
        enabled: true,
        nextRunAt: computeInitialNextRunAt({ trigger, enabled: true, now }),
        lastError: null,
        resetConsecutiveFailures: true,
      });
      if (!next) throw new Error("Automation not found");
      emit(next);
      return toAutomationResponse(next);
    },
    async run(input) {
      const row = required(input),
        root = head(row);
      const result = jobs.withAuthority(root.bindingId, () =>
        db
          .transaction(() => {
            execution(row, parseAutomationExecution(row.execution));
            const claim = createManualRun(db, {
              automationId: row.id,
              runMode: row.runMode,
              idempotencyKey: input.idempotencyKey ?? null,
              now: Date.now(),
            });
            if (!claim.deduped) snapshot(row, claim.run);
            return claim;
          })
          .immediate(),
      );
      if (!result.deduped) await dispatch(row, result.run);
      return {
        run: toAutomationRunResponse(
          getAutomationRun(db, result.run.id) ?? result.run,
        ),
      };
    },
    runs(input) {
      required(input);
      let cursor: { startedAt: number; id: string } | null = null;
      if (input.cursor) {
        const raw = Buffer.from(input.cursor, "base64url").toString("utf8"),
          separator = raw.indexOf(":"),
          startedAt = Number(raw.slice(0, separator)),
          id = raw.slice(separator + 1);
        if (separator < 1 || !Number.isSafeInteger(startedAt) || !id)
          throw new Error("Invalid runs cursor");
        cursor = { startedAt, id };
      }
      const page = listAutomationRuns(db, {
        automationId: input.automationId,
        limit: input.limit + 1,
        cursor,
      });
      const rows = page.slice(0, input.limit),
        last = rows.at(-1);
      return {
        runs: rows.map(toAutomationRunResponse),
        nextCursor:
          page.length > input.limit && last
            ? Buffer.from(`${last.startedAt}:${last.id}`, "utf8").toString(
                "base64url",
              )
            : null,
      };
    },
  };
}
