import { expect, it, vi } from "vitest";
import {
  events,
  controlPlaneProfileAccess,
  queuedThreadMessages,
  requireControlPlaneThreadDispatch,
  setControlPlaneProfileAccess,
} from "@bb/db";
import { eq, and } from "drizzle-orm";
import { withTestHarness } from "../helpers/test-app.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { appendAndQueueSendThreadMessageInTransaction } from "../../src/services/threads/thread-send.js";
import { createClientTurnRequestId } from "../../src/services/threads/thread-events.js";
import { createQueuedMessageForThread } from "../../src/services/threads/queued-messages.js";
import { recordQueuedMessageWait } from "../../src/services/threads/queue-waits.js";
import type { ResolvedThreadExecutionOptions } from "@bb/domain";

const execution: ResolvedThreadExecutionOptions = {
  model: "qwen-test",
  reasoningLevel: "none",
  permissionMode: "full",
  serviceTier: "default",
  source: "client/turn/requested",
};

it("rechecks authority in the request transaction before events and outbound queue effects", async () => {
  await withTestHarness(async (harness) => {
    const { alice } = seedControlPlaneJobSubjects(harness.db);
    requireControlPlaneThreadDispatch(harness.db, alice.thread.id);
    const before = harness.db
      .select()
      .from(events)
      .where(eq(events.threadId, alice.thread.id))
      .all().length;
    const enqueue = vi.fn(() => {
      throw new Error("Must not queue an unauthorized command");
    });
    expect(() =>
      appendAndQueueSendThreadMessageInTransaction({
        db: harness.db,
        thread: alice.thread,
        environmentId: alice.environment.id,
        execution,
        initiator: "user",
        input: [
          {
            type: "text",
            text: "Correction after revoked grant",
            mentions: [],
          },
        ],
        queueInTransaction: enqueue,
        requestId: createClientTurnRequestId(),
        senderThreadId: null,
        target: { kind: "thread-start" },
        beforeAppendInTransaction: ({ tx }) => {
          tx.delete(controlPlaneProfileAccess)
            .where(
              and(
                eq(
                  controlPlaneProfileAccess.profileId,
                  alice.profile.profileId,
                ),
                eq(controlPlaneProfileAccess.userId, alice.user.id),
              ),
            )
            .run();
        },
      }),
    ).toThrow("not authorized");
    expect(enqueue).not.toHaveBeenCalled();
    expect(
      harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, alice.thread.id))
        .all(),
    ).toHaveLength(before);
    expect(() =>
      requireControlPlaneThreadDispatch(harness.db, alice.thread.id),
    ).not.toThrow();
  });
});

it.each(["wait", "explicit"] as const)(
  "does not create a %s message when a grant changes after initial admission",
  async (kind) => {
    await withTestHarness(async (harness) => {
      const { alice } = seedControlPlaneJobSubjects(harness.db);
      requireControlPlaneThreadDispatch(harness.db, alice.thread.id);
      setControlPlaneProfileAccess(
        harness.db,
        alice.profile.profileId,
        alice.user.id,
        false,
      );
      if (kind === "explicit") {
        await expect(
          createQueuedMessageForThread(harness.deps, {
            thread: alice.thread,
            payload: {
              input: [{ type: "text", text: "Must not queue", mentions: [] }],
              model: "qwen-test",
              reasoningLevel: "none",
              permissionMode: "full",
            },
          }),
        ).rejects.toThrow("not authorized");
      } else {
        expect(() =>
          recordQueuedMessageWait(harness.deps, {
            thread: alice.thread,
            message: {
              input: [{ type: "text", text: "Must not wait", mentions: [] }],
              execution,
              senderThreadId: null,
              origin: "plugin",
              originPluginId: "workflows",
              requestedBy: null,
              payload: { kind: "inline" },
              systemNotice: null,
            },
            waitingOn: { kind: "time" },
            sendAt: Date.now() + 10000,
            claimed: null,
          }),
        ).toThrow("not authorized");
      }
      expect(
        harness.db
          .select()
          .from(queuedThreadMessages)
          .where(eq(queuedThreadMessages.threadId, alice.thread.id))
          .all(),
      ).toEqual([]);
    });
  },
);
