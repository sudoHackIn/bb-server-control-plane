import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  controlPlaneJobBindings,
  getControlPlaneJobBinding,
  getControlPlaneProject,
  getInstalledPluginRegistration,
  listControlPlaneJobBindings,
  type DbConnection,
} from "@bb/db";
import {
  controlPlaneAutomationSchema,
  controlPlaneAutomationRunSchema,
  type JsonValue,
} from "@bb/domain";
import { ApiError } from "../errors.js";
import type { PluginService } from "../services/plugins/plugin-service.js";
import { BUILTIN_AUTOMATIONS_PLUGIN_ID } from "../services/plugins/builtin-registry.js";
import { withControlPlaneUser } from "./access.js";

type Operation = "controlPlaneAutomationReads" | "automations_runs";
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
      .array(controlPlaneAutomationSchema.strip())
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
    return rows[0] ?? missing();
  }
  return {
    get,
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
      return { automations, nextCursor: page.nextCursor };
    },
    async history(
      userId: string,
      id: string,
      input: { cursor?: string; limit: number },
    ) {
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
