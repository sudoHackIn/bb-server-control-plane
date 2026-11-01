import { createHash, randomUUID } from "node:crypto";
import { and, count, eq, inArray } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import {
  controlPlaneAgentInvocations as calls,
  controlPlaneThreads,
  controlPlaneJobBindings,
} from "../schema.js";
import {
  requireControlPlaneThreadDispatch,
  requireControlPlaneThreadOwner,
  ControlPlaneThreadError,
} from "./control-plane-threads.js";
import {
  requireControlPlaneJobDispatch,
  ControlPlaneJobError,
} from "./control-plane-jobs.js";

type Parent = { kind: "thread" | "workflow"; id: string };
type Invocation = typeof calls.$inferSelect;

export const CONTROL_PLANE_AGENT_INVOCATION_LIMITS = Object.freeze({
  maxDepth: 4,
  maxCalls: 64,
  maxActive: 8,
  timeoutMs: 600000,
});

export function requireControlPlaneInvocationTarget(
  db: DbQueryConnection,
  parent: Parent,
  versionId: string,
) {
  const context =
    parent.kind === "thread"
      ? requireControlPlaneThreadDispatch(db, parent.id)
      : requireControlPlaneJobDispatch(db, parent.id);
  if (
    !context ||
    !context.profileVersion.definition.delegation?.allowedVersionIds.includes(
      versionId,
    )
  )
    throw new ControlPlaneJobError();
  if (
    parent.kind === "thread" &&
    !(
      "thread" in context &&
      ["starting", "active"].includes(context.thread.status)
    )
  )
    throw new ControlPlaneJobError();
  if (parent.kind === "workflow") {
    const binding = db
      .select()
      .from(controlPlaneJobBindings)
      .where(eq(controlPlaneJobBindings.id, parent.id))
      .get();
    if (binding?.kind !== "workflow-run") throw new ControlPlaneJobError();
  }
  const selected = requireControlPlaneThreadOwner(db, {
    projectId: context.project.projectId,
    ownerUserId: context.user.id,
    profileVersionId: versionId,
    providerId: "qwen-server",
    relatedThreadIds: [],
  });
  if (!selected) throw new ControlPlaneJobError();
  return selected;
}

export function requireControlPlaneInvocation(
  db: DbQueryConnection,
  call: Invocation,
) {
  if (
    !["pending", "running"].includes(call.state) ||
    Date.now() >
      call.createdAt + CONTROL_PLANE_AGENT_INVOCATION_LIMITS.timeoutMs
  )
    throw new ControlPlaneJobError();
  const context = requireControlPlaneInvocationTarget(
    db,
    { kind: call.parentKind, id: call.parentId },
    call.profileVersionId,
  );
  if (
    context.user.id !== call.ownerUserId ||
    context.project.projectId !== call.projectId
  )
    throw new ControlPlaneJobError();
  return context;
}

export function checkControlPlaneInvocationWorkflow(
  db: DbQueryConnection,
  runId: string,
  ownerUserId: string,
  projectId: string,
  profileVersionId: string,
) {
  const call = db
    .select()
    .from(calls)
    .where(eq(calls.workflowRunId, runId))
    .get();
  if (call) {
    if (
      call.ownerUserId !== ownerUserId ||
      call.projectId !== projectId ||
      call.profileVersionId !== profileVersionId
    )
      throw new ControlPlaneJobError();
    requireControlPlaneInvocation(db, call);
  }
}

export function checkControlPlaneInvocationThread(
  db: DbQueryConnection,
  ownerUserId: string,
  projectId: string,
  profileVersionId: string,
  childKey: string | null,
) {
  if (!childKey) return;
  const call = db
    .select()
    .from(calls)
    .where(eq(calls.childKey, childKey))
    .get();
  if (!call) return;
  if (
    call.ownerUserId !== ownerUserId ||
    call.projectId !== projectId ||
    call.profileVersionId !== profileVersionId
  )
    throw new ControlPlaneThreadError();
  try {
    requireControlPlaneInvocation(db, call);
  } catch (error) {
    if (error instanceof ControlPlaneJobError)
      throw new ControlPlaneThreadError(error.reason);
    throw error;
  }
}

