import { z } from "zod";
import { jsonValueSchema } from "./json-value.js";
import { controlPlaneProfileDefinitionSchema } from "./control-plane-profile.js";

export const controlPlaneTestTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("published"),
      profileVersionId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("draft"),
      profileVersionId: z.string().uuid(),
      definitionId: z.string().min(1).max(200),
      revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
]);
export const controlPlaneTestRunStartSchema = z
  .object({
    sourceRunId: z.string().min(1).max(200),
    projectId: z.string().min(1).max(200),
    target: controlPlaneTestTargetSchema,
    idempotencyKey: z.string().min(1).max(200),
    executionUserId: z.string().uuid().optional(),
  })
  .strict();
export const controlPlaneTestRunSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string(),
    sourceRunId: z.string(),
    sourceProjectId: z.string(),
    ownerUserId: z.string().uuid(),
    projectId: z.string(),
    requestedBy: z.string(),
    target: controlPlaneTestTargetSchema,
    input: jsonValueSchema,
    sourceHash: z.string(),
    testedSourceHash: z.string(),
    profile: controlPlaneProfileDefinitionSchema,
    state: z.enum(["pending", "started"]),
    createdAt: z.number(),
  })
  .strict();
export type ControlPlaneTestRunStart = z.infer<
  typeof controlPlaneTestRunStartSchema
>;
