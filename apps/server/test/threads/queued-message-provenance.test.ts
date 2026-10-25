import { expect, it } from "vitest";
import { createQueuedThreadMessage, listEvents } from "@bb/db";
import { turnRequestEventDataSchema } from "@bb/domain";
import { createClientTurnRequestId } from "../../src/services/threads/thread-events.js";
import { appendAndQueueSendThreadMessageInTransaction } from "../../src/services/threads/thread-send.js";
import { sendQueuedMessageNow } from "../../src/services/threads/queued-messages.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";

it.each(["requester", "retry"] as const)(
  "preserves durable %s provenance through idle provider queue dispatch",
  async (kind) => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queue-provenance",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: `provider-${kind}`,
      });
      const sender = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const originalId = createClientTurnRequestId();
      const execution = {
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        source: "client/turn/requested",
      } as const;
      appendAndQueueSendThreadMessageInTransaction({
        db: harness.db,
        thread,
        environmentId: environment.id,
        execution,
        input: textInput("Original agent request"),
        initiator: "agent",
        senderThreadId: sender.id,
        requestId: originalId,
        target: { kind: "new-turn" },
        queueInTransaction: () => ({ activeThread: null }),
      });
      const row = createQueuedThreadMessage(harness.db, harness.hub, {
        threadId: thread.id,
        content: textInput("Queued continuation"),
        ...execution,
        waitingOn: { kind: "time" },
        sendAt: Date.now() + 60000,
        systemNotice: null,
        ...(kind === "requester"
          ? { requestedBy: { initiator: "agent", senderThreadId: sender.id } }
          : {}),
        payload:
          kind === "retry"
            ? {
                kind: "retry",
                retryOfTurnRequestId: originalId,
                attempt: 2,
                reason: "transient failure",
              }
            : { kind: "inline" },
      });
      await sendQueuedMessageNow(harness.deps, {
        threadId: thread.id,
        queuedMessageId: row.id,
        mode: "auto",
      });
      const request = turnRequestEventDataSchema.parse(
        JSON.parse(
          listEvents(harness.db, { threadId: thread.id })
            .filter((event) => event.type === "client/turn/requested")
            .at(-1)!.data,
        ),
      );
      expect(request).toMatchObject(
        kind === "retry"
          ? {
              initiator: "system",
              senderThreadId: null,
              retryOfRequestId: originalId,
              retryAttempt: 2,
            }
          : { initiator: "agent", senderThreadId: sender.id },
      );
      const command = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      await reportQueuedCommandSuccess(harness, command, {
        trace: { spans: [] },
      });
    });
  },
);
