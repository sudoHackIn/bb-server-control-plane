import type { StoredTurnRequestEventRow } from "@bb/db";
import {
  parseStoredThreadEvent,
  threadScope,
  turnRequestEventDataSchema,
  type TurnRequestEventData,
  type TurnRequestTarget,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import { parseStoredEventPayload } from "./thread-data.js";
const LEGACY_THREAD_START_TARGET = {
  kind: "thread-start",
} satisfies TurnRequestTarget;
const LEGACY_NEW_TURN_TARGET = { kind: "new-turn" } satisfies TurnRequestTarget;
type LegacyTurnRequestEventType = "client/thread/start" | "client/turn/start";
const LEGACY_TURN_REQUEST_TARGET_BY_TYPE = {
  "client/thread/start": LEGACY_THREAD_START_TARGET,
  "client/turn/start": LEGACY_NEW_TURN_TARGET,
} satisfies Record<LegacyTurnRequestEventType, TurnRequestTarget>;

function legacyTurnRequestTargetForType(
  type: LegacyTurnRequestEventType,
): TurnRequestTarget {
  return LEGACY_TURN_REQUEST_TARGET_BY_TYPE[type];
}

export function parseStoredTurnRequestEvent(
  row: StoredTurnRequestEventRow,
): TurnRequestEventData {
  const payload = parseStoredEventPayload(row);

  let event;
  try {
    event = parseStoredThreadEvent({
      data: payload,
      threadId: row.threadId,
      type: row.type,
      scope: threadScope(),
    });
  } catch {
    throw new ApiError(
      500,
      "internal_error",
      `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is malformed`,
    );
  }

  if (event.type === "client/turn/requested") {
    const { type: _type, threadId: _threadId, scope: _scope, ...data } = event;
    return data;
  }

  if (row.type === "client/thread/start" || row.type === "client/turn/start") {
    const legacyTurnRequest = turnRequestEventDataSchema.safeParse({
      ...payload,
      target: legacyTurnRequestTargetForType(row.type),
    });
    if (legacyTurnRequest.success) {
      return legacyTurnRequest.data;
    }
  }

  throw new ApiError(
    500,
    "internal_error",
    `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is malformed`,
  );
}
