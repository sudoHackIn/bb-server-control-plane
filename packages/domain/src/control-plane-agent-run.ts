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
      .refine((value) => value.trim().length > 0)
      .refine((value) => new TextEncoder().encode(value).byteLength <= 131072),
    source: z.literal("manual"),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

export const controlPlaneAgentRunSchema = z.object({
  runId: z.string(),
  threadId: z.string().nullable(),
  workflowRunId: z.string().nullable().default(null),
  strategy: z.enum(["conversation", "workflow"]).default("conversation"),
  projectId: z.string(),
  profileId: z.string().uuid(),
  profileVersionId: z.string().uuid(),
  source: z.enum(["manual", "automation"]),
  title: z.string().nullable(),
  status: z.union([
    threadStatusSchema,
    z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  ]),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type ControlPlaneAgentRunStart = z.infer<
  typeof controlPlaneAgentRunStartSchema
>;
