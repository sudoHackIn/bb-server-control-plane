import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  controlPlaneThreads,
  controlPlaneTurnSources,
  createConnection,
  createThread,
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
    mode: z.enum(["inherited", "legacy"]).default("inherited"),
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
} finally {
  db.$client.close();
}
