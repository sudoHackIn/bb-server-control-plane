import { listThreadEventRows } from "../services/threads/thread-data.js";
import { and, eq, inArray, or, gt, ne } from "drizzle-orm";
import { z } from "zod";
import {
  controlPlaneAgentInvocations as calls,
  CONTROL_PLANE_AGENT_INVOCATION_LIMITS,
  controlPlaneJobBindings,
  controlPlaneThreads,
  ControlPlaneThreadError,
  ControlPlaneJobError,
  getThread,
  requireControlPlaneInvocationTarget,
  requireControlPlaneInvocation,
  reserveControlPlaneAgentInvocation,
} from "@bb/db";
import type { JsonValue } from "@bb/domain";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { assertExecutionAdmission } from "../services/system/execution-admission.js";
import { stopThreadForCurrentState } from "../services/threads/thread-lifecycle.js";
import { resolveThreadHostCommandEnvironment } from "../services/threads/thread-command-environment.js";
import {
  currentControlPlanePrincipal,
  withControlPlaneService,
  withControlPlaneUser,
} from "./access.js";
import { assertControlPlaneInspectionMutationAllowed } from "./inspection-context.js";
import { createControlPlaneThreadService } from "./threads.js";
import {
  createControlPlaneWorkflowService,
  type ControlPlaneWorkflowRpc,
} from "./workflows.js";
import { createControlPlaneAgentWorkflowService } from "./agent-workflows.js";

const parentSchema = z
  .object({
    kind: z.enum(["thread", "workflow"]),
    id: z.string().min(1).max(200),
  })
  .strict();
const inputSchema = z
  .object({
    versionId: z.string().uuid(),
    input: z
      .string()
      .min(1)
      .max(131072)
      .refine((value) => Buffer.byteLength(value) <= 131072),
    key: z.string().min(1).max(200),
  })
  .strict();
function maintenance(error: unknown) {
  return (
    (error instanceof ControlPlaneThreadError ||
      error instanceof ControlPlaneJobError) &&
    error.reason === "maintenance"
  );
}
type Parent = z.infer<typeof parentSchema>;
type Input = z.infer<typeof inputSchema>;

