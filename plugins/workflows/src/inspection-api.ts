import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { WorkflowService, WorkflowCallInspection } from "./service.js";
import { parseWorkflowSource } from "./parser.js";
import { toJsonValue } from "./json-value.js";
import { workflowRunSummary } from "./managed-api.js";
import { utf8Prefix } from "./utf8.js";

const id = z.string().min(1).max(200);
const contract = defineRpcContract({
  controlPlaneWorkflowTrace: {
    input: z
      .object({
        runId: id,
        attemptId: z.string().uuid().nullable(),
        after: z.number().int().min(-1),
        limit: z.number().int().min(1).max(100),
      })
      .strict(),
    output: z.unknown(),
  },
  controlPlaneWorkflowInspection: {
    input: z
      .object({
        runId: id,
        after: z.number().int().min(-1),
        limit: z.number().int().min(1).max(100),
      })
      .strict(),
    output: z.unknown(),
  },
  controlPlaneWorkflowCallInspection: {
    input: z.object({ runId: id, callId: id }).strict(),
    output: z.unknown(),
  },
});
function summary(call: WorkflowCallInspection) {
  return {
    id: call.id,
    index: call.callIndex,
    status: call.status,
    childThreadId: call.childThreadId,
    label:
      call.options.title === null ? null : utf8Prefix(call.options.title, 1024),
    phase:
      call.options.phase === null ? null : utf8Prefix(call.options.phase, 1024),
    provider: call.execution.provider,
    model: call.execution.model,
    reasoningLevel: call.execution.reasoningLevel,
    permissionMode: call.execution.permissionMode,
    profileVersionId: call.options.profileVersionId ?? null,
    providerRetryAttempts: call.providerRetryAttempts,
    repairAttempts: call.repairAttempts,
    error: call.error === null ? null : utf8Prefix(call.error, 8192),
    createdAt: call.createdAt,
    startedAt: call.startedAt,
    finishedAt: call.finishedAt,
    source: call.source,
    replaySource: call.replaySource,
  };
}
export function registerWorkflowInspectionApi(
  bb: BbPluginApi,
  service: WorkflowService,
) {
  function managed() {
    if (!bb.server.internal_DO_NOT_USE_backgroundJobs?.userId)
      throw new Error("A managed workflow user is required");
  }
  bb.rpc.register(contract, {
    controlPlaneWorkflowTrace({ runId, attemptId, after, limit }) {
      managed();
      return service.trace(runId, attemptId, after, limit);
    },
    controlPlaneWorkflowInspection({ runId, after, limit }) {
      managed();
      const page = service.inspectPage(runId, after, limit + 1);
      if (!page) return null;
      const calls = page.calls.slice(0, limit);
      return {
        run: workflowRunSummary(page.run),
        input: toJsonValue(JSON.parse(page.run.argsJson), "args"),
        sourceHash: page.run.sourceHash,
        resumedFromRunId: page.run.resumedFromRunId,
        outputSchema: parseWorkflowSource(page.run.source).metadata
          .outputSchema,
        callCounts: page.callCounts,
        calls: calls.map(summary),
        nextCursor:
          page.calls.length > limit ? (calls.at(-1)?.callIndex ?? null) : null,
      };
    },
    controlPlaneWorkflowCallInspection({ runId, callId }) {
      managed();
      const detail = service.inspectCallDetail(runId, callId);
      if (!detail) return null;
      const { call, ...rest } = detail;
      return {
        runId,
        ...rest,
        call: summary(call),
        input: call.prompt,
        outputAvailable: call.resultJson !== null,
        output:
          call.resultJson === null
            ? null
            : toJsonValue(JSON.parse(call.resultJson), "result"),
        outputSchema: call.options.outputSchema,
      };
    },
  });
}
