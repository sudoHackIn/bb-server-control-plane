import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createConnection } from "@bb/db";
import { z } from "zod";
import { createControlPlaneBackgroundJobs } from "../../src/control-plane/background-jobs.js";
import { withControlPlaneUser } from "../../src/control-plane/access.js";

const subjects = z
  .array(
    z
      .object({
        userId: z.string().uuid(),
        projectId: z.string(),
        originThreadId: z.string(),
      })
      .strict(),
  )
  .length(2)
  .parse(JSON.parse(process.argv[2] ?? ""));
const db = createConnection("/srv/bb/bb.db");
const jobs = createControlPlaneBackgroundJobs(db, "workflows", true);
try {
  for (const [index, mode] of [
    "cancel",
    "revoke",
    "deadline",
    "large-result",
  ].entries()) {
    const subject = subjects[index % subjects.length];
    if (!subject) throw new Error("Missing evaluator subject");
    await withControlPlaneUser(subject.userId, async () => {
      const binding = await jobs.bind({
        kind: "workflow-run",
        objectId: `evaluator-proof-${randomUUID()}`,
        revision: 1,
        projectId: subject.projectId,
        profileVersionId: null,
        originThreadId: subject.originThreadId,
        sourceBindingId: null,
      });
      const controller = new AbortController();
      let started: () => void = () => {};
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending = jobs.evaluateWorkflow(
        binding.id,
        {
          body:
            mode === "large-result"
              ? 'return "x".repeat(1048577);'
              : 'log("started"); return await new Promise(() => {});',
          args: null,
          maxAgentCalls: 1,
          maxConcurrentAgents: 1,
          timeoutMs: mode === "deadline" ? 3000 : 15000,
        },
        controller.signal,
        (event) => {
          if (event.type === "log" && event.value === "started") started();
        },
      );
      const outcome = pending.then(
        () => null,
        (error: unknown) => error,
      );
      try {
        if (mode !== "large-result") {
          await Promise.race([
            ready,
            outcome.then((error) => {
              throw error ?? new Error("Evaluator ended before readiness");
            }),
          ]);
          if (mode === "cancel") controller.abort();
          if (mode === "revoke") await jobs.setEnabled(binding.id, false);
        }
        const error = await outcome;
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          mode === "cancel"
            ? /cancelled/u
            : mode === "revoke"
              ? /authoriz|revoked/u
              : mode === "deadline"
                ? /deadline/u
                : /1 MiB/u,
        );
      } finally {
        controller.abort();
        await outcome;
        await jobs.remove(binding.id);
      }
    });
  }
  process.stdout.write(
    JSON.stringify({
      workflowRunningCancellationVerified: true,
      workflowCurrentBindingRevocationStopsEvaluator: true,
      workflowDeadlineKillsPendingEvaluator: true,
      workflowOversizedResultRejected: true,
    }) + "\n",
  );
} finally {
  db.$client.close();
}
