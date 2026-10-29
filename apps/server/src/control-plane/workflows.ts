import { createControlPlaneWorkflowDefinitions } from "./workflow-definitions.js";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  controlPlaneJobBindings,
  getControlPlaneJobBinding,
  listControlPlaneJobBindings,
  getControlPlaneProject,
  requireControlPlaneThreadDispatch,
  requireControlPlaneThreadOwner,
  getInstalledPluginRegistration,
  type DbConnection,
} from "@bb/db";
import {
  controlPlaneWorkflowRunSchema,
  controlPlaneWorkflowResultSchema,
  controlPlaneWorkflowHistorySchema,
  type ControlPlaneWorkflowStart,
  type JsonValue,
} from "@bb/domain";
import type { PluginService } from "../services/plugins/plugin-service.js";
import { BUILTIN_WORKFLOWS_PLUGIN_ID } from "../services/plugins/builtin-registry.js";
import { ApiError } from "../errors.js";
import { withControlPlaneUser } from "./access.js";

type Operation =
  | "controlPlaneDefinitionCreate"
  | "controlPlaneDefinitions"
  | "controlPlaneDefinitionApprove"
  | "controlPlaneAgentWorkflowStart"
  | "controlPlaneDefinitionGet"
  | "controlPlaneDefinitionUpdate"
  | "controlPlaneDefinitionEnabled"
  | "controlPlaneDefinitionRemove"
  | "controlPlaneDefinitionRun"
  | "controlPlaneWorkflowStart"
  | "controlPlaneWorkflowRuns"
  | "controlPlaneWorkflowGet"
  | "controlPlaneWorkflowStop"
  | "controlPlaneWorkflowResult"
  | "controlPlaneWorkflowHistory";
export type ControlPlaneWorkflowRpc = (
  method: Operation,
  input: JsonValue,
) => Promise<JsonValue>;
export function createControlPlaneWorkflowRpc(
  db: DbConnection,
  plugins: () => PluginService,
): ControlPlaneWorkflowRpc {
  return async (method, input) => {
    const id = BUILTIN_WORKFLOWS_PLUGIN_ID;
    const installed = getInstalledPluginRegistration(db, id);
    if (
      !installed ||
      !installed.enabled ||
      installed.provenance !== "builtin" ||
      installed.removedAt !== null ||
      installed.sourceKind !== "builtin" ||
      installed.sourceBuiltinName !== "workflows"
    )
      throw new ApiError(
        503,
        "workflow_unavailable",
        "Builtin Workflows is unavailable",
      );
    const service = plugins();
    const lookup = service.getRpcHandler(id, method);
    if (lookup.outcome !== "found")
      throw new ApiError(
        503,
        "workflow_unavailable",
        "Builtin Workflows is unavailable",
      );
    const result = await service.invokeRpcHandler(
      id,
      method,
      lookup.value,
      input,
      { kind: "client" },
    );
    if (
      !result.ok &&
      result.error.message.includes("Workflow agent idempotency conflict")
    )
      throw new ApiError(
        409,
        "idempotency_conflict",
        "Idempotency key was used for another request",
      );
    if (!result.ok)
      throw new ApiError(
        400,
        "workflow_rejected",
        result.error.message.slice(0, 8192),
      );
    return result.result;
  };
}
export function ownedWorkflowBinding(
  db: DbConnection,
  userId: string,
  runId: string,
  kind: "workflow-run" | "workflow-definition",
) {
  const row = db
    .select({ id: controlPlaneJobBindings.id })
    .from(controlPlaneJobBindings)
    .where(
      and(
        eq(controlPlaneJobBindings.kind, kind),
        eq(controlPlaneJobBindings.objectId, runId),
        eq(controlPlaneJobBindings.ownerUserId, userId),
        eq(controlPlaneJobBindings.revision, 1),
        isNull(controlPlaneJobBindings.deletedAt),
      ),
    )
    .get();
  const value = row ? getControlPlaneJobBinding(db, userId, row.id) : null;
  if (!value)
    throw new ApiError(404, "workflow_not_found", "Workflow not found");
  return value;
}

