import { and, eq } from "drizzle-orm";
import {
  ControlPlaneThreadError,
  ControlPlaneJobError,
  controlPlaneTurnSources,
  controlPlaneJobNotifications,
  requireControlPlaneJobDispatch,
  getStoredTurnRequestEventByRequestId,
  requireControlPlaneThreadDispatch,
  type DbQueryConnection,
} from "@bb/db";
import { ApiError } from "../errors.js";
import { parseStoredTurnRequestEvent } from "../services/threads/stored-turn-request.js";

export function assertControlPlaneMessageSources(
  db: DbQueryConnection,
  threadId: string,
  sources: {
    senderThreadId?: string | null;
    requestedByThreadId?: string | null;
    retryOfRequestId?: string | null;
    sourceRequestId?: string | null;
  },
): void {
  const target = requireControlPlaneThreadDispatch(db, threadId);
  if (!target) return;
  const ownerUserId = target.user.id;
  const projectId = target.project.projectId;
  const sourceIds = new Set([
    sources.senderThreadId,
    sources.requestedByThreadId,
  ]);
  const visited = new Set<string>();
  const active = new Set<string>();
  function visit(requestId: string | null | undefined): void {
    if (!requestId) return;
    if (active.has(requestId)) throw new ControlPlaneThreadError();
    if (visited.has(requestId)) return;
    if (visited.size + active.size >= 32) throw new ControlPlaneThreadError();
    active.add(requestId);
    const row = getStoredTurnRequestEventByRequestId(db, threadId, requestId);
    if (!row) throw new ControlPlaneThreadError();
    const saved = db
      .select()
      .from(controlPlaneTurnSources)
      .where(
        and(
          eq(controlPlaneTurnSources.threadId, threadId),
          eq(controlPlaneTurnSources.requestId, requestId),
        ),
      )
      .get();
    if (!saved) throw new ControlPlaneThreadError();
    const receipt = db
      .select()
      .from(controlPlaneJobNotifications)
      .where(
        and(
          eq(controlPlaneJobNotifications.threadId, threadId),
          eq(controlPlaneJobNotifications.requestId, requestId),
        ),
      )
      .get();
    if (receipt) {
      const job = requireControlPlaneJobDispatch(db, receipt.bindingId);
      if (
        job.binding.kind !== "workflow-run" ||
        job.binding.originThreadId !== threadId ||
        job.user.id !== ownerUserId ||
        job.project.projectId !== projectId
      )
        throw new ControlPlaneThreadError();
    }
    const request = parseStoredTurnRequestEvent(row);
    sourceIds.add(request.senderThreadId);
    visit(request.retryOfRequestId);
    visit(saved?.sourceRequestId);
    active.delete(requestId);
    visited.add(requestId);
  }
  try {
    visit(sources.retryOfRequestId);
    visit(sources.sourceRequestId);
    for (const sourceId of sourceIds) {
      if (!sourceId || sourceId === threadId) continue;
      const source = requireControlPlaneThreadDispatch(db, sourceId);
      if (!source || source.user.id !== target.user.id)
        throw new ControlPlaneThreadError();
    }
  } catch (error) {
    if (
      !(error instanceof ControlPlaneThreadError) &&
      !(error instanceof ControlPlaneJobError) &&
      !(error instanceof ApiError)
    )
      throw error;
    throw new ApiError(
      403,
      "message_source_not_authorized",
      "Message source is not authorized",
    );
  }
}

export function assertControlPlaneTurnRequestSources(
  db: DbQueryConnection,
  threadId: string,
  requestId: string,
): void {
  if (!requireControlPlaneThreadDispatch(db, threadId)) return;
  assertControlPlaneMessageSources(db, threadId, {
    retryOfRequestId: requestId,
  });
}
