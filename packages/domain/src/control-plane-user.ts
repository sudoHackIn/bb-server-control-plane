import { z } from "zod";
import { controlPlaneProfileSummarySchema } from "./control-plane-profile.js";
import { controlPlaneThreadSummarySchema } from "./control-plane-thread.js";

export const controlPlaneUserSessionSchema = z.object({
  role: z.literal("user"),
  user: z.object({
    id: z.string().uuid(),
    login: z.string(),
    environmentStatus: z.enum(["allocated", "provisioning", "ready", "failed"]),
  }),
  expiresAt: z.number(),
});
export const controlPlaneUserProjectSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  slug: z.string(),
  hostId: z.string(),
  cwd: z.string(),
  role: z.enum(["owner", "runner", "viewer"]),
  canRun: z.boolean(),
  canManage: z.boolean(),
});
export const controlPlaneUserBootstrapSchema = z.object({
  session: controlPlaneUserSessionSchema,
  projects: z.object({
    projects: z.array(controlPlaneUserProjectSchema),
    nextCursor: z.string().nullable(),
  }),
  threads: z.object({
    threads: z.array(controlPlaneThreadSummarySchema),
    nextCursor: z.string().nullable(),
  }),
  profiles: z.object({
    profiles: z.array(controlPlaneProfileSummarySchema),
    nextCursor: z.string().nullable(),
  }),
  capabilities: z.object({
    canCreateProjects: z.boolean(),
    canInstallPlugins: z.literal(false),
    canUseTerminals: z.literal(false),
  }),
});
export type ControlPlaneUserBootstrap = z.infer<
  typeof controlPlaneUserBootstrapSchema
>;
