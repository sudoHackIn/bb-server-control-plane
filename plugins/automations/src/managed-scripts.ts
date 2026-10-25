import type { InternalDoNotUseBackgroundJobs } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  closeAutomationRun,
  getAutomationRun,
  type AutomationRow,
  type AutomationRunRow,
  type Db,
} from "./data.js";

const attemptSchema = z.object({
  jobId: z.string().uuid(),
  cleanupError: z.string().nullable(),
  outcomeError: z.string().nullable(),
});
type ScriptResult = Awaited<
  ReturnType<InternalDoNotUseBackgroundJobs["runAutomationScript"]>
>;
function message(error: unknown) {
  return error instanceof Error
    ? error.message.slice(0, 4096)
    : "Script execution failed";
}

export function createManagedScripts(
  db: Db,
  jobs: InternalDoNotUseBackgroundJobs,
  emit: (row: AutomationRow) => void,
) {
  const active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  function attempt(runId: string) {
    const value = db
      .prepare(
        "SELECT job_id AS jobId,cleanup_error AS cleanupError,outcome_error AS outcomeError FROM automation_script_attempts WHERE run_id=?",
      )
      .get(runId);
    return value ? attemptSchema.parse(value) : null;
  }
  function checkedAttempt(row: AutomationRow, run: AutomationRunRow) {
    const saved = attempt(run.id);
    const authority = z
      .object({
        bindingId: z.string().uuid(),
        definitionBindingId: z.string().uuid(),
      })
      .parse(
        db
          .prepare(
            "SELECT binding_id AS bindingId,definition_binding_id AS definitionBindingId FROM automation_run_authorities WHERE run_id=? AND automation_id=?",
          )
          .get(run.id, row.id),
      );
    const binding = saved ? jobs.get(saved.jobId) : null;
    if (
      !saved ||
      authority.bindingId !== saved.jobId ||
      binding?.kind !== "automation-run" ||
      binding.objectId !== run.id ||
      binding.projectId !== row.projectId ||
      binding.sourceBindingId !== authority.definitionBindingId
    )
      throw new Error("Script process authority mismatch");
    return saved;
  }
  function cancelled(runId: string) {
    return !!db
      .prepare(
        "SELECT 1 FROM automation_run_authorities WHERE run_id=? AND cancel_requested_at IS NOT NULL",
      )
      .get(runId);
  }
  function finish(
    row: AutomationRow,
    run: AutomationRunRow,
    result: ScriptResult | null,
    error: string | null,
  ) {
    db.transaction(() => {
      if (getAutomationRun(db, run.id)?.status !== "running") return;
      db.prepare(
        "UPDATE automation_script_attempts SET cleanup_error=NULL,result_json=? WHERE run_id=?",
      ).run(result ? JSON.stringify(result) : null, run.id);
      const status =
        cancelled(run.id) || result?.status === "cancelled"
          ? "cancelled"
          : result?.status === "succeeded"
            ? "succeeded"
            : "failed";
      closeAutomationRun(db, {
        runId: run.id,
        status,
        output: result ? JSON.stringify(result) : null,
        exitCode: result?.exitCode ?? null,
        error:
          status === "failed"
            ? (error ??
              `Script ${result?.status ?? "interrupted before completion"}`)
            : null,
        now: Date.now(),
      });
    }).immediate();
    emit(row);
  }
  async function recover(row: AutomationRow, run: AutomationRunRow) {
    if (active.has(run.id)) return;
    try {
      const saved = checkedAttempt(row, run);
      await jobs.stopAutomationScript(saved.jobId);
      finish(
        row,
        run,
        null,
        saved.outcomeError ??
          "Script interrupted before completion; explicit retry required",
      );
    } catch (error) {
      db.prepare(
        "UPDATE automation_script_attempts SET cleanup_error=? WHERE run_id=?",
      ).run(message(error), run.id);
    }
  }
  return {
    has(runId: string) {
      return attempt(runId) !== null;
    },
    async reconcile(row: AutomationRow, run: AutomationRunRow) {
      await recover(row, run);
    },
    launch(
      row: AutomationRow,
      run: AutomationRunRow,
      jobId: string,
      input: { source: string; timeoutMs: number },
      lifecycle: AbortSignal | undefined,
    ) {
      db.prepare(
        "INSERT INTO automation_script_attempts(run_id,job_id) VALUES(?,?)",
      ).run(run.id, jobId);
      const controller = new AbortController();
      const signal = lifecycle
        ? AbortSignal.any([controller.signal, lifecycle])
        : controller.signal;
      const done = Promise.resolve().then(async () => {
        try {
          const result = await jobs.runAutomationScript(jobId, input, signal);
          if (result.jobId !== jobId)
            throw new Error("Script process identity mismatch");
          finish(row, run, result, null);
        } catch (error) {
          db.prepare(
            "UPDATE automation_script_attempts SET outcome_error=COALESCE(outcome_error,?) WHERE run_id=?",
          ).run(message(error), run.id);
          try {
            await jobs.stopAutomationScript(jobId);
            finish(row, run, null, message(error));
          } catch (cleanup) {
            db.prepare(
              "UPDATE automation_script_attempts SET cleanup_error=? WHERE run_id=?",
            ).run(message(cleanup), run.id);
          }
        } finally {
          active.delete(run.id);
        }
      });
      active.set(run.id, { controller, done });
      void done.catch(() => {});
    },
    async stop(row: AutomationRow, run: AutomationRunRow) {
      const runId = run.id;
      const saved = checkedAttempt(row, run);
      const running = active.get(runId);
      running?.controller.abort();
      try {
        await jobs.stopAutomationScript(saved.jobId);
        if (running) await running.done;
        db.prepare(
          "UPDATE automation_script_attempts SET cleanup_error=NULL WHERE run_id=?",
        ).run(runId);
      } catch (error) {
        db.prepare(
          "UPDATE automation_script_attempts SET cleanup_error=? WHERE run_id=?",
        ).run(message(error), runId);
        throw error;
      }
    },
    async shutdown() {
      const running = [...active.values()];
      for (const item of running) item.controller.abort();
      await Promise.allSettled(running.map((item) => item.done));
    },
  };
}
