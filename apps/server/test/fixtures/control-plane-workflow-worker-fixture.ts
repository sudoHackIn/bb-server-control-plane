import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  createConnection,
  createControlPlaneJobBinding,
  createThread,
  getThread,
  setControlPlaneProfileAccess,
  archiveThread,
  getControlPlaneJobBinding,
  controlPlaneThreads,
  noopNotifier,
  requireControlPlaneJobDispatch,
  requireControlPlaneThreadDispatch,
} from "@bb/db";

const mode = z
  .enum(["create", "verify", "orphan", "access"])
  .parse(process.argv[2]);
const db = createConnection("/srv/bb/bb.db");
const statePath = "/srv/bb/workflow-worker-proof.json";
const savedSchema = z
  .array(
    z.object({
      threadId: z.string(),
      bindingId: z.string().uuid(),
      parentId: z.string().uuid(),
      parentRunId: z.string(),
      userId: z.string().uuid(),
      profileVersionId: z.string().uuid(),
    }),
  )
  .length(2);
try {
  if (mode === "access") {
    const input = z
      .object({
        profileId: z.string().uuid(),
        userId: z.string().uuid(),
        allowed: z.boolean(),
      })
      .strict()
      .parse(JSON.parse(process.argv[3] ?? ""));
    setControlPlaneProfileAccess(
      db,
      input.profileId,
      input.userId,
      input.allowed,
    );
    process.stdout.write(JSON.stringify({ changed: true }) + "\n");
  } else if (mode === "orphan") {
    const original = savedSchema.parse(
      JSON.parse(await readFile(statePath, "utf8")),
    );
    const storage = new Database("/srv/bb/plugins/workflows/data.db", {
      readonly: true,
    });
    try {
      const orphans = original.map((subject, index) => {
        const parent = getControlPlaneJobBinding(db, null, subject.parentId);
        assert.ok(parent?.originThreadId);
        const origin = getThread(db, parent.originThreadId);
        assert.ok(origin?.environmentId);
        const synthetic = createControlPlaneJobBinding(db, {
          kind: "workflow-run",
          objectId: `wfr_${randomUUID()}`,
          revision: 1,
          userId: subject.userId,
          projectId: origin.projectId,
          profileVersionId: subject.profileVersionId,
          originThreadId: origin.id,
          sourceBindingId: null,
        });
        assert.equal(
          storage
            .prepare("SELECT id FROM workflow_runs WHERE id = ?")
            .get(synthetic.objectId),
          undefined,
        );
        const binding = createControlPlaneJobBinding(db, {
          kind: "workflow-worker",
          objectId: randomUUID(),
          revision: 1,
          userId: subject.userId,
          projectId: origin.projectId,
          profileVersionId: subject.profileVersionId,
          originThreadId: origin.id,
          sourceBindingId: synthetic.id,
        });
        const child = createThread(db, noopNotifier, {
          providerId: "qwen-server",
          projectId: origin.projectId,
          environmentId: origin.environmentId,
          status: "idle",
          visibility: "hidden",
          originPluginId: "workflows",
          controlPlaneOwnerUserId: subject.userId,
          controlPlaneProfileVersionId: subject.profileVersionId,
          controlPlaneJobBindingId: binding.id,
          pluginMetadata: {
            pluginId: "workflows",
            metadata: {
              workflowWorker: 1,
              runId: synthetic.objectId,
              callId: `wfc_${randomUUID()}`,
              originThreadId: origin.id,
            },
          },
        });
        if (index === 1) archiveThread(db, noopNotifier, child.id);
        return { threadId: child.id, bindingId: binding.id };
      });
      process.stdout.write(JSON.stringify(orphans) + "\n");
    } finally {
      storage.close();
    }
  } else if (mode === "create") {
    const inputs = z
      .array(
        z
          .object({ parentRunId: z.string(), userId: z.string().uuid() })
          .strict(),
      )
      .length(2)
      .parse(JSON.parse(process.argv[3] ?? ""));
    const storage = new Database("/srv/bb/plugins/workflows/data.db");
    try {
      const saved = inputs.map((input) => {
        const row: unknown = storage
          .prepare(
            "SELECT authority_binding_id AS bindingId, owner_user_id AS userId, status FROM workflow_runs WHERE id = ?",
          )
          .get(input.parentRunId);
        const parentRow = z
          .object({
            bindingId: z.string().uuid(),
            userId: z.string().uuid(),
            status: z.literal("running"),
          })
          .parse(row);
        assert.equal(parentRow.userId, input.userId);
        const parent = requireControlPlaneJobDispatch(db, parentRow.bindingId);
        assert.equal(parent.binding.objectId, input.parentRunId);
        assert.ok(parent.binding.originThreadId);
        const origin = getThread(db, parent.binding.originThreadId);
        assert.ok(origin?.environmentId);
        const binding = createControlPlaneJobBinding(db, {
          kind: "workflow-worker",
          objectId: randomUUID(),
          revision: 1,
          userId: input.userId,
          projectId: parent.project.projectId,
          profileVersionId: parent.profileVersion.id,
          originThreadId: parent.binding.originThreadId,
          sourceBindingId: parent.binding.id,
        });
        const callId = `wfc_${randomUUID()}`;
        storage
          .prepare(
            `INSERT INTO workflow_calls(id,run_id,call_index,cache_key,prompt,options_json,resolved_provider,resolved_model,resolved_reasoning_level,resolved_permission_mode,status,created_at) VALUES (?,?,0,'fixture','Worker authority fixture',?,?,?,?,?,'running',?)`,
          )
          .run(
            callId,
            input.parentRunId,
            JSON.stringify({
              selection: null,
              outputSchema: null,
              title: null,
              phase: null,
            }),
            parent.profileVersion.definition.providerId,
            parent.profileVersion.definition.model,
            parent.profileVersion.definition.reasoningLevel,
            parent.profileVersion.definition.permissionMode,
            Date.now(),
          );
        const thread = createThread(db, noopNotifier, {
          providerId: parent.profileVersion.definition.providerId,
          projectId: parent.project.projectId,
          environmentId: origin.environmentId,
          status: "idle",
          visibility: "hidden",
          originPluginId: "workflows",
          pluginMetadata: {
            pluginId: "workflows",
            metadata: {
              workflowWorker: 1,
              runId: input.parentRunId,
              callId,
              originThreadId: origin.id,
            },
          },
          lifecycleOwnerThreadId: origin.id,
          parentThreadId: origin.id,
          controlPlaneOwnerUserId: input.userId,
          controlPlaneProfileVersionId: parent.profileVersion.id,
          controlPlaneJobBindingId: binding.id,
        });
        storage
          .prepare("UPDATE workflow_calls SET child_thread_id = ? WHERE id = ?")
          .run(thread.id, callId);
        assert.equal(
          requireControlPlaneThreadDispatch(db, thread.id)?.user.id,
          input.userId,
        );
        return {
          threadId: thread.id,
          bindingId: binding.id,
          parentId: parent.binding.id,
          parentRunId: input.parentRunId,
          userId: input.userId,
          profileVersionId: parent.profileVersion.id,
        };
      });
      await writeFile(statePath, JSON.stringify(saved), { mode: 0o600 });
      process.stdout.write(JSON.stringify(saved) + "\n");
    } finally {
      storage.close();
    }
  } else {
    const saved = savedSchema.parse(
      JSON.parse(await readFile(statePath, "utf8")),
    );
    for (const worker of saved) {
      const owner = db
        .select()
        .from(controlPlaneThreads)
        .where(eq(controlPlaneThreads.threadId, worker.threadId))
        .get();
      assert.equal(owner?.ownerUserId, worker.userId);
      assert.equal(owner?.profileVersionId, worker.profileVersionId);
      assert.equal(owner?.jobBindingId, worker.bindingId);
      assert.throws(() =>
        requireControlPlaneThreadDispatch(db, worker.threadId),
      );
    }
    process.stdout.write(
      JSON.stringify({
        workflowWorkerBindingsAndRevocationSurviveRestart: true,
      }) + "\n",
    );
  }
} finally {
  db.$client.close();
}
