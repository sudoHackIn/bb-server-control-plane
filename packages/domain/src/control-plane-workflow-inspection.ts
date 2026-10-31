import { z } from "zod";
import { jsonValueSchema } from "./json-value.js";
import {
  controlPlaneWorkflowHistorySchema,
  controlPlaneWorkflowRunSchema,
} from "./control-plane-workflow.js";

const timing = {
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
};
export const controlPlaneWorkflowCallSummarySchema =
  controlPlaneWorkflowHistorySchema.shape.calls.element
    .extend({
      ...timing,
      permissionMode: z.string(),
      profileVersionId: z.string().uuid().nullable(),
      source: z.enum(["live", "cached"]),
      replaySource: z.enum(["same-run", "resumed-run"]).nullable(),
    })
    .strict();
export const controlPlaneWorkflowInspectionSchema = z
  .object({
    run: controlPlaneWorkflowRunSchema,
    input: jsonValueSchema,
    sourceHash: z.string(),
    resumedFromRunId: z.string().nullable(),
    outputSchema: jsonValueSchema,
    profileVersionId: z.string().uuid(),
    workflowRevision: z
      .object({
        definitionId: z.string(),
        revision: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    nextCursor: z.number().int().nonnegative().nullable(),
    callCounts: z
      .object({
        total: z.number(),
        queued: z.number(),
        running: z.number(),
        succeeded: z.number(),
        failed: z.number(),
        cancelled: z.number(),
      })
      .strict(),
    calls: z.array(controlPlaneWorkflowCallSummarySchema).max(100),
  })
  .strict();
export const controlPlaneWorkflowCallInspectionSchema = z
  .object({
    runId: z.string(),
    call: controlPlaneWorkflowCallSummarySchema,
    input: z.string(),
    outputAvailable: z.boolean(),
    output: jsonValueSchema,
    outputSchema: jsonValueSchema,
    replayedFrom: z
      .object({ runId: z.string(), callId: z.string() })
      .strict()
      .nullable(),
    workers: z
      .array(z.object({ threadId: z.string(), archived: z.boolean() }).strict())
      .max(100),
    workersTruncated: z.boolean(),
  })
  .strict();

const traceStatus = z.enum([
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "incomplete",
]);
export const controlPlaneWorkflowTraceSchema = z
  .object({
    runId: z.string(),
    attempt: z
      .object({
        id: z.string().uuid(),
        sequence: z.number().int().positive(),
        status: traceStatus,
        createdAt: z.number(),
        finishedAt: z.number().nullable(),
        truncated: z.boolean(),
      })
      .strict()
      .nullable(),
    nextCursor: z.number().int().nonnegative().nullable(),
    entries: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            nodeId: z.number().int().positive().nullable(),
            scopeId: z.number().int().positive().nullable(),
            kind: z.enum(["workflow", "parallel", "agent"]),
            name: z.string().max(1024),
            sourceHash: z.string().nullable(),
            branchCount: z.number().int().nonnegative().nullable(),
            failedBranches: z.number().int().nonnegative().nullable(),
            status: traceStatus,
            error: z.string().max(1024).nullable(),
            createdAt: z.number(),
            finishedAt: z.number().nullable(),
            callId: z.string().nullable(),
            callIndex: z.number().int().nonnegative().nullable(),
            source: z.enum(["live", "cached"]).nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