export function createControlPlaneWorkflowService(
  db: DbConnection,
  rpc: ControlPlaneWorkflowRpc,
) {
  function notFound(): never {
    throw new ApiError(404, "workflow_not_found", "Workflow not found");
  }
  function binding(userId: string, runId: string) {
    return ownedWorkflowBinding(db, userId, runId, "workflow-run");
  }
  function checked(
    userId: string,
    row: z.infer<typeof controlPlaneWorkflowRunSchema>,
  ) {
    const saved = binding(userId, row.id);
    if (
      row.projectId !== saved.projectId ||
      row.originThreadId !== saved.originThreadId
    )
      throw new ApiError(
        502,
        "workflow_contract_error",
        "Invalid workflow identity",
      );
    return row;
  }
  async function get(userId: string, runId: string) {
    binding(userId, runId);
    const value = z
      .object({ run: controlPlaneWorkflowRunSchema.nullable() })
      .strict()
      .parse(
        await withControlPlaneUser(userId, () =>
          rpc("controlPlaneWorkflowGet", { runId }),
        ),
      );
    if (!value.run) return notFound();
    if (value.run.id !== runId)
      throw new ApiError(
        502,
        "workflow_contract_error",
        "Invalid workflow identity",
      );
    return checked(userId, value.run);
  }
  return {
    definitions: createControlPlaneWorkflowDefinitions(db, rpc),
    async approveDefinition(input: { definitionId: string; revision: number }) {
      return z
        .object({
          definitionId: z.string(),
          revision: z.number().int().positive(),
          script: z.string().max(524288),
        })
        .strict()
        .parse(
          await rpc("controlPlaneDefinitionApprove", {
            id: input.definitionId,
            revision: input.revision,
          }),
        );
    },
    async startAgent(
      userId: string,
      input: {
        runId: string;
        projectId: string;
        profileVersionId: string;
        script: string;
        args: string;
      },
    ) {
      const row = controlPlaneWorkflowRunSchema.parse(
        await withControlPlaneUser(userId, () =>
          rpc("controlPlaneAgentWorkflowStart", input),
        ),
      );
      if (row.id !== input.runId)
        throw new ApiError(
          502,
          "workflow_contract_error",
          "Invalid workflow identity",
        );
      return checked(userId, row);
    },
    async find(userId: string, runId: string) {
      const value = z
        .object({ run: controlPlaneWorkflowRunSchema.nullable() })
        .strict()
        .parse(
          await withControlPlaneUser(userId, () =>
            rpc("controlPlaneWorkflowGet", { runId }),
          ),
        );
      if (!value.run) return null;
      if (value.run.id !== runId)
        throw new ApiError(
          502,
          "workflow_contract_error",
          "Invalid workflow identity",
        );
      return checked(userId, value.run);
    },
    get,
    async start(userId: string, input: ControlPlaneWorkflowStart) {
      const context =
        input.originThreadId === null
          ? requireControlPlaneThreadOwner(db, {
              projectId: input.projectId,
              ownerUserId: userId,
              profileVersionId: input.profileVersionId,
              providerId: "qwen-server",
              relatedThreadIds: [],
            })
          : requireControlPlaneThreadDispatch(db, input.originThreadId);
      if (!context || context.user.id !== userId) return notFound();
      if (input.resumeRunId !== null) await get(userId, input.resumeRunId);
      const row = controlPlaneWorkflowRunSchema.parse(
        await withControlPlaneUser(userId, () =>
          rpc("controlPlaneWorkflowStart", {
            ...input,
            projectId: context.project.projectId,
          }),
        ),
      );
      return checked(userId, row);
    },
    async list(
      userId: string,
      input: { projectId?: string; cursor: string | null; limit: number },
    ) {
      if (
        input.projectId &&
        !getControlPlaneProject(db, userId, input.projectId)
      )
        throw new ApiError(404, "project_not_found", "Project not found");
      const page = listControlPlaneJobBindings(db, userId, {
        ...input,
        kind: "workflow-run",
      });
      const ids = page.bindings.map((row) => row.objectId);
      if (!ids.length) return { runs: [], nextCursor: page.nextCursor };
      const result = z
        .object({ runs: z.array(controlPlaneWorkflowRunSchema).max(50) })
        .strict()
        .parse(
          await withControlPlaneUser(userId, () =>
            rpc("controlPlaneWorkflowRuns", { ids }),
          ),
        );
      return {
        runs: result.runs.map((row) => {
          if (!ids.includes(row.id))
            throw new ApiError(
              502,
              "workflow_contract_error",
              "Invalid workflow identity",
            );
          return checked(userId, row);
        }),
        nextCursor: page.nextCursor,
      };
    },
    async stop(userId: string, runId: string) {
      await get(userId, runId);
      return z
        .object({ stopped: z.boolean() })
        .strict()
        .parse(
          await withControlPlaneUser(userId, () =>
            rpc("controlPlaneWorkflowStop", { runId }),
          ),
        );
    },
    async result(userId: string, runId: string) {
      await get(userId, runId);
      const value = controlPlaneWorkflowResultSchema
        .nullable()
        .parse(
          await withControlPlaneUser(userId, () =>
            rpc("controlPlaneWorkflowResult", { runId }),
          ),
        );
      if (!value) return notFound();
      if (value.runId !== runId)
        throw new ApiError(
          502,
          "workflow_contract_error",
          "Invalid workflow result identity",
        );
      binding(userId, runId);
      return value;
    },
    async history(userId: string, runId: string, after: number, limit: number) {
      await get(userId, runId);
      const value = controlPlaneWorkflowHistorySchema
        .nullable()
        .parse(
          await withControlPlaneUser(userId, () =>
            rpc("controlPlaneWorkflowHistory", { runId, after, limit }),
          ),
        );
      if (!value) return notFound();
      if (value.runId !== runId)
        throw new ApiError(
          502,
          "workflow_contract_error",
          "Invalid workflow history identity",
        );
      binding(userId, runId);
      return value;
    },
  };
}
export type ControlPlaneWorkflowService = ReturnType<
  typeof createControlPlaneWorkflowService
>;
