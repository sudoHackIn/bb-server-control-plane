import { z } from "zod";

export const controlPlaneAutomationSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    name: z.string().max(1024),
    enabled: z.boolean(),
    executionMode: z.enum(["agent", "script"]).default("agent"),
    trigger: z.discriminatedUnion("triggerType", [
      z.object({ triggerType: z.literal("once"), runAt: z.number() }).strict(),
      z
        .object({
          triggerType: z.literal("schedule"),
          cron: z.string().min(1).max(100),
          timezone: z.string().min(1).max(100),
        })
        .strict(),
    ]),
    createdByThreadId: z.string().min(1),
    nextRunAt: z.number().nullable(),
    lastRunAt: z.number().nullable(),
    runCount: z.number().int().min(0),
    lastRunStatus: z
      .enum(["running", "succeeded", "failed", "skipped", "cancelled"])
      .nullable(),
    lastRunThreadId: z.string().min(1).nullable(),
    lastError: z.string().max(8192).nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export const controlPlaneAutomationPageSchema = z
  .object({
    automations: z.array(controlPlaneAutomationSchema).max(50),
    nextCursor: z.string().uuid().nullable(),
  })
  .strict();
export const controlPlaneAutomationRunSchema = z
  .object({
    id: z.string().min(1),
    automationId: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    runMode: z.enum(["agent", "script"]).default("agent"),
    status: z.enum(["running", "succeeded", "failed", "skipped", "cancelled"]),
    trigger: z.enum(["schedule", "manual"]),
    skipReason: z.string().max(8192).nullable(),
    error: z.string().max(8192).nullable(),
    scheduledFor: z.number(),
    startedAt: z.number(),
    finishedAt: z.number().nullable(),
  })
  .strict();
export const controlPlaneAutomationHistorySchema = z
  .object({
    automationId: z.string().min(1),
    runs: z.array(controlPlaneAutomationRunSchema).max(100),
    nextCursor: z.string().min(1).max(1024).nullable(),
  })
  .strict();

export const controlPlaneAutomationPromptSchema = z
  .string()
  .min(1)
  .max(131072)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 131072,
    "Automation prompt is too large",
  );
export const controlPlaneAutomationMutationSchema =
  controlPlaneAutomationSchema.extend({ revision: z.number().int().min(1) });
export const controlPlaneAutomationScriptSchema = z
  .object({
    source: z
      .string()
      .min(1)
      .max(262144)
      .refine((value) => new TextEncoder().encode(value).byteLength <= 262144),
    timeoutMs: z.number().int().min(1).max(900000).default(120000),
  })
  .strict();
export const controlPlaneAutomationDetailSchema = z.discriminatedUnion(
  "executionMode",
  [
    controlPlaneAutomationMutationSchema.extend({
      executionMode: z.literal("agent").default("agent"),
      prompt: controlPlaneAutomationPromptSchema,
    }),
    controlPlaneAutomationMutationSchema.extend({
      executionMode: z.literal("script"),
      script: controlPlaneAutomationScriptSchema,
    }),
  ],
);
const automationCreate = z
  .object({
    originThreadId: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    trigger: controlPlaneAutomationSchema.shape.trigger,
    enabled: z.boolean().default(true),
  })
  .strict();
export const controlPlaneAutomationCreateSchema = z.union([
  automationCreate.extend({ prompt: controlPlaneAutomationPromptSchema }),
  automationCreate.extend({ script: controlPlaneAutomationScriptSchema }),
]);
export const controlPlaneAutomationUpdateSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    name: z.string().trim().min(1).max(200).optional(),
    prompt: controlPlaneAutomationPromptSchema.optional(),
    script: controlPlaneAutomationScriptSchema.optional(),
    trigger: controlPlaneAutomationSchema.shape.trigger.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.prompt !== undefined ||
      value.script !== undefined ||
      value.trigger !== undefined,
    "Provide a definition change",
  )
  .refine(
    (value) => value.prompt === undefined || value.script === undefined,
    "Choose prompt or script",
  );
export const controlPlaneAutomationRunInputSchema = z
  .object({ idempotencyKey: z.string().min(1).max(200).optional() })
  .strict();
export type ControlPlaneAutomationCreate = z.output<
  typeof controlPlaneAutomationCreateSchema
>;
export type ControlPlaneAutomationUpdate = z.output<
  typeof controlPlaneAutomationUpdateSchema
>;

export const controlPlaneAutomationScriptResultSchema = z
  .object({
    jobId: z.string().uuid(),
    status: z.enum([
      "succeeded",
      "failed",
      "cancelled",
      "timed_out",
      "output_limit",
      "authority_revoked",
      "invalid_output",
    ]),
    exitCode: z.number().int().nullable(),
    signal: z.string().max(50).nullable(),
    stdout: z.string().max(1048576),
    stderr: z.string().max(1048576),
    outputBytes: z.number().int().min(0).max(1048576),
    truncated: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      new TextEncoder().encode(value.stdout).byteLength +
        new TextEncoder().encode(value.stderr).byteLength <=
      value.outputBytes,
  );
export const controlPlaneAutomationOutputSchema = z
  .object({
    automationId: z.string().min(1),
    runId: z.string().min(1),
    status: controlPlaneAutomationRunSchema.shape.status,
    result: controlPlaneAutomationScriptResultSchema.nullable(),
    cleanupPending: z.boolean(),
    error: z.string().max(8192).nullable(),
  })
  .strict();
