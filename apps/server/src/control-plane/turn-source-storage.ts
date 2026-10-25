import {
  controlPlaneTurnSources,
  requireControlPlaneThreadDispatch,
  type DbQueryConnection,
} from "@bb/db";
import { ApiError } from "../errors.js";
import {
  assertControlPlaneMessageSources,
  assertControlPlaneTurnRequestSources,
} from "./message-source-authority.js";

export function recordControlPlaneTurnSource(
  db: DbQueryConnection,
  threadId: string,
  requestId: string,
  sourceRequestId: string | null,
): void {
  if (!requireControlPlaneThreadDispatch(db, threadId)) return;
  if (sourceRequestId === requestId)
    throw new ApiError(
      403,
      "message_source_not_authorized",
      "Message source is not authorized",
    );
  assertControlPlaneMessageSources(db, threadId, { sourceRequestId });
  db.insert(controlPlaneTurnSources)
    .values({ threadId, requestId, sourceRequestId })
    .run();
  assertControlPlaneTurnRequestSources(db, threadId, requestId);
}
