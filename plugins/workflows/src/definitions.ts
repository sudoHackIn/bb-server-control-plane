import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Db } from "./data.js";
import type { WorkflowService } from "./service.js";
import type { JsonValue } from "./types.js";
import { parseWorkflowSource } from "./parser.js";
import { assertBoundedJson } from "./schema.js";
import { toJsonValue } from "./json-value.js";
import { utf8Prefix } from "./utf8.js";

const headSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  projectId: z.string(),
  originThreadId: z.string(),
  bindingId: z.string(),
  revision: z.number().int().positive(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const versionSchema = z.object({
  name: z.string(),
  script: z.string(),
  argsJson: z.string(),
});
export const definitionSummarySchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    originThreadId: z.string(),
    revision: z.number().int().positive(),
    name: z.string().max(1024),
    enabled: z.boolean(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export const definitionSchema = definitionSummarySchema
  .extend({ script: z.string(), args: z.unknown() })
  .strict();

export function createWorkflowDefinitions(
  bb: BbPluginApi,
  db: Db,
  workflows: WorkflowService,
) {
  function authority() {
    const jobs = bb.server.internal_DO_NOT_USE_backgroundJobs;
    if (!jobs)
      throw new Error(
        "Managed workflow definitions require background authority",
      );
    return jobs;
  }
  function head(id: string) {
    const jobs = authority();
    const raw = db
      .prepare(`SELECT id,owner_user_id AS ownerUserId,project_id AS projectId,
      origin_thread_id AS originThreadId,binding_id AS bindingId,revision,created_at AS createdAt,updated_at AS updatedAt
      FROM workflow_definitions WHERE id=@id${jobs.userId === null ? "" : " AND owner_user_id=@owner"}`)
      .get({ id, owner: jobs.userId });
    if (!raw) throw new Error("Workflow definition not found");
    const row = headSchema.parse(raw);
    const binding = jobs.get(row.bindingId);
    if (
      !binding ||
      binding.kind !== "workflow-definition" ||
      binding.objectId !== row.id ||
      binding.revision !== 1 ||
      binding.ownerUserId !== row.ownerUserId ||
      binding.projectId !== row.projectId ||
      binding.originThreadId !== row.originThreadId ||
      binding.deletedAt !== null
    )
      throw new Error("Workflow definition not found");
    return { row, binding };
  }
  function get(id: string, revision?: number) {
    const { row, binding } = head(id);
    const selected = revision ?? row.revision;
    const value = db
      .prepare(`SELECT name,script,args_json AS argsJson FROM workflow_definition_versions
      WHERE definition_id=? AND revision=?`)
      .get(id, selected);
    if (!value) throw new Error("Workflow definition version not found");
    const version = versionSchema.parse(value);
    const args: unknown = JSON.parse(version.argsJson);
    return {
      id,
      projectId: row.projectId,
      originThreadId: row.originThreadId,
      revision: selected,
      name: version.name,
      enabled: binding.enabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      script: version.script,
      args: toJsonValue(args, "definition args"),
    };
  }
  function validated(script: string, args: JsonValue) {
    const parsed = parseWorkflowSource(script);
    assertBoundedJson(args, "definition args", {
      bytes: 131072,
      nodes: 10000,
      depth: 32,
    });
    return {
      name: utf8Prefix(parsed.metadata.name, 1024),
      script,
      argsJson: JSON.stringify(args),
    };
  }
  async function create(input: {
    projectId: string;
    originThreadId: string;
    script: string;
    args: JsonValue;
  }) {
    const jobs = authority();
    const content = validated(input.script, input.args);
    const origin = jobs.readOrigin(input.originThreadId);
    if (origin.projectId !== input.projectId)
      throw new Error("Workflow definition project mismatch");
    const id = `wfd_${randomUUID()}`;
    const binding = await jobs.bind({
      kind: "workflow-definition",
      objectId: id,
      revision: 1,
      projectId: input.projectId,
      originThreadId: input.originThreadId,
      profileVersionId: null,
      sourceBindingId: null,
    });
    try {
      jobs.withAuthority(binding.id, () =>
        db
          .transaction(() => {
            const now = Date.now();
            db.prepare(`INSERT INTO workflow_definitions(id,owner_user_id,project_id,origin_thread_id,binding_id,revision,created_at,updated_at)
          VALUES(?,?,?,?,?,1,?,?)`).run(
              id,
              binding.ownerUserId,
              input.projectId,
              input.originThreadId,
              binding.id,
              now,
              now,
            );
            db.prepare(
              `INSERT INTO workflow_definition_versions(definition_id,revision,name,script,args_json) VALUES(?,1,?,?,?)`,
            ).run(id, content.name, content.script, content.argsJson);
          })
          .immediate(),
      );
    } catch (error) {
      try {
        await jobs.remove(binding.id);
      } catch (cleanup) {
        bb.log.error(
          `Could not retire workflow definition reservation ${binding.id}: ${String(cleanup)}`,
        );
      }
      throw error;
    }
    return get(id);
  }
  function update(
    id: string,
    input: { expectedRevision: number; script: string; args: JsonValue },
  ) {
    const { row } = head(id);
    const content = validated(input.script, input.args);
    authority().readOrigin(row.originThreadId);
    db.transaction(() => {
      head(id);
      const changed = db
        .prepare(
          `UPDATE workflow_definitions SET revision=revision+1,updated_at=? WHERE id=? AND revision=?`,
        )
        .run(Date.now(), id, input.expectedRevision);
      if (changed.changes !== 1)
        throw new Error("Workflow definition revision conflict");
      db.prepare(
        `INSERT INTO workflow_definition_versions(definition_id,revision,name,script,args_json) VALUES(?,?,?,?,?)`,
      ).run(
        id,
        input.expectedRevision + 1,
        content.name,
        content.script,
        content.argsJson,
      );
    }).immediate();
    return get(id);
  }
  function summaries(ids: string[]) {
    return ids.flatMap((id) => {
      try {
        const { row, binding } = head(id);
        const name = z
          .string()
          .parse(
            db
              .prepare(
                "SELECT name FROM workflow_definition_versions WHERE definition_id=? AND revision=?",
              )
              .pluck()
              .get(id, row.revision),
          );
        return [
          {
            id,
            projectId: row.projectId,
            originThreadId: row.originThreadId,
            revision: row.revision,
            name,
            enabled: binding.enabled,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          },
        ];
      } catch {
        return [];
      }
    });
  }
  return {
    get,
    create,
    update,
    summaries,
    inventory(input: {
      projectId?: string;
      cursor: string | null;
      limit: number;
    }) {
      const page = authority().list({ ...input, kind: "workflow-definition" });
      return {
        definitions: page.bindings.flatMap((binding) =>
          summaries([binding.objectId]).map((summary) => ({
            ...summary,
            ownerUserId: binding.ownerUserId,
          })),
        ),
        nextCursor: page.nextCursor,
      };
    },
    async setEnabled(id: string, enabled: boolean) {
      const { row } = head(id);
      await authority().setEnabled(row.bindingId, enabled);
      return get(id);
    },
    async remove(id: string) {
      const { row } = head(id);
      await authority().remove(row.bindingId);
      return { deleted: true as const };
    },
    async run(id: string, revision: number, args: JsonValue | undefined) {
      const saved = get(id, revision);
      const { row } = head(id);
      return authority().withAuthority(row.bindingId, () =>
        workflows.start({
          projectId: saved.projectId,
          originThreadId: saved.originThreadId,
          source: saved.script,
          args: args === undefined ? saved.args : args,
          resumedFromRunId: null,
          sourceBindingId: row.bindingId,
        }),
      );
    },
  };
}
