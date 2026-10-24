import { z } from "zod";
import { permissionModeSchema, reasoningLevelSchema } from "./shared-types.js";

const identifiers = z
  .array(z.string().regex(/^[A-Za-z0-9_.:/-]{1,200}$/u))
  .max(128)
  .refine(
    (items) => new Set(items).size === items.length,
    "Duplicate identifiers",
  );

export const controlPlaneProfileDefinitionSchema = z
  .object({
    prompt: z.string().max(131072),
    providerId: z.literal("qwen-server"),
    model: z.string().trim().min(1).max(200),
    reasoningLevel: reasoningLevelSchema.max(200),
    permissionMode: permissionModeSchema,
    tools: identifiers,
    mcpServers: identifiers,
  })
  .strict();

export type ControlPlaneProfileDefinition = z.infer<
  typeof controlPlaneProfileDefinitionSchema
>;

export const controlPlaneProfileCreateSchema = z
  .object({
    slug: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/u),
    name: z.string().trim().min(1).max(100),
    definition: controlPlaneProfileDefinitionSchema,
  })
  .strict();

export const controlPlaneProfileSummarySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  createdAt: z.number(),
  latestVersionId: z.string().uuid(),
  latestVersion: z.number().int().positive(),
});

export const controlPlaneProfileVersionSchema = z.object({
  id: z.string().uuid(),
  profileId: z.string().uuid(),
  version: z.number().int().positive(),
  enabled: z.boolean(),
  definition: controlPlaneProfileDefinitionSchema,
  createdAt: z.number(),
});

export const controlPlaneProfileDetailSchema = z.object({
  profile: controlPlaneProfileSummarySchema,
  version: controlPlaneProfileVersionSchema,
});
