import { z } from "zod";
export const controlPlaneWebhookCreateSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    profileVersionId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    inputField: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/u)
      .default("input"),
  })
  .strict();
export const controlPlaneWebhookSchema = controlPlaneWebhookCreateSchema
  .extend({
    id: z.string().uuid(),
    enabled: z.boolean(),
    createdAt: z.number(),
    deliveryPath: z.string(),
  })
  .strict();
export const controlPlaneWebhookSecretSchema = z
  .object({
    webhook: controlPlaneWebhookSchema,
    secret: z.string().regex(/^whk_[A-Za-z0-9_-]{43}$/u),
  })
  .strict();
export const controlPlaneWebhookDeliverySchema = z
  .object({
    id: z.string().uuid(),
    webhookId: z.string().uuid(),
    deliveryKey: z.string().min(1).max(200),
    state: z.enum(["pending", "accepted", "failed"]),
    runId: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export const controlPlaneWebhookPageSchema = z
  .object({
    webhooks: z.array(controlPlaneWebhookSchema),
    nextCursor: z.string().uuid().nullable(),
  })
  .strict();
export const controlPlaneWebhookHistorySchema = z
  .object({
    deliveries: z.array(controlPlaneWebhookDeliverySchema),
    nextCursor: z.string().uuid().nullable(),
  })
  .strict();
