import { z } from "zod";
import {
  requireControlPlaneThreadDispatch,
  getControlPlaneProject,
  listControlPlaneJobBindings,
  type DbConnection,
} from "@bb/db";
import {
  controlPlaneWorkflowDefinitionSchema,
  controlPlaneWorkflowDefinitionSummarySchema,
  controlPlaneWorkflowDefinitionCreateSchema,
  controlPlaneWorkflowDefinitionUpdateSchema,
  controlPlaneWorkflowDefinitionRunSchema,
  controlPlaneWorkflowRunSchema,
  type JsonValue,
} from "@bb/domain";
import { withControlPlaneUser } from "./access.js";
import {
  ownedWorkflowBinding,
  type ControlPlaneWorkflowRpc,
} from "./workflows.js";
import { ApiError } from "../errors.js";

export function createControlPlaneWorkflowDefinitions(
  db: DbConnection,
  rpc: ControlPlaneWorkflowRpc,
) {
  function binding(userId: string, id: string) {
    return ownedWorkflowBinding(db, userId, id, "workflow-definition");
  }
  function checked(
    userId: string,
    row: z.infer<typeof controlPlaneWorkflowDefinitionSummarySchema>,
  ) {
    const saved = binding(userId, row.id);
    if (
      row.projectId !== saved.projectId ||
      row.originThreadId !== saved.originThreadId ||
      row.enabled !== saved.enabled
    )
      throw new ApiError(
        502,
        "workflow_contract_error",
        "Invalid workflow definition identity",
      );
  }
  async function read(
    userId: string,
    id: string,
    method:
      | "controlPlaneDefinitionGet"
      | "controlPlaneDefinitionUpdate"
      | "controlPlaneDefinitionEnabled",
    extra: Record<string, JsonValue>,
  ) {
    binding(userId, id);
    const row = controlPlaneWorkflowDefinitionSchema.parse(
      await withControlPlaneUser(userId, () => rpc(method, { id, ...extra })),
    );
    if (row.id !== id)
      throw new ApiError(
        502,
        "workflow_contract_error",
        "Invalid workflow definition identity",
      );
    checked(userId, row);
    return row;
  }
  return {
    get: (userId: string, id: string, revision?: number) =>
      read(
        userId,
        id,
        "controlPlaneDefinitionGet",
        revision === undefined ? {} : { revision },
      ),
    update: (
      userId: string,
      id: string,
      input: z.infer<typeof controlPlaneWorkflowDefinitionUpdateSchema>,
    ) => read(userId, id, "controlPlaneDefinitionUpdate", input),
    setEnabled: (userId: string, id: string, enabled: boolean) =>
      read(userId, id, "controlPlaneDefinitionEnabled", { enabled }),
    async create(
      userId: string,
      input: z.infer<typeof controlPlaneWorkflowDefinitionCreateSchema>,
    ) {
      const context = requireControlPlaneThreadDispatch(
        db,
        input.originThreadId,
      );
      if (!context || context.user.id !== userId)
        throw new ApiError(404, "workflow_not_found", "Workflow not found");
      const row = controlPlaneWorkflowDefinitionSchema.parse(
        await withControlPlaneUser(userId, () =>
          rpc("controlPlaneDefinitionCreate", {
            ...input,
            projectId: context.project.projectId,
          }),
        ),
      );
      checked(userId, row);
      return row;
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
        kind: "workflow-definition",
      });
      const ids = page.bindings.map((row) => row.objectId);
      if (!ids.length) return { definitions: [], nextCursor: page.nextCursor };
      const result = z
        .object({
          definitions: z
            .array(controlPlaneWorkflowDefinitionSummarySchema)
            .max(50),
        })
        .strict()
        .parse(
          await withControlPlaneUser(userId, () =>
            rpc("controlPlaneDefinitions", { ids }),
          ),
        );
      for (const row of result.definitions) {
        if (!ids.includes(row.id))
          throw new ApiError(
            502,
            "workflow_contract_error",
            "Invalid workflow definition identity",
          );
        checked(userId, row);
      }
      return { definitions: result.definitions, nextCursor: page.nextCursor };
    },
    async remove(userId: string, id: string) {
      binding(userId, id);
      return z
        .object({ deleted: z.literal(true) })
        .strict()
        .parse(
          await withControlPlaneUser(userId, () =>
            rpc("controlPlaneDefinitionRemove", { id }),
          ),
        );
    },
    async run(
      userId: string,
      id: string,
      input: z.infer<typeof controlPlaneWorkflowDefinitionRunSchema>,
    ) {
      const source = binding(userId, id);
      const row = controlPlaneWorkflowRunSchema.parse(
        await withControlPlaneUser(userId, () =>
          rpc("controlPlaneDefinitionRun", { id, ...input }),
        ),
      );
      const saved = ownedWorkflowBinding(db, userId, row.id, "workflow-run");
      binding(userId, id);
      if (
        saved.sourceBindingId !== source.id ||
        row.projectId !== saved.projectId ||
        row.originThreadId !== saved.originThreadId
      )
        throw new ApiError(
          502,
          "workflow_contract_error",
          "Invalid workflow definition run identity",
        );
      return row;
    },
  };
}
