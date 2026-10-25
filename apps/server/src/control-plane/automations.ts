import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  controlPlaneJobBindings,
  getControlPlaneJobBinding,
  getControlPlaneProject,
  getInstalledPluginRegistration,
  listControlPlaneJobBindings,
  requireControlPlaneThreadDispatch,
  type DbConnection,
} from "@bb/db";
import {
  controlPlaneAutomationSchema,
  controlPlaneAutomationRunSchema,
  controlPlaneAutomationDetailSchema,
  controlPlaneAutomationPromptSchema,
  controlPlaneAutomationOutputSchema,
  controlPlaneAutomationScriptResultSchema,
  controlPlaneAutomationMutationSchema,
  type ControlPlaneAutomationCreate,
  type ControlPlaneAutomationUpdate,
  type JsonValue,
} from "@bb/domain";
import { ApiError } from "../errors.js";
import type { PluginService } from "../services/plugins/plugin-service.js";
import { BUILTIN_AUTOMATIONS_PLUGIN_ID } from "../services/plugins/builtin-registry.js";
import { withControlPlaneUser } from "./access.js";

type Operation =
  | "controlPlaneAutomationResult"
  | "controlPlaneAutomationReads"
  | "automations_runs"
  | "automations_create"
  | "controlPlaneAutomationUpdate"
  | "controlPlaneAutomationStop"
  | "automations_pause"
  | "automations_resume"
  | "automations_delete"
  | "automations_run";
