import { registerWorkflowInspectionApi } from "./inspection-api.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { WorkflowService } from "./service.js";
import type { WorkflowRunRow } from "./data.js";
import { toJsonValue } from "./json-value.js";
import { utf8Prefix } from "./utf8.js";

const status = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
const run = z
  .object({
    id: z.string(),
    projectId: z.string(),
    originThreadId: z.string().nullable(),
    name: z.string(),
    status,
    phase: z.string().nullable(),
    error: z.string().nullable(),
    resultAvailable: z.boolean(),
    notificationOutcome: z.enum(["pending", "delivered", "abandoned"]),
    createdAt: z.number(),
    startedAt: z.number().nullable(),
    finishedAt: z.number().nullable(),
  })
  .strict();
export const managedWorkflowRunSchema = run;
const id = z.string().min(1).max(200);
const lookup = z.object({ runId: id }).strict();
const contract = defineRpcContract({
  controlPlaneWorkflowStart: {
    input: z
      .object({
        projectId: id,
        originThreadId: id.nullable(),
        profileVersionId: z.string().uuid().optional(),
        script: z.string().min(1).max(524288),
        args: z.unknown(),
        resumeRunId: id.nullable(),
      })
      .strict(),
    output: run,
  },
  controlPlaneAgentWorkflowStart: {
    input: z
      .object({
        runId: z.string().regex(/^wfa_[a-f0-9]{64}$/u),
        projectId: id,
        profileVersionId: z.string().uuid(),
        script: z.string().min(1).max(524288),
        args: z.string().min(1).max(131072),
      })
      .strict(),
    output: run,
  },
  controlPlaneWorkflowRuns: {
    input: z.object({ ids: z.array(id).max(50) }).strict(),
    output: z.object({ runs: z.array(run) }).strict(),
  },
  controlPlaneWorkflowGet: {
    input: lookup,
    output: z.object({ run: run.nullable() }).strict(),
  },
  controlPlaneWorkflowStop: {
    input: lookup,
    output: z.object({ stopped: z.boolean() }).strict(),
  },
  controlPlaneWorkflowResult: {
    input: lookup,
    output: z
      .object({ runId: id, status, available: z.boolean(), value: z.unknown() })
      .strict()
      .nullable(),
  },
  controlPlaneWorkflowHistory: {
    input: z
      .object({
        runId: id,
        after: z.number().int().min(-1),
        limit: z.number().int().min(1).max(100),
      })
      .strict(),
    output: z
      .object({
        runId: id,
        nextCursor: z.number().int().nonnegative().nullable(),
        calls: z.array(
          z
            .object({
              id: z.string(),
              index: z.number(),
              status,
              childThreadId: z.string().nullable(),
              label: z.string().nullable(),
              phase: z.string().nullable(),
              provider: z.string(),
              model: z.string(),
              reasoningLevel: z.string(),
              providerRetryAttempts: z.number(),
              repairAttempts: z.number(),
              error: z.string().nullable(),
            })
            .strict(),
        ),
      })
      .strict()
      .nullable(),
  },
});
export function workflowRunSummary(row: WorkflowRunRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    originThreadId: row.originThreadId,
    name: utf8Prefix(row.name, 1024),
    status: row.status,
    phase: row.phase === null ? null : utf8Prefix(row.phase, 1024),
    error: row.error === null ? null : utf8Prefix(row.error, 8192),
    resultAvailable: row.resultJson !== null,
    notificationOutcome: row.notificationOutcome,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}
export function registerManagedWorkflowApi(
  bb: BbPluginApi,
  service: WorkflowService,
) {
  registerWorkflowInspectionApi(bb, service);
  function managed() {
    if (
      !bb.server.internal_DO_NOT_USE_backgroundJobs ||
      bb.server.internal_DO_NOT_USE_backgroundJobs.userId === null
    )
      throw new Error("A managed workflow user is required");
  }
  bb.rpc.register(contract, {
    async controlPlaneWorkflowStart(input) {
      managed();
      return workflowRunSummary(
        await service.start({
          projectId: input.projectId,
          originThreadId: input.originThreadId,
          ...(input.profileVersionId
            ? { profileVersionId: input.profileVersionId }
            : {}),
          source: input.script,
          args: toJsonValue(input.args, "args"),
          resumedFromRunId: input.resumeRunId,
        }),
      );
    },
    async controlPlaneAgentWorkflowStart(input) {
      managed();
      return workflowRunSummary(
        await service.start({
          runId: input.runId,
          projectId: input.projectId,
          originThreadId: null,
          profileVersionId: input.profileVersionId,
          source: input.script,
          args: input.args,
          resumedFromRunId: null,
        }),
      );
    },
    controlPlaneWorkflowRuns({ ids }) {
      managed();
      return {
        runs: ids.flatMap((id) => {
          const row = service.get(id);
          return row ? [workflowRunSummary(row)] : [];
        }),
      };
    },
    controlPlaneWorkflowGet({ runId }) {
      managed();
      const row = service.get(runId);
      return { run: row ? workflowRunSummary(row) : null };
    },
    async controlPlaneWorkflowStop({ runId }) {
      managed();
      return { stopped: await service.stop(runId) };
    },
    controlPlaneWorkflowResult({ runId }) {
      managed();
      const row = service.get(runId);
      return row
        ? {
            runId,
            status: row.status,
            available: row.resultJson !== null,
            value:
              row.resultJson === null
                ? null
                : toJsonValue(JSON.parse(row.resultJson), "result"),
          }
        : null;
    },
    controlPlaneWorkflowHistory({ runId, after, limit }) {
      managed();
      const page = service.inspectPage(runId, after, limit + 1);
      if (!page) return null;
      const calls = page.calls.slice(0, limit);
      return {
        runId,
        nextCursor:
          page.calls.length > limit ? (calls.at(-1)?.callIndex ?? null) : null,
        calls: calls.map((call) => ({
          id: call.id,
          index: call.callIndex,
          status: call.status,
          childThreadId: call.childThreadId,
          label:
            call.options.title === null
              ? null
              : utf8Prefix(call.options.title, 1024),
          phase:
            call.options.phase === null
              ? null
              : utf8Prefix(call.options.phase, 1024),
          provider: call.execution.provider,
          model: call.execution.model,
          reasoningLevel: call.execution.reasoningLevel,
          providerRetryAttempts: call.providerRetryAttempts,
          repairAttempts: call.repairAttempts,
          error: call.error === null ? null : utf8Prefix(call.error, 8192),
        })),
      };
    },
  });
}
