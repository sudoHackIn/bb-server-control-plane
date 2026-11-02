import { z } from "zod";

export const controlPlaneDiagnosticRoleSchema = z.enum([
  "developer",
  "reviewer",
]);
export const controlPlaneDiagnosticGrantInputSchema = z
  .object({
    role: controlPlaneDiagnosticRoleSchema.nullable(),
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();
export const controlPlaneDiagnosticGrantSchema = z
  .object({
    projectId: z.string(),
    userId: z.string().uuid(),
    login: z.string(),
    role: controlPlaneDiagnosticRoleSchema.nullable(),
    revision: z.number().int().positive(),
    updatedAt: z.number(),
    updatedBy: z.string(),
  })
  .strict();
export const controlPlaneInspectionRunSchema = z
  .object({
    kind: z.enum(["workflow", "thread"]),
    id: z.string(),
    projectId: z.string(),
    ownerUserId: z.string().uuid(),
    title: z.string(),
  })
  .strict();
export const controlPlaneInspectionPageSchema = z
  .object({
    project: z
      .object({ projectId: z.string(), name: z.string(), cwd: z.string() })
      .strict(),
    runs: z.array(controlPlaneInspectionRunSchema).max(50),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const controlPlaneDelegationSchema = z
  .object({
    invocationId: z.string().uuid(),
    state: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
    cleanupPending: z.boolean(),
    depth: z.number().int().positive(),
    deadlineAt: z.number(),
    parent: z
      .object({ kind: z.enum(["thread", "workflow"]), id: z.string() })
      .strict()
      .nullable(),
  })
  .strict();
export type ControlPlaneDelegation = z.infer<
  typeof controlPlaneDelegationSchema
>;
