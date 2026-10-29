import type { z } from "zod";
import { createHash } from "node:crypto";
import { and, asc, eq, gt, isNull, like } from "drizzle-orm";
import {
  controlPlaneJobBindings,
  controlPlaneProfileVersions,
  controlPlaneProjectAccess,
  accessibleControlPlaneProjects,
  getControlPlaneAgentRunByKey,
  getControlPlaneJobBinding,
  getControlPlaneProfileWorkflow,
  getControlPlaneProject,
  getControlPlaneProfile,
  requireControlPlaneThreadOwner,
  type DbConnection,
} from "@bb/db";
import {
  controlPlaneAgentRunSchema,
  type controlPlaneWorkflowRunSchema,
  type ControlPlaneAgentRunStart,
} from "@bb/domain";
import type { ControlPlaneThreadService } from "./threads.js";
import {
  ownedWorkflowBinding,
  type ControlPlaneWorkflowService,
} from "./workflows.js";
import { ApiError } from "../errors.js";
import { assertExecutionAdmission } from "../services/system/execution-admission.js";

export function createControlPlaneAgentWorkflowService(
  db: DbConnection,
  threads: ControlPlaneThreadService,
  workflows: ControlPlaneWorkflowService,
) {
  const isWorkflow = (id: string) => /^wfa_[a-f0-9]{64}$/u.test(id);
  function conflict(): never {
    throw new ApiError(
      409,
      "idempotency_conflict",
      "Idempotency key was used for another request",
    );
  }
  function binding(userId: string, id: string) {
    if (!isWorkflow(id))
      throw new ApiError(404, "run_not_found", "Run not found");
    const saved = ownedWorkflowBinding(db, userId, id, "workflow-run");
    if (!getControlPlaneProfileWorkflow(db, saved.profileVersionId))
      throw new ApiError(404, "run_not_found", "Run not found");
    return saved;
  }
  async function get(userId: string, id: string) {
    if (!isWorkflow(id))
      return controlPlaneAgentRunSchema.parse(threads.run(userId, id));
    binding(userId, id);
    const workflow = await workflows.get(userId, id);
    return summary(userId, workflow);
  }
  function summary(
    userId: string,
    workflow: z.infer<typeof controlPlaneWorkflowRunSchema>,
  ) {
    const saved = binding(userId, workflow.id);
    return controlPlaneAgentRunSchema.parse({
      runId: workflow.id,
      threadId: null,
      workflowRunId: workflow.id,
      strategy: "workflow",
      projectId: saved.projectId,
      profileId: profileId(saved.profileVersionId),
      profileVersionId: saved.profileVersionId,
      source: "manual",
      title: workflow.name,
      status: workflow.status,
      createdAt: workflow.createdAt,
      updatedAt:
        workflow.finishedAt ?? workflow.startedAt ?? workflow.createdAt,
    });
  }
  function profileId(versionId: string) {
    const row = db
      .select({ profileId: controlPlaneProfileVersions.profileId })
      .from(controlPlaneProfileVersions)
      .where(eq(controlPlaneProfileVersions.id, versionId))
      .get();
    if (!row) throw new ApiError(404, "run_not_found", "Run not found");
    return row.profileId;
  }
  const admissions = new Map<
    string,
    Promise<z.infer<typeof controlPlaneAgentRunSchema>>
  >();
  async function admit(userId: string, input: ControlPlaneAgentRunStart) {
    assertExecutionAdmission(db);
    const project = getControlPlaneProject(db, userId, input.projectId);
    if (!project || !["owner", "runner"].includes(project.role))
      throw new ApiError(404, "project_not_found", "Project not found");
    const selected = db
      .select({ profileId: controlPlaneProfileVersions.profileId })
      .from(controlPlaneProfileVersions)
      .where(eq(controlPlaneProfileVersions.id, input.profileVersionId))
      .get();
    if (
      !selected ||
      !getControlPlaneProfile(
        db,
        userId,
        selected.profileId,
        input.profileVersionId,
      )
    )
      throw new ApiError(404, "profile_not_found", "Profile not found");
    const context = requireControlPlaneThreadOwner(db, {
      projectId: input.projectId,
      ownerUserId: userId,
      profileVersionId: input.profileVersionId,
      providerId: "qwen-server",
      relatedThreadIds: [],
    });
    if (!context)
      throw new ApiError(404, "profile_not_found", "Profile not found");
    const id = `wfa_${createHash("sha256")
      .update(JSON.stringify([userId, input.idempotencyKey]))
      .digest("hex")}`;
    const existing = db
      .select({ id: controlPlaneJobBindings.id })
      .from(controlPlaneJobBindings)
      .where(
        and(
          eq(controlPlaneJobBindings.ownerUserId, userId),
          eq(controlPlaneJobBindings.kind, "workflow-run"),
          eq(controlPlaneJobBindings.objectId, id),
        ),
      )
      .get();
    if (!context.profileVersion.definition.workflow) {
      if (existing) conflict();
      return controlPlaneAgentRunSchema.parse(
        await threads.startRun(userId, input),
      );
    }
    if (getControlPlaneAgentRunByKey(db, userId, input.idempotencyKey))
      conflict();
    if (existing) {
      const previous = getControlPlaneJobBinding(db, userId, existing.id);
      if (
        !previous ||
        previous.projectId !== input.projectId ||
        previous.profileVersionId !== input.profileVersionId
      )
        conflict();
    }
    const source = getControlPlaneProfileWorkflow(db, input.profileVersionId);
    if (!source)
      throw new ApiError(404, "profile_not_found", "Profile not found");
    await workflows.startAgent(userId, {
      runId: id,
      projectId: input.projectId,
      profileVersionId: input.profileVersionId,
      script: source.script,
      args: input.input,
    });
    return get(userId, id);
  }
  return {
    isWorkflow,
    get,
    async start(userId: string, input: ControlPlaneAgentRunStart) {
      const key = JSON.stringify([userId, input.idempotencyKey]);
      const previous = admissions.get(key);
      const current = previous
        ? previous.catch(() => {}).then(() => admit(userId, input))
        : admit(userId, input);
      admissions.set(key, current);
      try {
        return await current;
      } finally {
        if (admissions.get(key) === current) admissions.delete(key);
      }
    },
    async list(
      userId: string,
      options: { projectId?: string; cursor: string | null; limit: number },
    ) {
      if (
        options.projectId &&
        !getControlPlaneProject(db, userId, options.projectId)
      )
        throw new ApiError(404, "project_not_found", "Project not found");
      const regularPage = threads.listRuns(userId, options);
      const regular = regularPage.runs.map((run) =>
        controlPlaneAgentRunSchema.parse(run),
      );
      const accessible = accessibleControlPlaneProjects(db)
        .where(eq(controlPlaneProjectAccess.userId, userId))
        .as("agent_workflow_projects");
      const rows = db
        .select({ id: controlPlaneJobBindings.objectId })
        .from(controlPlaneJobBindings)
        .innerJoin(
          accessible,
          eq(accessible.projectId, controlPlaneJobBindings.projectId),
        )
        .where(
          and(
            eq(controlPlaneJobBindings.ownerUserId, userId),
            eq(controlPlaneJobBindings.kind, "workflow-run"),
            like(controlPlaneJobBindings.objectId, "wfa_%"),
            isNull(controlPlaneJobBindings.deletedAt),
            options.projectId
              ? eq(controlPlaneJobBindings.projectId, options.projectId)
              : undefined,
            options.cursor
              ? gt(controlPlaneJobBindings.objectId, options.cursor)
              : undefined,
          ),
        )
        .orderBy(asc(controlPlaneJobBindings.objectId))
        .limit(options.limit + 1)
        .all();
      const native = await Promise.all(
        rows.map(async (row) => {
          const found = await workflows.find(userId, row.id);
          return found ? summary(userId, found) : null;
        }),
      );
      const runs = [...regular, ...native.filter((row) => row !== null)].sort(
        (a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0),
      );
      const nextCursor =
        runs.length > options.limit || regularPage.nextCursor !== null
          ? (runs[Math.min(options.limit, runs.length) - 1]?.runId ?? null)
          : null;
      return { runs: runs.slice(0, options.limit), nextCursor };
    },
    async result(userId: string, id: string) {
      const run = await get(userId, id);
      if (!isWorkflow(id))
        return { run, text: threads.result(userId, id).text };
      const value = await workflows.result(userId, id);
      const workflow = await workflows.get(userId, id);
      return {
        run,
        text: value.available
          ? typeof value.value === "string"
            ? value.value
            : JSON.stringify(value.value, null, 2)
          : workflow.error,
      };
    },
    async cancel(userId: string, id: string) {
      binding(userId, id);
      await workflows.stop(userId, id);
      return { ok: true as const };
    },
  };
}
export type ControlPlaneAgentWorkflowService = ReturnType<
  typeof createControlPlaneAgentWorkflowService
>;
