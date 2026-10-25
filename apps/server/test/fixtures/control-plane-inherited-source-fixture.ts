import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import {
  controlPlaneThreads,
  environments,
  controlPlaneTurnSources,
  createConnection,
  createThread,
  createQueuedThreadMessage,
  getThread,
  noopNotifier,
} from "@bb/db";
import { withControlPlaneUser } from "../../src/control-plane/access.js";
import { appendAndQueueSendThreadMessageInTransaction } from "../../src/services/threads/thread-send.js";
import { createClientTurnRequestId } from "../../src/services/threads/thread-events.js";

const input = z
  .object({
    sourceThreadId: z.string().min(1),
    profileVersionId: z.string().uuid(),
    relatedThreadId: z.string().optional(),
    mode: z
      .enum([
        "inherited",
        "legacy",
        "legacy-backfill",
        "foreign-notice",
        "unsafe-environment",
        "restore-environment",
      ])
      .default("inherited"),
  })
  .strict()
  .parse(JSON.parse(process.argv[2] ?? "null"));
const db = createConnection("/srv/bb/bb.db");
try {
  const source = getThread(db, input.sourceThreadId);
  const owner = db
    .select()
    .from(controlPlaneThreads)
    .where(eq(controlPlaneThreads.threadId, input.sourceThreadId))
    .get();
  if (!source || !owner || !source.environmentId)
    throw new Error("Owned source environment required");
  if (
    input.mode === "unsafe-environment" ||
    input.mode === "restore-environment"
  ) {
    db.update(environments)
      .set({ providerOwnsPath: input.mode === "unsafe-environment" })
      .where(eq(environments.id, source.environmentId))
      .run();
    process.stdout.write(JSON.stringify({ threadId: source.id }));
  } else {
    const threadId = withControlPlaneUser(owner.ownerUserId, () =>
      db.transaction(() => {
        const thread = createThread(db, noopNotifier, {
          projectId: source.projectId,
          environmentId: source.environmentId,
          providerId: "qwen-server",
          status: "error",
          controlPlaneOwnerUserId: owner.ownerUserId,
          controlPlaneProfileVersionId: input.profileVersionId,
        });
        if (input.mode === "legacy-backfill") {
          db.run(
            sql`CREATE TABLE IF NOT EXISTS deferred_thread_messages_legacy (id text PRIMARY KEY, thread_id text NOT NULL, kind text NOT NULL, payload text NOT NULL, created_at integer NOT NULL)`,
          );
          for (const kind of ["send", "parent-system"]) {
            const content = [
              {
                type: "text",
                text: "BB_MESSAGE_SOURCE_BACKFILL_UNKNOWN",
                mentions: [],
              },
            ];
            const payload = JSON.stringify(
              kind === "send"
                ? { kind, request: { input: content } }
                : {
                    kind,
                    input: content,
                    systemMessageKind: "child-completed",
                    systemMessageSubject: {
                      kind: "thread",
                      threadId: source.id,
                      threadName: "Unknown provenance",
                    },
                  },
            );
            db.run(
              sql`INSERT INTO deferred_thread_messages_legacy (id, thread_id, kind, payload, created_at) VALUES (${`${thread.id}-${kind}`}, ${thread.id}, ${kind}, ${payload}, 1)`,
            );
          }
          return thread.id;
        }
        if (input.mode === "foreign-notice") {
          if (!input.relatedThreadId)
            throw new Error("Related thread required");
          createQueuedThreadMessage(db, noopNotifier, {
            threadId: thread.id,
            content: [
              {
                type: "text",
                text: "BB_MESSAGE_SOURCE_FOREIGN_NOTICE",
                mentions: [],
              },
            ],
            senderThreadId: null,
            origin: null,
            originPluginId: null,
            model: "qwen-job-test",
            reasoningLevel: "none",
            permissionMode: "full",
            serviceTier: "default",
            waitingOn: { kind: "thread-busy" },
            sendAt: Date.now() + 3600000,
            payload: { kind: "inline" },
            systemNotice: {
              kind: "child-completed",
              subject: {
                kind: "thread",
                threadId: input.relatedThreadId,
                threadName: "Foreign result",
              },
            },
          });
          return thread.id;
        }
        appendAndQueueSendThreadMessageInTransaction({
          db,
          thread,
          environmentId: source.environmentId,
          execution: {
            model: "qwen-job-test",
            reasoningLevel: "none",
            permissionMode: "full",
            serviceTier: "default",
            source: "client/turn/requested",
          },
          initiator: input.mode === "legacy" ? "user" : "agent",
          senderThreadId: input.mode === "legacy" ? null : source.id,
          requestId: createClientTurnRequestId(),
          target: { kind: "new-turn" },
          input: [
            {
              type: "text",
              text:
                input.mode === "legacy"
                  ? "BB_MESSAGE_SOURCE_LEGACY_UNKNOWN"
                  : "BB_MESSAGE_SOURCE_DEFERRED_SEED",
              mentions: [],
              ...(input.mode === "legacy"
                ? {}
                : { visibility: "agent-only" as const }),
            },
          ],
          queueInTransaction: () => ({ activeThread: null }),
        });
        if (input.mode === "legacy")
          db.delete(controlPlaneTurnSources)
            .where(eq(controlPlaneTurnSources.threadId, thread.id))
            .run();
        return thread.id;
      }),
    );
    process.stdout.write(JSON.stringify({ threadId }));
  }
} finally {
  db.$client.close();
}