export type ControlPlaneAutomationRpc = (
  method: Operation,
  input: JsonValue,
) => Promise<JsonValue>;
export function createControlPlaneAutomationRpc(
  db: DbConnection,
  plugins: () => Pick<PluginService, "getRpcHandler" | "invokeRpcHandler">,
): ControlPlaneAutomationRpc {
  return async (method, input) => {
    const id = BUILTIN_AUTOMATIONS_PLUGIN_ID;
    const installed = getInstalledPluginRegistration(db, id);
    if (
      !installed ||
      !installed.enabled ||
      installed.removedAt !== null ||
      installed.provenance !== "builtin" ||
      installed.sourceKind !== "builtin" ||
      installed.sourceBuiltinName !== "automations"
    )
      throw new ApiError(
        503,
        "automation_unavailable",
        "Builtin Automations is unavailable",
      );
    const service = plugins();
    const handler = service.getRpcHandler(id, method);
    if (handler.outcome !== "found")
      throw new ApiError(
        503,
        "automation_unavailable",
        "Builtin Automations is unavailable",
      );
    const result = await service.invokeRpcHandler(
      id,
      method,
      handler.value,
      input,
      { kind: "client" },
    );
    if (!result.ok && result.error.code === "conflict")
      throw new ApiError(
        409,
        method === "controlPlaneAutomationUpdate"
          ? "automation_revision_conflict"
          : "automation_operation_pending",
        method === "controlPlaneAutomationUpdate"
          ? "Automation revision conflict"
          : "Automation operation is pending",
      );
    if (!result.ok && result.error.code === "not_found")
      throw new ApiError(404, "automation_not_found", "Automation not found");
    if (!result.ok)
      throw new ApiError(
        400,
        "automation_rejected",
        "Automation request rejected",
      );
    return result.result;
  };
}
export function createControlPlaneAutomationService(
  db: DbConnection,
  rpc: ControlPlaneAutomationRpc,
) {
  function missing(): never {
    throw new ApiError(404, "automation_not_found", "Automation not found");
  }
  function binding(userId: string, id: string) {
    const row = db
      .select({ id: controlPlaneJobBindings.id })
      .from(controlPlaneJobBindings)
      .where(
        and(
          eq(controlPlaneJobBindings.kind, "automation"),
          eq(controlPlaneJobBindings.objectId, id),
          eq(controlPlaneJobBindings.ownerUserId, userId),
          eq(controlPlaneJobBindings.revision, 1),
          isNull(controlPlaneJobBindings.deletedAt),
        ),
      )
      .get();
    const value = row ? getControlPlaneJobBinding(db, userId, row.id) : null;
    return value ?? missing();
  }
  function invalid(): never {
    throw new ApiError(
      502,
      "automation_contract_error",
      "Invalid automation identity",
    );
  }
  async function read(userId: string, ids: string[]) {
    for (const id of ids) binding(userId, id);
    if (!ids.length) return [];
    const result = z
      .array(
        controlPlaneAutomationMutationSchema
          .extend({
            execution: z.discriminatedUnion("mode", [
              z.object({
                mode: z.literal("agent"),
                prompt: controlPlaneAutomationPromptSchema,
              }),
              z.object({
                mode: z.literal("script"),
                script: z.string().min(1).max(262144),
                interpreter: z.literal("node"),
                workingDirectory: z.object({ type: z.literal("project") }),
                timeoutMs: z.number().int().min(1).max(900000),
              }),
            ]),
          })
          .strip(),
      )
      .max(50)
      .safeParse(
        await withControlPlaneUser(userId, () =>
          rpc("controlPlaneAutomationReads", { ids }),
        ),
      );
    if (!result.success) return invalid();
    const seen = new Set<string>();
    for (const value of result.data) {
      if (!ids.includes(value.id) || seen.has(value.id)) return invalid();
      seen.add(value.id);
      const saved = binding(userId, value.id);
      if (
        value.projectId !== saved.projectId ||
        value.createdByThreadId !== saved.originThreadId
      )
        return invalid();
    }
    for (const id of ids) binding(userId, id);
    return result.data;
  }
  async function get(userId: string, id: string) {
    const rows = await read(userId, [id]);
    const row = rows[0] ?? missing();
    return controlPlaneAutomationSchema
      .strip()
      .parse({ ...row, executionMode: row.execution.mode });
  }
  async function mutation(userId: string, id: string) {
    const row = (await read(userId, [id]))[0] ?? missing();
    return controlPlaneAutomationMutationSchema
      .strip()
      .parse({ ...row, executionMode: row.execution.mode });
  }
  async function definition(userId: string, id: string) {
    const row = (await read(userId, [id]))[0] ?? missing();
    return controlPlaneAutomationDetailSchema.parse({
      ...controlPlaneAutomationMutationSchema.strip().parse(row),
      executionMode: row.execution.mode,
      ...(row.execution.mode === "agent"
        ? { prompt: row.execution.prompt }
        : {
            script: {
              source: row.execution.script,
              timeoutMs: row.execution.timeoutMs,
            },
          }),
    });
  }

  return {
    get,
    definition,
    async create(userId: string, input: ControlPlaneAutomationCreate) {
      const source = requireControlPlaneThreadDispatch(
        db,
        input.originThreadId,
      );
      if (!source || source.user.id !== userId) return missing();
      const profile = source.profileVersion.definition;
      const result = z
        .object({
          id: z.string(),
          projectId: z.string(),
          createdByThreadId: z.string(),
        })
        .parse(
          await withControlPlaneUser(userId, () =>
            rpc("automations_create", {
              projectId: source.project.projectId,
              createdByThreadId: input.originThreadId,
              name: input.name,
              enabled: input.enabled,
              trigger: input.trigger,
              origin: "human",
              execution:
                "script" in input
                  ? {
                      mode: "script",
                      script: input.script.source,
                      timeoutMs: input.script.timeoutMs,
                      interpreter: "node",
                      workingDirectory: { type: "project" },
                    }
                  : {
                      mode: "agent",
                      prompt: input.prompt,
                      providerId: profile.providerId,
                      model: profile.model,
                      reasoningLevel: profile.reasoningLevel,
                      permissionMode: profile.permissionMode,
                      environment: { type: "project-default" },
                    },
            }),
          ),
        );
      if (
        result.projectId !== source.project.projectId ||
        result.createdByThreadId !== input.originThreadId
      )
        return invalid();
      return mutation(userId, result.id);
    },
    async update(
      userId: string,
      id: string,
      input: ControlPlaneAutomationUpdate,
    ) {
      const row = await mutation(userId, id);
      if (row.revision !== input.expectedRevision)
        throw new ApiError(
          409,
          "automation_revision_conflict",
          "Automation revision conflict",
        );
      if (
        (input.script && row.executionMode !== "script") ||
        (input.prompt !== undefined && row.executionMode !== "agent")
      )
        throw new ApiError(
          400,
          "automation_mode_immutable",
          "Create a new automation to change execution mode",
        );
      await withControlPlaneUser(userId, () =>
        rpc("controlPlaneAutomationUpdate", {
          projectId: row.projectId,
          automationId: id,
          expectedRevision: input.expectedRevision,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.script === undefined
            ? {}
            : {
                execution: {
                  mode: "script",
                  script: input.script.source,
                  timeoutMs: input.script.timeoutMs,
                  interpreter: "node",
                  workingDirectory: { type: "project" },
                },
              }),
          ...(input.prompt === undefined
            ? {}
            : { agent: { prompt: input.prompt } }),
          ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
        }),
      );
      return mutation(userId, id);
    },
    async enabled(userId: string, id: string, enabled: boolean) {
      const row = await get(userId, id);
      await withControlPlaneUser(userId, () =>
        rpc(enabled ? "automations_resume" : "automations_pause", {
          projectId: row.projectId,
          automationId: id,
        }),
      );
      return get(userId, id);
    },
    async remove(userId: string, id: string) {
      const row = await get(userId, id);
      const saved = binding(userId, id);
      z.object({ ok: z.literal(true) })
        .strict()
        .parse(
          await withControlPlaneUser(userId, () =>
            rpc("automations_delete", {
              projectId: row.projectId,
              automationId: id,
            }),
          ),
        );
      const removed = db
        .select({ deletedAt: controlPlaneJobBindings.deletedAt })
        .from(controlPlaneJobBindings)
        .where(
          and(
            eq(controlPlaneJobBindings.id, saved.id),
            eq(controlPlaneJobBindings.ownerUserId, userId),
          ),
        )
        .get();
      if (!removed?.deletedAt) return invalid();
      return { deleted: true };
    },
    async run(userId: string, id: string, input: { idempotencyKey?: string }) {
      const row = await get(userId, id);
      const result = z
        .object({ run: controlPlaneAutomationRunSchema.strip() })
        .strict()
        .parse(
          await withControlPlaneUser(userId, () =>
            rpc("automations_run", {
              ...input,
              projectId: row.projectId,
              automationId: id,
            }),
          ),
        );
      binding(userId, id);
      if (result.run.automationId !== id) return invalid();
      return result.run;
    },
    async stop(userId: string, id: string, runId: string) {
      const row = await get(userId, id);
      const result = z
        .object({ stopped: z.boolean() })
        .strict()
        .parse(
          await withControlPlaneUser(userId, () =>
            rpc("controlPlaneAutomationStop", {
              projectId: row.projectId,
              automationId: id,
              runId,
            }),
          ),
        );
      binding(userId, id);
      return result;
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
        kind: "automation",
      });
      const automations = await read(
        userId,
        page.bindings.map((saved) => saved.objectId),
      );
      return {
        automations: automations.map((row) =>
          controlPlaneAutomationSchema
            .strip()
            .parse({ ...row, executionMode: row.execution.mode }),
        ),
        nextCursor: page.nextCursor,
      };
    },
    async output(userId: string, id: string, runId: string) {
      const root = binding(userId, id);
      const response = z
        .object({
          run: controlPlaneAutomationRunSchema
            .extend({
              runMode: z.literal("script"),
              output: z.string().max(7340032).nullable(),
            })
            .strip(),
          cleanupError: z.string().max(8192).nullable(),
        })
        .strict()
        .safeParse(
          await withControlPlaneUser(userId, () =>
            rpc("controlPlaneAutomationResult", {
              projectId: root.projectId,
              automationId: id,
              runId,
            }),
          ),
        );
      binding(userId, id);
      if (!response.success) return invalid();
      const value = response.data;
      if (value.run.id !== runId || value.run.automationId !== id)
        return invalid();
      let result = null;
      if (value.run.output !== null) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(value.run.output);
        } catch {
          return invalid();
        }
        const parsed =
          controlPlaneAutomationScriptResultSchema.safeParse(decoded);
        if (!parsed.success) return invalid();
        result = parsed.data;
      }
      if (result) {
        const saved = getControlPlaneJobBinding(db, userId, result.jobId);
        if (
          !saved ||
          saved.kind !== "automation-run" ||
          saved.objectId !== runId ||
          saved.sourceBindingId !== root.id ||
          saved.projectId !== root.projectId
        )
          return invalid();
      }
      return controlPlaneAutomationOutputSchema.parse({
        automationId: id,
        runId,
        status: value.run.status,
        result,
        cleanupPending:
          value.run.status === "running" && value.cleanupError !== null,
        error: value.cleanupError ?? value.run.error,
      });
    },
    async history(
      userId: string,
      id: string,
      input: { cursor?: string; limit: number },
    ) {
      await get(userId, id);
      const saved = binding(userId, id);
      const result = z
        .object({
          runs: z.array(controlPlaneAutomationRunSchema.strip()).max(100),
          nextCursor: z.string().min(1).max(1024).nullable(),
        })
        .strict()
        .safeParse(
          await withControlPlaneUser(userId, () =>
            rpc("automations_runs", {
              ...input,
              automationId: id,
              projectId: saved.projectId,
            }),
          ),
        );
      if (!result.success) return invalid();
      binding(userId, id);
      if (result.data.runs.some((run) => run.automationId !== id))
        return invalid();
      return { automationId: id, ...result.data };
    },
  };
}
export type ControlPlaneAutomationService = ReturnType<
  typeof createControlPlaneAutomationService
>;
