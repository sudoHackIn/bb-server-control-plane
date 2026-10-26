import { z } from "zod";
import { hostDaemonRpcCommandSchema } from "./commands.js";
import { workspaceDiffTargetSchema } from "@bb/domain";

export const workspaceExecutionRequestSchema = z
  .object({ cwd: z.string().startsWith("/").max(4096) })
  .strict();
export const workspaceExecutionIdentitySchema = z
  .object({
    userId: z.string().uuid(),
    uid: z.number().int().min(200000).max(299999),
    maintenanceGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    projectId: z.string().min(1),
    cwd: z.string().startsWith("/"),
  })
  .strict();
export type WorkspaceExecutionIdentity = z.infer<
  typeof workspaceExecutionIdentitySchema
>;
export const workspaceExecutionResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unmanaged") }).strict(),
  z
    .object({
      kind: z.literal("managed"),
      identity: workspaceExecutionIdentitySchema,
    })
    .strict(),
]);

export const workspaceForwardCommandSchema =
  hostDaemonRpcCommandSchema.transform((command, context) => {
    switch (command.type) {
      case "host.read_workspace_agent_context":
      case "host.inspect_git_source":
      case "host.list_branch_options":
      case "project.inspect":
        return command;
      default:
        context.addIssue({
          code: "custom",
          message: "Unsupported workspace command",
        });
        return z.NEVER;
    }
  });
const limit = z.number().int().positive().max(16777216);
export const workspaceWorkerRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("inspect") }).strict(),
  z
    .object({
      op: z.enum([
        "branch",
        "defaultBranch",
        "head",
        "localState",
        "sharedRefs",
        "writeRoots",
      ]),
    })
    .strict(),
  z
    .object({
      op: z.literal("status"),
      options: z
        .object({
          mergeBaseBranch: z.string().optional(),
          maxFiles: limit.optional(),
          maxUntrackedLineStatFiles: limit.optional(),
          maxUntrackedLineStatBytes: limit.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      op: z.literal("diff"),
      options: z
        .object({
          target: workspaceDiffTargetSchema.optional(),
          maxDiffBytes: limit.optional(),
          maxFileListBytes: limit.optional(),
          maxUntrackedFiles: limit.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      op: z.literal("diffFiles"),
      options: z
        .object({
          target: workspaceDiffTargetSchema,
          maxFiles: limit,
          ignoreWhitespace: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      op: z.literal("diffPatch"),
      options: z
        .object({
          target: workspaceDiffTargetSchema,
          paths: z.array(z.string()).max(4096),
          maxBytesPerFile: limit,
          ignoreWhitespace: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      op: z.literal("commit"),
      options: z
        .object({
          message: z.string().min(1).max(65536),
          noVerify: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      op: z.literal("command"),
      command: workspaceForwardCommandSchema,
    })
    .strict(),
]);
export type WorkspaceWorkerRequest = z.infer<
  typeof workspaceWorkerRequestSchema
>;
export const workspaceWorkerResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z
    .object({ ok: z.literal(false), code: z.string(), message: z.string() })
    .strict(),
]);