export function createControlPlaneAgentInvocations(
  deps: AppDeps,
  rpc: ControlPlaneWorkflowRpc,
) {
  const threads = createControlPlaneThreadService({ deps });
  const workflows = createControlPlaneWorkflowService(deps.db, rpc);
  const agents = createControlPlaneAgentWorkflowService(
    deps.db,
    threads,
    workflows,
  );
  const active = new Map<string, Promise<JsonValue>>();
  const controllers = new Set<AbortController>();
  const cleanupWarnings = new Set<string>();
  let stopWorkflow: ((id: string) => Promise<boolean>) | null = null;
  let closed = false;
  let cursor = "";
  let reconciling: Promise<void> | null = null;
  const timer = setInterval(() => void reconcile().catch(() => {}), 1000);
  timer.unref();
  function resolve(parent: Parent, versionId: string) {
    assertControlPlaneInspectionMutationAllowed();
    const context = requireControlPlaneInvocationTarget(
      deps.db,
      parentSchema.parse(parent),
      z.string().uuid().parse(versionId),
    );
    const actor = currentControlPlanePrincipal();
    if (actor?.kind === "user" && actor.userId !== context.user.id)
      throw new ApiError(
        403,
        "invocation_denied",
        "Agent invocation is not authorized",
      );
    return context;
  }
  async function cancel(call: typeof calls.$inferSelect) {
    const fenced = deps.db
      .update(calls)
      .set({ state: "cancelled", cleanupPending: true })
      .where(and(eq(calls.id, call.id), ne(calls.state, "succeeded")))
      .returning()
      .get();
    if (!fenced) return;
    call = fenced;
    if (!call.runId) {
      const workflow = deps.db
        .select()
        .from(controlPlaneJobBindings)
        .where(eq(controlPlaneJobBindings.objectId, call.workflowRunId))
        .get();
      const thread = deps.db
        .select()
        .from(controlPlaneThreads)
        .where(eq(controlPlaneThreads.runIdempotencyKey, call.childKey))
        .get();
      call = {
        ...call,
        runId: workflow ? call.workflowRunId : (thread?.threadId ?? null),
      };
    }
    if (call.runId?.startsWith("wfa_")) {
      if (!stopWorkflow) throw new Error("Workflow cleanup is unavailable");
      await withControlPlaneService(() =>
        stopWorkflow?.(call.runId ?? call.workflowRunId),
      );
    } else {
      const run = call.runId ? getThread(deps.db, call.runId) : null;
      if (run)
        await stopThreadForCurrentState(
          deps,
          run,
          resolveThreadHostCommandEnvironment({ db: deps.db, thread: run }),
        );
    }
    deps.db
      .update(calls)
      .set({ cleanupPending: false })
      .where(eq(calls.id, call.id))
      .run();
    cleanupWarnings.delete(call.id);
  }
  async function execute(
    parent: Parent,
    input: Input,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const context = resolve(parent, input.versionId);
    if (
      parent.kind === "thread" &&
      !["active", "starting"].includes(
        getThread(deps.db, parent.id)?.status ?? "",
      )
    )
      throw new Error("Invoking thread is not active");
    let call = reserveControlPlaneAgentInvocation(deps.db, parent, input);
    const callId = call.id;
    async function cancelCurrent() {
      const current = deps.db
        .select()
        .from(calls)
        .where(eq(calls.id, callId))
        .get();
      if (current && current.state !== "succeeded") await cancel(current);
    }
    const cleanup: { promise: Promise<void> | null } = { promise: null };
    const onAbort = () => {
      cleanup.promise = cancelCurrent();
      void cleanup.promise.catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal.aborted) throw new Error("Agent invocation cancelled");
      if (["failed", "cancelled"].includes(call.state))
        throw new Error(
          `Agent invocation ${call.state}; use a new call key to start new work`,
        );
      if (call.state !== "succeeded") {
        if (
          Date.now() >
          call.createdAt + CONTROL_PLANE_AGENT_INVOCATION_LIMITS.timeoutMs
        )
          throw new Error("Agent invocation deadline expired");
        const child = await withControlPlaneUser(context.user.id, () =>
          agents.start(context.user.id, {
            projectId: context.project.projectId,
            profileVersionId: input.versionId,
            input: input.input,
            source: "manual",
            idempotencyKey: call.childKey,
          }),
        );
        resolve(parent, input.versionId);
        call = deps.db
          .update(calls)
          .set({ runId: child.runId, state: "running" })
          .where(
            and(
              eq(calls.id, call.id),
              inArray(calls.state, ["pending", "running"]),
            ),
          )
          .returning()
          .get();
        if (!call)
          throw new Error("Agent invocation cancelled during admission");
      }
      if (!call.runId) throw new Error("Agent invocation has no admitted run");
      const runId = call.runId;
      const deadline =
        call.createdAt + CONTROL_PLANE_AGENT_INVOCATION_LIMITS.timeoutMs;
      async function pause() {
        await new Promise<void>((finish) => {
          const timer = setTimeout(done, 100);
          function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            finish();
          }
          signal.addEventListener("abort", done, { once: true });
        });
      }
      while (true) {
        const current = deps.db
          .select({ state: calls.state, cleanupPending: calls.cleanupPending })
          .from(calls)
          .where(eq(calls.id, callId))
          .get();
        if (
          closed ||
          signal.aborted ||
          !current ||
          current.cleanupPending ||
          ["failed", "cancelled"].includes(current.state) ||
          (call.state !== "succeeded" && Date.now() > deadline)
        )
          throw new Error("Agent invocation cancelled or timed out");
        try {
          resolve(parent, input.versionId);
        } catch (error) {
          if (!maintenance(error)) throw error;
          await pause();
          continue;
        }
        if (
          parent.kind === "thread" &&
          !["active", "starting"].includes(
            getThread(deps.db, parent.id)?.status ?? "",
          )
        )
          throw new Error("Invoking thread stopped");
        if (parent.kind === "workflow") {
          const binding = deps.db
            .select()
            .from(controlPlaneJobBindings)
            .where(eq(controlPlaneJobBindings.id, parent.id))
            .get();
          if (
            !binding ||
            !["running", "queued"].includes(
              (await workflows.get(context.user.id, binding.objectId)).status,
            )
          )
            throw new Error("Invoking workflow stopped");
        }
        const result = await withControlPlaneUser(context.user.id, () =>
          agents.result(context.user.id, runId),
        );
        if (closed || signal.aborted)
          throw new Error("Agent invocation cancelled");
        try {
          resolve(parent, input.versionId);
        } catch (error) {
          if (!maintenance(error)) throw error;
          await pause();
          continue;
        }
        const failed = ["error", "failed", "cancelled"].includes(
          result.run.status,
        );
        if (failed) throw new Error("Invoked agent failed or was cancelled");
        const completed =
          result.run.strategy === "conversation" && result.run.status === "idle"
            ? listThreadEventRows(deps.db, {
                threadId: runId,
                types: ["turn/completed"],
                limit: 1,
                order: "desc",
              })[0]
            : null;
        if (
          completed?.type === "turn/completed" &&
          completed.data.status !== "completed"
        )
          throw new Error("Invoked conversation was interrupted or failed");
        if (
          result.run.status === "succeeded" ||
          (completed?.type === "turn/completed" &&
            completed.data.status === "completed")
        ) {
          const value: JsonValue = {
            type: "agent-invocation-result",
            invocationId: call.id,
            runId: call.runId,
            projectId: call.projectId,
            profileVersionId: call.profileVersionId,
            strategy: result.run.strategy,
            output: result.text,
          };
          if (Buffer.byteLength(JSON.stringify(value)) > 1048576)
            throw new Error("Agent invocation result exceeds 1 MiB");
          const committed = deps.db
            .update(calls)
            .set({ state: "succeeded" })
            .where(
              and(
                eq(calls.id, call.id),
                inArray(calls.state, ["pending", "running", "succeeded"]),
                eq(calls.cleanupPending, false),
              ),
            )
            .returning()
            .get();
          if (!committed)
            throw new Error(
              "Agent invocation cancelled before result admission",
            );
          return value;
        }
        await pause();
      }
    } catch (error) {
      if (cleanup.promise) await cleanup.promise.catch(() => {});
      await cancelCurrent();
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  function reconcile(): Promise<void> {
    if (closed) return Promise.resolve();
    if (reconciling) return reconciling;
    reconciling = withControlPlaneService(async () => {
      const rows = deps.db
        .select()
        .from(calls)
        .where(
          and(
            gt(calls.id, cursor),
            or(
              inArray(calls.state, ["pending", "running"]),
              eq(calls.cleanupPending, true),
            ),
          ),
        )
        .orderBy(calls.id)
        .limit(64)
        .all();
      cursor = rows.length === 64 ? rows[63].id : "";
      for (const row of rows) {
        if (closed) break;
        let invalid = row.cleanupPending;
        if (!invalid) {
          try {
            requireControlPlaneInvocation(deps.db, row);
          } catch (error) {
            if (maintenance(error)) continue;
            invalid = true;
          }
        }
        if (!invalid && row.parentKind === "workflow") {
          const binding = deps.db
            .select()
            .from(controlPlaneJobBindings)
            .where(eq(controlPlaneJobBindings.id, row.parentId))
            .get();
          if (binding) {
            try {
              const parent = await workflows.get(
                row.ownerUserId,
                binding.objectId,
              );
              invalid = !["queued", "running"].includes(parent.status);
            } catch {
              continue;
            }
          }
        }
        if (invalid)
          await cancel(row).catch((error: unknown) => {
            if (cleanupWarnings.has(row.id)) return;
            cleanupWarnings.add(row.id);
            deps.logger.warn(
              {
                invocationId: row.id,
                error:
                  error instanceof Error
                    ? error.message
                    : "Unknown cleanup failure",
              },
              "Delegated agent cleanup will retry",
            );
          });
      }
    }).finally(() => {
      reconciling = null;
    });
    return reconciling;
  }
  return {
    reconcile,
    workflowIds() {
      return deps.db
        .select({ call: calls })
        .from(calls)
        .innerJoin(
          controlPlaneJobBindings,
          eq(controlPlaneJobBindings.objectId, calls.workflowRunId),
        )
        .where(
          and(
            eq(controlPlaneJobBindings.kind, "workflow-run"),
            inArray(calls.state, ["pending", "running"]),
          ),
        )
        .limit(256)
        .all()
        .flatMap(({ call }) => {
          try {
            requireControlPlaneInvocation(deps.db, call);
            return [call.workflowRunId];
          } catch {
            return [];
          }
        });
    },
    resolve(parent: Parent, versionId: string) {
      const context = resolve(parent, versionId);
      const definition = context.profileVersion.definition;
      return {
        profileVersionId: context.profileVersion.id,
        providerId: definition.providerId,
        model: definition.model,
        reasoningLevel: definition.reasoningLevel,
        permissionMode: definition.permissionMode,
      };
    },
    registerStop(handler: (id: string) => Promise<boolean>) {
      stopWorkflow = handler;
      return () => {
        if (stopWorkflow === handler) stopWorkflow = null;
      };
    },
    async invoke(
      parent: Parent,
      input: Input,
      signal: AbortSignal,
    ): Promise<JsonValue> {
      assertExecutionAdmission(deps.db);
      if (closed) throw new Error("Agent invocation service is closed");
      const parsedParent = parentSchema.parse(parent);
      const parsed = inputSchema.parse(input);
      resolve(parsedParent, parsed.versionId);
      const key = JSON.stringify([
        parsedParent,
        parsed.key,
        parsed.versionId,
        parsed.input,
      ]);
      const previous = active.get(key);
      if (previous) return previous;
      const controller = new AbortController();
      controllers.add(controller);
      const task = execute(
        parsedParent,
        parsed,
        AbortSignal.any([signal, controller.signal]),
      );
      active.set(key, task);
      try {
        return await task;
      } finally {
        active.delete(key);
        controllers.delete(controller);
      }
    },
    async close() {
      closed = true;
      clearInterval(timer);
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(active.values());
      await reconciling;
      threads.close();
    },
  };
}
