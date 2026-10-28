import { z } from "zod";
import { permissionModeSchema, reasoningLevelSchema } from "./shared-types.js";
import { controlPlaneQwenNativeTools } from "./control-plane-qwen-native-tools.js";

const identifiers = z
  .array(z.string().regex(/^[A-Za-z0-9_.:/-]{1,200}$/u))
  .max(128)
  .refine(
    (items) => new Set(items).size === items.length,
    "Duplicate identifiers",
  );

export const controlPlaneProfileDefinitionSchema = z
  .object({
    purpose: z.string().trim().min(1).max(280).optional(),
    prompt: z.string().max(131072),
    providerId: z.literal("qwen-server"),
    model: z.string().trim().min(1).max(200),
    reasoningLevel: reasoningLevelSchema.max(200),
    permissionMode: permissionModeSchema,
    tools: identifiers,
    mcpServers: identifiers,
  })
  .strict();

const qwenNativeTools = new Set<string>(controlPlaneQwenNativeTools);
const qwenReasoningLevels = new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const controlPlaneProfilePublicationSchema =
  controlPlaneProfileDefinitionSchema.superRefine((definition, context) => {
    if (!qwenReasoningLevels.has(definition.reasoningLevel))
      context.addIssue({
        code: "custom",
        path: ["reasoningLevel"],
        message: "Unsupported Qwen reasoning level",
      });
    for (const name of definition.mcpServers)
      if (name !== "bb" && name !== "project")
        context.addIssue({
          code: "custom",
          path: ["mcpServers"],
          message: `Unsupported managed MCP server: ${name}`,
        });
    for (const name of definition.tools) {
      const supported =
        qwenNativeTools.has(name) ||
        (definition.mcpServers.includes("project") &&
          /^mcp:(?:\*|[a-z][a-z0-9-]{0,62}:[A-Za-z0-9_.-]{1,128})$/u.test(
            name,
          )) ||
        (definition.mcpServers.includes("bb") &&
          /^bb:[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) &&
          !["bb:update_environment_directory", "bb:bb_workflow_run"].includes(
            name,
          ));
      if (!supported)
        context.addIssue({
          code: "custom",
          path: ["tools"],
          message: `Unsupported managed tool: ${name}`,
        });
      if (
        definition.permissionMode !== "full" &&
        [
          "agent",
          "advisor",
          "create_sub_session",
          "workflow",
          "enter_plan_mode",
          "exit_plan_mode",
          "team_create",
        ].includes(name)
      )
        context.addIssue({
          code: "custom",
          path: ["tools"],
          message: `Restricted mode cannot use nested execution tool: ${name}`,
        });
    }
  });

export type ControlPlaneProfileDefinition = z.infer<
  typeof controlPlaneProfileDefinitionSchema
>;

export const controlPlaneProfileCreateSchema = z
  .object({
    slug: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/u),
    name: z.string().trim().min(1).max(100),
    definition: controlPlaneProfilePublicationSchema,
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
