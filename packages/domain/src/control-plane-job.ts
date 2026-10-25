import { z } from "zod";

export const CONTROL_PLANE_WORKFLOWS_PLUGIN_ID = "workflows";
export const CONTROL_PLANE_AUTOMATIONS_PLUGIN_ID = "automations";

export const controlPlaneJobKindValues = [
  "workflow-definition",
  "workflow-run",
  "workflow-worker",
  "automation",
  "automation-run",
  "schedule",
] as const;
export const controlPlaneJobKindSchema = z.enum(controlPlaneJobKindValues);
const objectId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
export const controlPlaneJobBindingSchema = z
  .object({
    kind: controlPlaneJobKindSchema,
    objectId,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    userId: z.string().uuid(),
    projectId: objectId,
    profileVersionId: z.string().uuid(),
    originThreadId: objectId.nullable(),
    sourceBindingId: z.string().uuid().nullable(),
  })
  .strict();
export const controlPlaneJobListSchema = z
  .object({
    kind: controlPlaneJobKindSchema.optional(),
    projectId: objectId.optional(),
    cursor: z.string().uuid().nullable(),
    limit: z.number().int().min(1).max(100),
  })
  .strict();
export type ControlPlaneJobBinding = z.infer<
  typeof controlPlaneJobBindingSchema
>;
