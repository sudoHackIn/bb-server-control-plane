import { z } from "zod";
export const controlPlaneTaskSourceCreateSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    profileVersionId: z.string().uuid(),
    kind: z.literal("beads"),
    name: z.string().trim().min(1).max(120),
    intervalSeconds: z.number().int().min(60).max(86400).default(300),
  })
  .strict();
export const controlPlaneTaskSourceSchema =
  controlPlaneTaskSourceCreateSchema.extend({
    id: z.string().uuid(),
    enabled: z.boolean(),
    checkpoint: z.string().nullable(),
    nextPollAt: z.number(),
    lastPollAt: z.number().nullable(),
    failures: z.number(),
    error: z.string().nullable(),
    createdAt: z.number(),
  });
export const controlPlaneTaskSourceItemSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  externalId: z.string(),
  title: z.string(),
  state: z.enum(["pending", "accepted"]),
  runId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
});
export const controlPlaneTaskSourcePageSchema = z.object({
  sources: z.array(controlPlaneTaskSourceSchema),
  nextCursor: z.string().nullable(),
});
export const controlPlaneTaskSourceHistorySchema = z.object({
  items: z.array(controlPlaneTaskSourceItemSchema),
  nextCursor: z.string().nullable(),
});
