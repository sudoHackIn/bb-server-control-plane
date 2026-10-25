import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Db } from "./data.js";
import type { WorkflowService } from "./service.js";
import {
  createWorkflowDefinitions,
  definitionSchema,
  definitionSummarySchema,
} from "./definitions.js";
import { managedWorkflowRunSchema, workflowRunSummary } from "./managed-api.js";
import { assertBoundedJson } from "./schema.js";
import { toJsonValue } from "./json-value.js";
const id = z.string().min(1).max(200);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const content = { script: z.string().min(1).max(524288), args: z.unknown() };
const contract = defineRpcContract({
  controlPlaneDefinitionInventory: {
    input: z
      .object({
        projectId: id.optional(),
        cursor: z.string().uuid().nullable().default(null),
        limit: z.number().int().min(1).max(50).default(20),
      })
      .strict(),
    output: z
      .object({
        definitions: z
          .array(
            definitionSummarySchema
              .extend({ ownerUserId: z.string().uuid() })
              .strict(),
          )
          .max(50),
        nextCursor: z.string().nullable(),
      })
      .strict(),
  },
  controlPlaneDefinitionCreate: {
    input: z.object({ projectId: id, originThreadId: id, ...content }).strict(),
    output: definitionSchema,
  },
  controlPlaneDefinitions: {
    input: z.object({ ids: z.array(id).max(50) }).strict(),
    output: z
      .object({ definitions: z.array(definitionSummarySchema).max(50) })
      .strict(),
  },
  controlPlaneDefinitionGet: {
    input: z.object({ id, revision: revision.optional() }).strict(),
    output: definitionSchema,
  },
  controlPlaneDefinitionUpdate: {
    input: z.object({ id, expectedRevision: revision, ...content }).strict(),
    output: definitionSchema,
  },
  controlPlaneDefinitionEnabled: {
    input: z.object({ id, enabled: z.boolean() }).strict(),
    output: definitionSchema,
  },
  controlPlaneDefinitionRemove: {
    input: z.object({ id }).strict(),
    output: z.object({ deleted: z.literal(true) }).strict(),
  },
  controlPlaneDefinitionRun: {
    input: z.object({ id, revision, args: z.unknown().optional() }).strict(),
    output: managedWorkflowRunSchema,
  },
});
function args(value: unknown) {
  assertBoundedJson(value, "definition args", {
    bytes: 131072,
    nodes: 10000,
    depth: 32,
  });
  return toJsonValue(value, "definition args");
}
export function registerWorkflowDefinitionApi(
  bb: BbPluginApi,
  db: Db,
  service: WorkflowService,
) {
  const definitions = createWorkflowDefinitions(bb, db, service);
  bb.rpc.register(contract, {
    controlPlaneDefinitionInventory: (input) => definitions.inventory(input),
    controlPlaneDefinitionCreate: (input) =>
      definitions.create({ ...input, args: args(input.args) }),
    controlPlaneDefinitions: ({ ids }) => ({
      definitions: definitions.summaries(ids),
    }),
    controlPlaneDefinitionGet: (input) =>
      definitions.get(input.id, input.revision),
    controlPlaneDefinitionUpdate: ({ id, ...input }) =>
      definitions.update(id, { ...input, args: args(input.args) }),
    controlPlaneDefinitionEnabled: ({ id, enabled }) =>
      definitions.setEnabled(id, enabled),
    controlPlaneDefinitionRemove: ({ id }) => definitions.remove(id),
    controlPlaneDefinitionRun: async (input) =>
      workflowRunSummary(
        await definitions.run(
          input.id,
          input.revision,
          input.args === undefined ? undefined : args(input.args),
        ),
      ),
  });
}
