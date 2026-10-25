import { sql } from "drizzle-orm";
import { z } from "zod";
import { getThread, isControlPlaneThreadManaged } from "@bb/db";
import {
  promptInputSchema,
  systemMessageKindSchema,
  systemMessageSubjectSchema,
} from "@bb/domain";
import { sendMessageRequestSchema } from "@bb/server-contract";
import type { SendMessageRequest } from "@bb/server-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import { queueParentSystemMessage } from "./parent-system-messages.js";
import { appendSystemErrorEvent } from "./thread-events.js";
import { acceptThreadSendRequest } from "./thread-send-request.js";

const LEGACY_DEFERRED_TABLE = "deferred_thread_messages_legacy";

const legacyDeferredPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("send"),
    request: z
      .object({ input: z.array(promptInputSchema).min(1) })
      .passthrough(),
  }),
  z.object({
    kind: z.literal("parent-system"),
    input: z.array(promptInputSchema),
    systemMessageKind: systemMessageKindSchema,
    systemMessageSubject: systemMessageSubjectSchema.nullable(),
  }),
]);

interface LegacyDeferredRow {
  id: string;
  threadId: string;
  payload: string;
}

function legacyDeferredTableExists(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
): boolean {
  return (
    deps.db.get<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${LEGACY_DEFERRED_TABLE}`,
    ) !== undefined
  );
}

function toSendPayload(
  request: z.infer<(typeof legacyDeferredPayloadSchema.options)[0]>["request"],
): SendMessageRequest {
  const revalidated = sendMessageRequestSchema.safeParse({
    ...request,
    mode: "auto",
  });
  return revalidated.success
    ? revalidated.data
    : { input: request.input, mode: "auto" };
}

export async function deliverLegacyDeferredThreadMessages(
  deps: LoggedPendingInteractionWorkSessionDeps,
  options: { allowUnownedLegacyReplay: boolean },
): Promise<void> {
  if (!legacyDeferredTableExists(deps)) {
    return;
  }
  const rows = deps.db.all<LegacyDeferredRow>(
    sql`SELECT id, thread_id AS threadId, payload FROM deferred_thread_messages_legacy ORDER BY thread_id, created_at, id`,
  );
  let kept = 0;
  for (const row of rows) {
    try {
      const delivered = await deliverLegacyDeferredRow(
        deps,
        row,
        options.allowUnownedLegacyReplay,
      );
      if (delivered === "kept") {
        kept += 1;
        continue;
      }
      deps.db.run(
        sql`DELETE FROM deferred_thread_messages_legacy WHERE id = ${row.id}`,
      );
    } catch (error) {
      kept += 1;
      deps.logger.warn(
        {
          deferredMessageId: row.id,
          threadId: row.threadId,
          ...runtimeErrorLogFields(deps.config, error),
        },
        "Could not deliver a legacy deferred message; keeping it for the next startup",
      );
    }
  }
  if (kept === 0) {
    deps.db.run(sql`DROP TABLE deferred_thread_messages_legacy`);
    if (rows.length > 0) {
      deps.logger.info(
        { migrated: rows.length },
        "Delivered the legacy deferred messages into the queue",
      );
    }
  }
}

async function deliverLegacyDeferredRow(
  deps: LoggedPendingInteractionWorkSessionDeps,
  row: LegacyDeferredRow,
  allowUnownedLegacyReplay: boolean,
): Promise<"delivered" | "kept"> {
  const thread = getThread(deps.db, row.threadId);
  if (
    thread &&
    (!allowUnownedLegacyReplay ||
      isControlPlaneThreadManaged(deps.db, thread.id))
  ) {
    if (thread.deletedAt === null) {
      const code = "legacy_deferred_not_authorized";
      const reported = deps.db.get<{ id: string }>(
        sql`SELECT id FROM events WHERE thread_id = ${thread.id} AND type = 'system/error' AND json_extract(data, '$.code') = ${code} AND json_extract(data, '$.detail') = ${row.id} LIMIT 1`,
      );
      if (!reported)
        appendSystemErrorEvent(deps, {
          threadId: thread.id,
          environmentId: thread.environmentId,
          code,
          detail: row.id,
          message:
            "A legacy deferred message has no verified authorization and was retained without execution. Submit a new authorized message to continue.",
          scope: { kind: "thread" },
        });
    }
    return "kept";
  }
  if (!thread || thread.deletedAt !== null || thread.archivedAt !== null) {
    return "delivered";
  }
  const parsed = legacyDeferredPayloadSchema.safeParse(JSON.parse(row.payload));
  if (!parsed.success) {
    deps.logger.warn(
      { deferredMessageId: row.id, threadId: row.threadId },
      "Keeping an unrecognized legacy deferred payload",
    );
    return "kept";
  }
  if (parsed.data.kind === "send") {
    await acceptThreadSendRequest(deps, {
      payload: toSendPayload(parsed.data.request),
      thread,
    });
    return "delivered";
  }
  await queueParentSystemMessage(deps, {
    parentThreadId: row.threadId,
    input: parsed.data.input,
    systemMessageKind: parsed.data.systemMessageKind,
    systemMessageSubject: parsed.data.systemMessageSubject,
  });
  return "delivered";
}
