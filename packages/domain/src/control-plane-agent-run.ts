import { z } from "zod";
import { threadStatusSchema } from "./thread-status.js";

export const controlPlaneAgentRunStartSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    profileVersionId: z.string().uuid(),
    input: z
      .string()
      .min(1)
      .max(131072)
      .refine((value) => value.trim().length > 0),
    source: z.literal("manual"),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

export const controlPlaneAgentRunSchema = z.object({
  runId: z.string(),
  threadId: z.string(),
  projectId: z.string(),
  profileId: z.string().uuid(),
  profileVersionId: z.string().uuid(),
  source: z.literal("manual"),
  title: z.string().nullable(),
  status: threadStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type ControlPlaneAgentRunStart = z.infer<
  typeof controlPlaneAgentRunStartSchema
>;
