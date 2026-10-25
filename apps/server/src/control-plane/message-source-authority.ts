import {
  ControlPlaneThreadError,
  getStoredTurnRequestEventByRequestId,
  requireControlPlaneThreadDispatch,
  type DbQueryConnection,
} from "@bb/db";
import { ApiError } from "../errors.js";
import { parseStoredTurnRequestEvent } from "../services/threads/thread-events.js";

export function assertControlPlaneMessageSources(
  db: DbQueryConnection,
  threadId: string,
  sources: {
    senderThreadId?: string | null;
    requestedByThreadId?: string | null;
    retryOfRequestId?: string | null;
  },
): void {
  const target = requireControlPlaneThreadDispatch(db, threadId);
  if (!target) return;
  const sourceIds = new Set([
    sources.senderThreadId,
    sources.requestedByThreadId,
  ]);
  const visited = new Set<string>();
  let requestId = sources.retryOfRequestId;
  try {
    while (requestId) {
      if (visited.size >= 32 || visited.has(requestId))
        throw new ControlPlaneThreadError();
      visited.add(requestId);
      const row = getStoredTurnRequestEventByRequestId(db, threadId, requestId);
      if (!row) throw new ControlPlaneThreadError();
      const request = parseStoredTurnRequestEvent(row);
      sourceIds.add(request.senderThreadId);
      requestId = request.retryOfRequestId;
    }
    for (const sourceId of sourceIds) {
      if (!sourceId || sourceId === threadId) continue;
      const source = requireControlPlaneThreadDispatch(db, sourceId);
      if (!source || source.user.id !== target.user.id)
        throw new ControlPlaneThreadError();
    }
  } catch (error) {
    if (
      !(error instanceof ControlPlaneThreadError) &&
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
