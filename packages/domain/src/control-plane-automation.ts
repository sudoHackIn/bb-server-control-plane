import { z } from "zod";

export const controlPlaneAutomationSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    name: z.string().max(1024),
    enabled: z.boolean(),
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

const automationPrompt = z
  .string()
  .min(1)
  .max(131072)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 131072,
    "Automation prompt is too large",
  );
export const controlPlaneAutomationMutationSchema =
  controlPlaneAutomationSchema.extend({ revision: z.number().int().min(1) });
export const controlPlaneAutomationDetailSchema =
  controlPlaneAutomationMutationSchema.extend({ prompt: automationPrompt });
export const controlPlaneAutomationCreateSchema = z
  .object({
    originThreadId: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    prompt: automationPrompt,
    trigger: controlPlaneAutomationSchema.shape.trigger,
    enabled: z.boolean().default(true),
  })
  .strict();
export const controlPlaneAutomationUpdateSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    name: z.string().trim().min(1).max(200).optional(),
    prompt: automationPrompt.optional(),
    trigger: controlPlaneAutomationSchema.shape.trigger.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.prompt !== undefined ||
      value.trigger !== undefined,
    "Provide a definition change",
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
