import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "./json-value.js";

const workflowArgs = z.custom<JsonValue>((input) => {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: input, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item || ++nodes > 10000 || item.depth > 32) return false;
    const value = item.value;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (
      typeof value !== "object" ||
      (!Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    )
      return false;
    if (Object.getOwnPropertySymbols(value).length) return false;
    if (
      Array.isArray(value) &&
      (Object.keys(value).length !== value.length ||
        Object.keys(value).some(
          (key) =>
            !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length,
        ))
    )
      return false;
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (Array.isArray(value) && key === "length") continue;
      if (
        ["__proto__", "constructor", "prototype"].includes(key) ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      )
        return false;
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
  return new TextEncoder().encode(JSON.stringify(input)).byteLength <= 131072;
}, "Workflow args must be bounded JSON");
export const controlPlaneWorkflowStartSchema = z
  .object({
    originThreadId: z.string().min(1).max(200),
    script: z
      .string()
      .min(1)
      .max(524288)
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= 524288,
        "Workflow script is too large",
      ),
    args: workflowArgs.default(null),
    resumeRunId: z.string().min(1).max(200).nullable().default(null),
  })
  .strict();
export const controlPlaneWorkflowStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const controlPlaneWorkflowRunSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    originThreadId: z.string(),
    name: z.string().max(1024),
    status: controlPlaneWorkflowStatusSchema,
    phase: z.string().max(1024).nullable(),
    error: z.string().max(8192).nullable(),
    resultAvailable: z.boolean(),
    notificationOutcome: z.enum(["pending", "delivered", "abandoned"]),
    createdAt: z.number(),
    startedAt: z.number().nullable(),
    finishedAt: z.number().nullable(),
  })
  .strict();
export const controlPlaneWorkflowPageSchema = z
  .object({
    runs: z.array(controlPlaneWorkflowRunSchema).max(50),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const controlPlaneWorkflowResultSchema = z
  .object({
    runId: z.string(),
    status: controlPlaneWorkflowStatusSchema,
    available: z.boolean(),
    value: jsonValueSchema,
  })
  .strict();
export const controlPlaneWorkflowHistorySchema = z
  .object({
    runId: z.string(),
    nextCursor: z.number().int().nonnegative().nullable(),
    calls: z
      .array(
        z
          .object({
            id: z.string(),
            index: z.number().int().nonnegative(),
            status: controlPlaneWorkflowStatusSchema,
            childThreadId: z.string().nullable(),
            label: z.string().max(1024).nullable(),
            phase: z.string().max(1024).nullable(),
            provider: z.string(),
            model: z.string(),
            reasoningLevel: z.string(),
            providerRetryAttempts: z.number().int().nonnegative(),
            repairAttempts: z.number().int().nonnegative(),
            error: z.string().max(8192).nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type ControlPlaneWorkflowStart = z.infer<
  typeof controlPlaneWorkflowStartSchema
>;

export const controlPlaneWorkflowDefinitionCreateSchema =
  controlPlaneWorkflowStartSchema.omit({ resumeRunId: true });
export const controlPlaneWorkflowDefinitionUpdateSchema =
  controlPlaneWorkflowDefinitionCreateSchema
    .omit({ originThreadId: true })
    .extend({
      expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    })
    .strict();
export const controlPlaneWorkflowDefinitionRunSchema = z
  .object({
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    args: workflowArgs.optional(),
  })
  .strict();
export const controlPlaneWorkflowDefinitionSummarySchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    originThreadId: z.string(),
    revision: z.number().int().positive(),
    name: z.string().max(1024),
    enabled: z.boolean(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export const controlPlaneWorkflowDefinitionSchema =
  controlPlaneWorkflowDefinitionSummarySchema
    .extend({
      script: controlPlaneWorkflowStartSchema.shape.script,
      args: workflowArgs,
    })
    .strict();
export const controlPlaneWorkflowDefinitionPageSchema = z
  .object({
    definitions: z.array(controlPlaneWorkflowDefinitionSummarySchema).max(50),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type ControlPlaneWorkflowDefinition = z.infer<
  typeof controlPlaneWorkflowDefinitionSchema
>;
