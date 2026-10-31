import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  controlPlaneTestRunSchema,
  jsonValueSchema,
  type ControlPlaneTestRunStart,
  type controlPlaneWorkflowInspectionSchema,
} from "@bb/domain";
import {
  ControlPlaneThreadError,
  controlPlaneTestRuns,
  controlPlaneProfileVersions,
  getControlPlaneProfileWorkflow,
  requireControlPlaneThreadOwner,
  getControlPlaneProject,
  type DbConnection,
} from "@bb/db";
import type {
  InspectionActor,
  createInspectionPolicy,
} from "./inspection-policy.js";
import type { ControlPlaneWorkflowService } from "./workflows.js";
import { assertExecutionAdmission } from "../services/system/execution-admission.js";
import { ApiError } from "../errors.js";

export function createControlPlaneTestRunService(options: {
  db: DbConnection;
  actor: InspectionActor;
  policy: ReturnType<typeof createInspectionPolicy>;
  inspect: (
    id: string,
    after: number,
    limit: number,
  ) => Promise<z.infer<typeof controlPlaneWorkflowInspectionSchema>>;
  execution: ControlPlaneWorkflowService;
}) {
  const { db, actor, policy, execution } = options;
  const requester =
    actor.kind === "user" ? `user:${actor.userId}` : `admin:${actor.login}`;
  function missing(): never {
    throw new ApiError(404, "test_run_not_found", "Test run is unavailable");
  }
  function read(id: string) {
    const row = db
      .select()
      .from(controlPlaneTestRuns)
      .where(eq(controlPlaneTestRuns.id, id))
      .get();
    if (!row || !actor.authorized()) return missing();
    if (row.state === "started") {
      const target = policy.workflow(
        actor.kind === "user" ? actor.userId : "admin",
        row.runId,
      );
      if (
        target.ownerUserId !== row.ownerUserId ||
        target.projectId !== row.projectId
      )
        return missing();
    } else if (actor.kind === "user" && row.ownerUserId !== actor.userId)
      return missing();
    policy.workflow(
      actor.kind === "user" ? actor.userId : "admin",
      row.sourceRunId,
    );
    policy.project(row.projectId);
    return row;
  }
  function summary(row: typeof controlPlaneTestRuns.$inferSelect) {
    return controlPlaneTestRunSchema.parse({
      id: row.id,
      runId: row.runId,
      sourceRunId: row.sourceRunId,
      sourceProjectId: row.sourceProjectId,
      ownerUserId: row.ownerUserId,
      projectId: row.projectId,
      requestedBy: row.requestedBy,
      target: JSON.parse(row.targetJson),
      input: JSON.parse(row.inputJson),
      sourceHash: row.sourceHash,
      testedSourceHash: row.testedSourceHash,
      profile: JSON.parse(row.profileJson),
      state: row.state,
      createdAt: row.createdAt,
    });
  }
  return {
    get: (id: string) => summary(read(id)),
    find(runId: string) {
      policy.workflow(actor.kind === "user" ? actor.userId : "admin", runId);
      const row = db
        .select({ id: controlPlaneTestRuns.id })
        .from(controlPlaneTestRuns)
        .where(eq(controlPlaneTestRuns.runId, runId))
        .get();
      return { testRun: row ? summary(read(row.id)) : null };
    },
    async start(input: ControlPlaneTestRunStart) {
      assertExecutionAdmission(db);
      if (!actor.authorized()) return missing();
      if (actor.kind === "user" && input.executionUserId !== undefined)
        throw new ApiError(
          400,
          "invalid_request",
          "Execution identity is derived from your session",
        );
      const userId =
        actor.kind === "user" ? actor.userId : input.executionUserId;
      if (!userId)
        throw new ApiError(
          400,
          "execution_user_required",
          "Choose a test execution user",
        );
      const source = policy.workflow(
        actor.kind === "user" ? actor.userId : "admin",
        input.sourceRunId,
      );
      const epoch = policy.epoch(source.projectId, source.ownerUserId);
      const context = () => {
        try {
          if (!actor.authorized()) return missing();
          const value = requireControlPlaneThreadOwner(db, {
            projectId: input.projectId,
            ownerUserId: userId,
            profileVersionId: input.target.profileVersionId,
            providerId: "qwen-server",
            relatedThreadIds: [],
          });
          const project = getControlPlaneProject(db, userId, input.projectId);
          if (!value || !project || !["owner", "runner"].includes(project.role))
            return missing();
          if (policy.epoch(source.projectId, source.ownerUserId) !== epoch)
            return missing();
          return value;
        } catch (error) {
          if (error instanceof ControlPlaneThreadError) return missing();
          throw error;
        }
      };
      const selected = context();
      const captured = await options.inspect(input.sourceRunId, -1, 1);
      if (Buffer.byteLength(JSON.stringify(captured.input)) > 131072)
        throw new ApiError(
          400,
          "test_input_too_large",
          "Captured input exceeds test limits",
        );
      let script: string;
      if (input.target.kind === "published") {
        const workflow = getControlPlaneProfileWorkflow(
          db,
          input.target.profileVersionId,
        );
        if (!workflow)
          throw new ApiError(
            400,
            "workflow_profile_required",
            "Select a published workflow agent",
          );
        script = workflow.script;
      } else {
        if (selected.profileVersion.definition.workflow)
          throw new ApiError(
            400,
            "worker_profile_required",
            "Select an ordinary worker profile for a draft workflow",
          );
        const draft =
          actor.kind === "admin"
            ? await execution.definitions.getForAdministration({
                definitionId: input.target.definitionId,
                revision: input.target.revision,
              })
            : await execution.definitions.get(
                userId,
                input.target.definitionId,
                input.target.revision,
              );
        if (
          !draft.enabled ||
          draft.id !== input.target.definitionId ||
          draft.revision !== input.target.revision
        )
          return missing();
        script = draft.script;
      }
      context();
      const targetJson = JSON.stringify(input.target);
      const previous = db
        .select()
        .from(controlPlaneTestRuns)
        .where(
          and(
            eq(controlPlaneTestRuns.requestedBy, requester),
            eq(controlPlaneTestRuns.idempotencyKey, input.idempotencyKey),
          ),
        )
        .get();
      if (
        previous &&
        (previous.sourceRunId !== input.sourceRunId ||
          previous.projectId !== input.projectId ||
          previous.ownerUserId !== userId ||
          previous.targetJson !== targetJson)
      )
        throw new ApiError(
          409,
          "idempotency_conflict",
          "Test key is already used for another configuration",
        );
      const row =
        previous ??
        db
          .insert(controlPlaneTestRuns)
          .values({
            id: randomUUID(),
            runId: `wfa_${createHash("sha256")
              .update(JSON.stringify(["test", requester, input.idempotencyKey]))
              .digest("hex")}`,
            sourceRunId: input.sourceRunId,
            sourceProjectId: source.projectId,
            ownerUserId: userId,
            projectId: input.projectId,
            requestedBy: requester,
            idempotencyKey: input.idempotencyKey,
            targetJson,
            inputJson: JSON.stringify(captured.input),
            sourceHash: captured.sourceHash,
            testedSourceHash: createHash("sha256").update(script).digest("hex"),
            profileJson: JSON.stringify(selected.profileVersion.definition),
            script,
            state: "pending",
            createdAt: Date.now(),
          })
          .returning()
          .get();
      if (row.state !== "started") {
        context();
        const version = db
          .select()
          .from(controlPlaneProfileVersions)
          .where(
            eq(controlPlaneProfileVersions.id, input.target.profileVersionId),
          )
          .get();
        if (!version || JSON.stringify(version.definition) !== row.profileJson)
          return missing();
        await execution.startAgent(userId, {
          runId: row.runId,
          projectId: row.projectId,
          profileVersionId: input.target.profileVersionId,
          script: row.script,
          args: jsonValueSchema.parse(JSON.parse(row.inputJson)),
        });
        db.update(controlPlaneTestRuns)
          .set({ state: "started" })
          .where(eq(controlPlaneTestRuns.id, row.id))
          .run();
      }
      return summary(read(row.id));
    },
  };
}