function ancestor(
  db: DbQueryConnection,
  parent: Parent,
  seen = new Set<string>(),
): { rootId: string; depth: number } {
  const marker = `${parent.kind}:${parent.id}`;
  if (seen.has(marker) || seen.size >= 32) throw new ControlPlaneJobError();
  seen.add(marker);
  let bindingId = parent.kind === "workflow" ? parent.id : null;
  if (parent.kind === "thread") {
    const thread = db
      .select()
      .from(controlPlaneThreads)
      .where(eq(controlPlaneThreads.threadId, parent.id))
      .get();
    if (!thread) throw new ControlPlaneJobError();
    const call = thread.runIdempotencyKey
      ? db
          .select()
          .from(calls)
          .where(eq(calls.childKey, thread.runIdempotencyKey))
          .get()
      : null;
    if (call) return call;
    bindingId = thread.jobBindingId;
  }
  while (bindingId) {
    if (seen.has(bindingId) || seen.size >= 32)
      throw new ControlPlaneJobError();
    seen.add(bindingId);
    const binding = db
      .select()
      .from(controlPlaneJobBindings)
      .where(eq(controlPlaneJobBindings.id, bindingId))
      .get();
    if (!binding) throw new ControlPlaneJobError();
    if (binding.kind === "workflow-run") {
      const call = db
        .select()
        .from(calls)
        .where(eq(calls.workflowRunId, binding.objectId))
        .get();
      if (call) return call;
    }
    if (binding.sourceBindingId) bindingId = binding.sourceBindingId;
    else if (binding.originThreadId)
      return ancestor(db, { kind: "thread", id: binding.originThreadId }, seen);
    else return { rootId: `workflow:${binding.id}`, depth: 0 };
  }
  return { rootId: `thread:${parent.id}`, depth: 0 };
}

export function reserveControlPlaneAgentInvocation(
  db: DbConnection,
  parent: Parent,
  input: { versionId: string; input: string; key: string },
) {
  return db.transaction(
    (tx) => {
      const context = requireControlPlaneInvocationTarget(
        tx,
        parent,
        input.versionId,
      );
      const existing = tx
        .select()
        .from(calls)
        .where(
          and(
            eq(calls.parentKind, parent.kind),
            eq(calls.parentId, parent.id),
            eq(calls.idempotencyKey, input.key),
          ),
        )
        .get();
      if (existing) {
        if (
          existing.input !== input.input ||
          existing.profileVersionId !== input.versionId
        )
          throw new Error("Agent invocation idempotency conflict");
        return existing;
      }
      const previous = ancestor(tx, parent);
      const id = randomUUID();
      const rootId = previous.rootId;
      const depth = previous.depth + 1;
      const total =
        tx
          .select({ value: count() })
          .from(calls)
          .where(eq(calls.rootId, rootId))
          .get()?.value ?? 0;
      const active =
        tx
          .select({ value: count() })
          .from(calls)
          .where(
            and(
              eq(calls.rootId, rootId),
              inArray(calls.state, ["pending", "running"]),
            ),
          )
          .get()?.value ?? 0;
      if (
        depth > CONTROL_PLANE_AGENT_INVOCATION_LIMITS.maxDepth ||
        total >= CONTROL_PLANE_AGENT_INVOCATION_LIMITS.maxCalls ||
        active >= CONTROL_PLANE_AGENT_INVOCATION_LIMITS.maxActive
      )
        throw new ControlPlaneJobError();
      const childKey = `invocation:${id}`;
      const workflowRunId = `wfa_${createHash("sha256")
        .update(JSON.stringify([context.user.id, childKey]))
        .digest("hex")}`;
      return tx
        .insert(calls)
        .values({
          id,
          parentKind: parent.kind,
          parentId: parent.id,
          ownerUserId: context.user.id,
          projectId: context.project.projectId,
          profileVersionId: input.versionId,
          rootId,
          depth,
          idempotencyKey: input.key,
          input: input.input,
          childKey,
          workflowRunId,
          runId: null,
          state: "pending",
          createdAt: Date.now(),
        })
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );
}
