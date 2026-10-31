import { createControlPlaneTestRunService } from "./test-runs.js";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { createControlPlaneThreadStreams } from "./thread-stream.js";
import { controlPlaneInspectionRunSchema } from "@bb/domain";
import type { AppDeps } from "../types.js";
import {
  createInspectionPolicy,
  type InspectionActor,
} from "./inspection-policy.js";
import { withControlPlaneService } from "./access.js";
import { withControlPlaneInspectionRead } from "./inspection-context.js";
import {
  createControlPlaneWorkflowService,
  type ControlPlaneWorkflowRpc,
} from "./workflows.js";
import { createControlPlaneThreadService } from "./threads.js";

export function createControlPlaneInspectionService(
  deps: AppDeps,
  rpc: ControlPlaneWorkflowRpc,
) {
  const execution = createControlPlaneWorkflowService(deps.db, rpc);
  const streamPool = createControlPlaneThreadStreams(deps.hub);
  return {
    close: () => streamPool.close(),
    forActor(actor: InspectionActor) {
      const policy = createInspectionPolicy(deps.db, actor);
      const key = actor.kind === "user" ? actor.userId : `admin:${actor.login}`;
      function readableWorker(id: string, runId: string) {
        try {
          policy.thread(id, runId);
          return true;
        } catch {
          return false;
        }
      }
      const native = createControlPlaneWorkflowService(deps.db, rpc, {
        binding: policy.workflow,
        rpc: async (method, input) => {
          const { runId } = z.object({ runId: z.string() }).parse(input);
          const before = policy.workflow(key, runId);
          const epoch = policy.epoch(before.projectId, before.ownerUserId);
          const value = await withControlPlaneInspectionRead(() =>
            withControlPlaneService(() => rpc(method, input)),
          );
          const after = policy.workflow(key, runId);
          if (
            before.id !== after.id ||
            before.projectId !== after.projectId ||
            before.ownerUserId !== after.ownerUserId ||
            before.originThreadId !== after.originThreadId ||
            before.profileVersionId !== after.profileVersionId ||
            policy.epoch(after.projectId, after.ownerUserId) !== epoch
          )
            throw new ApiError(
              404,
              "inspection_not_found",
              "Inspection access changed",
            );
          return value;
        },
        thread: readableWorker,
      });
      const workflows = {
        inspect: (id: string, after: number, limit: number) =>
          native.inspect(key, id, after, limit),
        call: (id: string, callId: string) =>
          native.inspectCall(key, id, callId),
        trace: (
          id: string,
          attemptId: string | null,
          after: number,
          limit: number,
        ) => native.trace(key, id, attemptId, after, limit),
        result: (id: string) => native.result(key, id),
      };
      function threads(rootRunId: string | null, rootThreadId: string | null) {
        if (rootRunId !== null) policy.workflow(key, rootRunId);
        else if (rootThreadId !== null) policy.thread(rootThreadId, null);
        const service = createControlPlaneThreadService({
          deps,
          streamPool,
          inspectionRead: (_, id) => {
            if (rootThreadId !== null && rootThreadId !== id)
              throw new Error("Inspection thread mismatch");
            return policy.thread(id, rootRunId);
          },
        });
        return {
          get: (id: string) => service.get(key, id),
          events: (id: string, after: number, limit: number) =>
            service.events(key, id, { after, limit }),
          timeline: (id: string) => service.timeline(key, id),
          olderTimeline: (
            id: string,
            before: Parameters<typeof service.olderTimeline>[2],
          ) => service.olderTimeline(key, id, before),
          details: (
            id: string,
            input: Parameters<typeof service.timelineDetails>[2],
          ) => service.timelineDetails(key, id, input),
          result: (id: string) => service.result(key, id),
          stream(id: string, after: number, signal: AbortSignal) {
            const { row, ownerUserId } = policy.thread(id, rootRunId);
            const epoch = policy.epoch(row.projectId, ownerUserId);
            return service.stream(key, id, {
              after,
              signal,
              authorized: () => {
                const current = policy.thread(id, rootRunId);
                return (
                  current.row.projectId === row.projectId &&
                  current.ownerUserId === ownerUserId &&
                  policy.epoch(row.projectId, ownerUserId) === epoch
                );
              },
            });
          },
        };
      }
      return {
        workflows,
        tests: createControlPlaneTestRunService({
          db: deps.db,
          actor,
          policy,
          inspect: workflows.inspect,
          execution,
        }),
        threads,
        async list(projectId: string, after: string | null, limit: number) {
          const project = policy.project(projectId);
          const owner = policy.reviews(projectId)
            ? null
            : actor.kind === "user"
              ? actor.userId
              : null;
          const rows = deps.db.$client
            .prepare(`SELECT kind,id,projectId,ownerUserId,title FROM (
            SELECT 'workflow' AS kind,b.object_id AS id,b.project_id AS projectId,b.owner_user_id AS ownerUserId,'Workflow run' AS title,'workflow:'||b.object_id AS cursor FROM control_plane_job_bindings b WHERE b.kind='workflow-run' AND b.revision=1 AND b.deleted_at IS NULL AND b.project_id=@project AND (@owner IS NULL OR b.owner_user_id=@owner)
            UNION ALL
            SELECT 'thread',t.id,t.project_id,c.owner_user_id,COALESCE(t.title,'Untitled conversation'),'thread:'||t.id FROM threads t JOIN control_plane_threads c ON c.thread_id=t.id LEFT JOIN control_plane_job_bindings b ON b.id=c.job_binding_id WHERE t.project_id=@project AND t.deleted_at IS NULL AND (b.kind IS NULL OR b.kind<>'workflow-worker') AND (@owner IS NULL OR c.owner_user_id=@owner)
          ) WHERE (@after IS NULL OR cursor>@after) ORDER BY cursor LIMIT @limit`)
            .all({ project: projectId, owner, after, limit: limit + 1 });
          const parsed = controlPlaneInspectionRunSchema
            .array()
            .parse(rows.slice(0, limit));
          const runs = await Promise.all(
            parsed.map(async (row) => {
              if (row.kind !== "workflow") return row;
              try {
                return { ...row, title: (await native.get(key, row.id)).name };
              } catch {
                return row;
              }
            }),
          );
          policy.project(projectId);
          if (owner === null && !policy.reviews(projectId))
            throw new ApiError(
              404,
              "inspection_not_found",
              "Diagnostic access changed",
            );
          return {
            project,
            runs,
            nextCursor:
              rows.length > limit && runs.at(-1)
                ? `${runs.at(-1)?.kind}:${runs.at(-1)?.id}`
                : null,
          };
        },
      };
    },
  };
}
export type ControlPlaneInspectionService = ReturnType<
  typeof createControlPlaneInspectionService
>;
