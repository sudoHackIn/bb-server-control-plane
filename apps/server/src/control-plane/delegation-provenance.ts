import { eq } from "drizzle-orm";
import {
  controlPlaneAgentInvocations,
  controlPlaneThreads,
  controlPlaneJobBindings,
  CONTROL_PLANE_AGENT_INVOCATION_LIMITS,
  type DbConnection,
} from "@bb/db";
import { controlPlaneDelegationSchema } from "@bb/domain";
import { createInspectionPolicy } from "./inspection-policy.js";
export function readControlPlaneDelegation(
  db: DbConnection,
  policy: ReturnType<typeof createInspectionPolicy>,
  key: string,
  kind: "thread" | "workflow",
  id: string,
  ownerUserId: string,
  projectId: string,
) {
  const thread =
    kind === "thread"
      ? db
          .select()
          .from(controlPlaneThreads)
          .where(eq(controlPlaneThreads.threadId, id))
          .get()
      : null;
  const call =
    kind === "workflow"
      ? db
          .select()
          .from(controlPlaneAgentInvocations)
          .where(eq(controlPlaneAgentInvocations.workflowRunId, id))
          .get()
      : thread?.runIdempotencyKey
        ? db
            .select()
            .from(controlPlaneAgentInvocations)
            .where(
              eq(
                controlPlaneAgentInvocations.childKey,
                thread.runIdempotencyKey,
              ),
            )
            .get()
        : null;
  if (!call || call.ownerUserId !== ownerUserId || call.projectId !== projectId)
    return undefined;
  let parent: { kind: "thread" | "workflow"; id: string } | null = null;
  try {
    if (call.parentKind === "thread") {
      const value = policy.thread(call.parentId, null);
      if (
        value.ownerUserId === ownerUserId &&
        value.row.projectId === projectId
      )
        parent = { kind: "thread", id: call.parentId };
    } else {
      const stored = db
        .select()
        .from(controlPlaneJobBindings)
        .where(eq(controlPlaneJobBindings.id, call.parentId))
        .get();
      if (stored?.kind === "workflow-run") {
        const value = policy.workflow(key, stored.objectId);
        if (value.ownerUserId === ownerUserId && value.projectId === projectId)
          parent = { kind: "workflow", id: stored.objectId };
      }
    }
  } catch {}
  return controlPlaneDelegationSchema.parse({
    invocationId: call.id,
    state: call.state,
    cleanupPending: call.cleanupPending,
    depth: call.depth,
    deadlineAt:
      call.createdAt + CONTROL_PLANE_AGENT_INVOCATION_LIMITS.timeoutMs,
    parent,
  });
}
