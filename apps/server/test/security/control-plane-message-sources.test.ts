import {
  clientTurnRequestIdSchema,
  turnRequestEventDataSchema,
} from "@bb/domain";
import { TRANSPORT_TEST_BRIDGE_LAUNCH } from "../helpers/provider-registry.js";
import { expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  createThread,
  noopNotifier,
  createControlPlaneProfile,
  setControlPlaneProfileAccess,
  requireControlPlaneThreadDispatch,
  getQueuedThreadMessage,
  controlPlaneJobBindings,
  createControlPlaneJobBinding,
  threads,
  listEvents,
  events,
  getStoredTurnRequestEventByRequestId,
  createQueuedThreadMessage,
  queuedThreadMessages,
  claimQueuedThreadMessageGroup,
  setQueuedThreadMessageGroupBoundary,
  listQueuedThreadMessages,
} from "@bb/db";
import {
  assertControlPlaneMessageSources,
  assertControlPlaneTurnRequestSources,
} from "../../src/control-plane/message-source-authority.js";
import {
  appendAndQueueSendThreadMessageInTransaction,
  resolveMessageSenderThreadId,
} from "../../src/services/threads/thread-send.js";
import { createClientTurnRequestId } from "../../src/services/threads/thread-events.js";
import { recordQueuedMessageWait } from "../../src/services/threads/queue-waits.js";
import { sendQueuedMessageNow } from "../../src/services/threads/queued-messages.js";
import { callHostOnlineRpc } from "../../src/services/hosts/online-rpc.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { seedHostSession, seedQueuedMessage } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import { textInput } from "../helpers/prompt-input.js";

const execution = {
  model: "qwen-test",
  reasoningLevel: "none",
  permissionMode: "full",
  serviceTier: "default",
  source: "client/turn/requested",
} as const;

it("does not group managed queued messages whose requester authority would be lost", async () => {
  await withTestHarness(async (harness) => {
    const { alice, source } = fixture(harness);
    const rows = [alice.thread.id, source.id].map((senderThreadId) =>
      createQueuedThreadMessage(harness.db, harness.hub, {
        threadId: alice.thread.id,
        content: textInput("Keep source"),
        ...execution,
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
        requestedBy: { initiator: "agent", senderThreadId },
      }),
    );
    expect(
      setQueuedThreadMessageGroupBoundary({
        db: harness.db,
        notifier: harness.hub,
        threadId: alice.thread.id,
        expectedGroupedPrefixQueuedMessageIds: rows.map((row) => row.id),
        groupBoundaryQueuedMessageId: rows[1]!.id,
      }),
    ).toEqual({ kind: "invalid_execution_options" });
    expect(
      listQueuedThreadMessages(harness.db, alice.thread.id).map(
        (row) => row.groupWithNext,
      ),
    ).toEqual([false, false]);
    harness.db
      .update(queuedThreadMessages)
      .set({ groupWithNext: true })
      .where(eq(queuedThreadMessages.id, rows[0]!.id))
      .run();
    expect(
      claimQueuedThreadMessageGroup(harness.db, harness.hub, rows[0]!.id, {
        kind: "explicit-send",
      })?.map((row) => row.id),
    ).toEqual([rows[0]!.id]);
  });
});

function fixture(harness: TestAppHarness) {
  const subjects = seedControlPlaneJobSubjects(harness.db);
  const { alice } = subjects;
  const profile = createControlPlaneProfile(harness.db, {
    name: "Source agent",
    slug: "source-agent",
    definition: {
      prompt: "Source",
      providerId: "qwen-server",
      model: "qwen-test",
      reasoningLevel: "none",
      permissionMode: "full",
      tools: [],
      mcpServers: [],
    },
  });
  setControlPlaneProfileAccess(
    harness.db,
    profile.profileId,
    alice.user.id,
    true,
  );
  const source = createThread(harness.db, noopNotifier, {
    projectId: alice.project.id,
    environmentId: alice.environment.id,
    providerId: "qwen-server",
    controlPlaneOwnerUserId: alice.user.id,
    controlPlaneProfileVersionId: profile.versionId,
  });
  function append(
    senderThreadId: string | null,
    retryOf?: string,
    before?: () => void,
  ) {
    const requestId = createClientTurnRequestId();
    appendAndQueueSendThreadMessageInTransaction({
      db: harness.db,
      thread: alice.thread,
      environmentId: alice.environment.id,
      execution,
      initiator: retryOf ? "system" : "agent",
      input: textInput("Source message"),
      senderThreadId,
      target: { kind: "new-turn" },
      requestId,
      ...(retryOf
        ? { retryOf: { requestId: createRequestId(retryOf), attempt: 2 } }
        : {}),
      ...(before ? { beforeAppendInTransaction: before } : {}),
      queueInTransaction: () => ({ activeThread: null }),
    });
    return requestId;
  }
  return { ...subjects, source, profile, append };
}

function createRequestId(value: string) {
  return clientTurnRequestIdSchema.parse(value);
}

it("rejects foreign message senders before append or queue mutation without a policy plugin", async () => {
  await withTestHarness(async (harness) => {
    const { alice, bob, append } = fixture(harness);
    const before = listEvents(harness.db, { threadId: alice.thread.id });
    expect(() =>
      resolveMessageSenderThreadId(harness.deps, {
        targetThread: alice.thread,
        senderThreadId: bob.thread.id,
      }),
    ).toThrow("Message source is not authorized");
    expect(() => append(bob.thread.id)).toThrow(
      "Message source is not authorized",
    );
    expect(() =>
      recordQueuedMessageWait(harness.deps, {
        thread: alice.thread,
        claimed: null,
        sendAt: Date.now() + 60000,
        waitingOn: { kind: "time" },
        message: {
          execution,
          input: textInput("Forged sender"),
          senderThreadId: bob.thread.id,
          requestedBy: null,
          payload: { kind: "inline" },
          origin: null,
          originPluginId: null,
          systemNotice: null,
        },
      }),
    ).toThrow("Message source is not authorized");
    expect(listEvents(harness.db, { threadId: alice.thread.id })).toEqual(
      before,
    );
  });
});

it("rechecks source grants inside the request transaction and rolls back revocation and append together", async () => {
  await withTestHarness(async (harness) => {
    const { alice, source, profile, append } = fixture(harness);
    const before = listEvents(harness.db, { threadId: alice.thread.id });
    expect(() =>
      append(source.id, undefined, () =>
        setControlPlaneProfileAccess(
          harness.db,
          profile.profileId,
          alice.user.id,
          false,
        ),
      ),
    ).toThrow("Message source is not authorized");
    expect(listEvents(harness.db, { threadId: alice.thread.id })).toEqual(
      before,
    );
    expect(() =>
      requireControlPlaneThreadDispatch(harness.db, source.id),
    ).not.toThrow();
  });
});

it.each(["profile", "archive", "delete"] as const)(
  "preserves a claimed queue row when its saved source loses %s authority",
  async (change) => {
    await withTestHarness(async (harness) => {
      const { alice, source, profile } = fixture(harness);
      const row = seedQueuedMessage(harness.deps, {
        threadId: alice.thread.id,
        senderThreadId: source.id,
        content: textInput("Retain this input"),
        model: execution.model,
        reasoningLevel: execution.reasoningLevel,
      });
      if (change === "profile")
        setControlPlaneProfileAccess(
          harness.db,
          profile.profileId,
          alice.user.id,
          false,
        );
      else
        harness.db
          .update(threads)
          .set(
            change === "archive"
              ? { archivedAt: Date.now() }
              : { deletedAt: Date.now() },
          )
          .where(eq(threads.id, source.id))
          .run();
      const before = listEvents(harness.db, { threadId: alice.thread.id });
      await expect(
        sendQueuedMessageNow(harness.deps, {
          threadId: alice.thread.id,
          queuedMessageId: row.id,
          mode: "auto",
        }),
      ).rejects.toMatchObject({
        status: 403,
        body: { code: "message_source_not_authorized" },
      });
      expect(getQueuedThreadMessage(harness.db, row.id)).toMatchObject({
        content: row.content,
        senderThreadId: source.id,
        failureCount: 0,
        claimToken: null,
      });
      expect(listEvents(harness.db, { threadId: alice.thread.id })).toEqual(
        before,
      );
      expect(() =>
        requireControlPlaneThreadDispatch(harness.db, alice.thread.id),
      ).not.toThrow();
    });
  },
);

it("recovers source authority through durable system retry requests and refuses missing or cyclic ancestry", async () => {
  await withTestHarness(async (harness) => {
    const { alice, source, profile, append } = fixture(harness);
    const original = append(source.id);
    const retry = append(null, original);
    expect(() =>
      assertControlPlaneTurnRequestSources(harness.db, alice.thread.id, retry),
    ).not.toThrow();
    setControlPlaneProfileAccess(
      harness.db,
      profile.profileId,
      alice.user.id,
      false,
    );
    expect(() =>
      assertControlPlaneTurnRequestSources(harness.db, alice.thread.id, retry),
    ).toThrow("Message source is not authorized");
    expect(() => append(null, original)).toThrow(
      "Message source is not authorized",
    );
    expect(() =>
      assertControlPlaneMessageSources(harness.db, alice.thread.id, {
        retryOfRequestId: createClientTurnRequestId(),
      }),
    ).toThrow("Message source is not authorized");
    setControlPlaneProfileAccess(
      harness.db,
      profile.profileId,
      alice.user.id,
      true,
    );
    const row = getStoredTurnRequestEventByRequestId(
      harness.db,
      alice.thread.id,
      original,
    )!;
    const data = turnRequestEventDataSchema.parse(JSON.parse(row.data));
    harness.db
      .update(events)
      .set({
        data: JSON.stringify({
          ...data,
          retryOfRequestId: original,
          retryAttempt: 2,
        }),
      })
      .where(eq(events.sequence, row.sequence))
      .run();
    expect(() =>
      assertControlPlaneTurnRequestSources(
        harness.db,
        alice.thread.id,
        original,
      ),
    ).toThrow("Message source is not authorized");
  });
});

it("checks source job ancestry and requester identity instead of treating same-owner metadata as authority", async () => {
  await withTestHarness(async (harness) => {
    const { alice, bob } = fixture(harness);
    const parent = createControlPlaneJobBinding(harness.db, {
      ...alice.input,
      userId: alice.user.id,
      profileVersionId: alice.profile.versionId,
    });
    const worker = createControlPlaneJobBinding(harness.db, {
      ...alice.input,
      userId: alice.user.id,
      kind: "workflow-worker",
      objectId: "source-worker",
      profileVersionId: alice.profile.versionId,
      sourceBindingId: parent.id,
    });
    const source = createThread(harness.db, noopNotifier, {
      projectId: alice.project.id,
      environmentId: alice.environment.id,
      providerId: "qwen-server",
      originPluginId: "workflows",
      controlPlaneOwnerUserId: alice.user.id,
      controlPlaneProfileVersionId: alice.profile.versionId,
      controlPlaneJobBindingId: worker.id,
    });
    expect(() =>
      assertControlPlaneMessageSources(harness.db, alice.thread.id, {
        senderThreadId: source.id,
      }),
    ).not.toThrow();
    harness.db
      .update(controlPlaneJobBindings)
      .set({ enabled: false })
      .where(eq(controlPlaneJobBindings.id, parent.id))
      .run();
    expect(() =>
      assertControlPlaneMessageSources(harness.db, alice.thread.id, {
        senderThreadId: source.id,
      }),
    ).toThrow("Message source is not authorized");
    expect(() =>
      assertControlPlaneMessageSources(harness.db, alice.thread.id, {
        requestedByThreadId: bob.thread.id,
      }),
    ).toThrow("Message source is not authorized");
  });
});

it("rechecks the exact saved request after reconnect before transport without changing the daemon protocol", async () => {
  await withTestHarness(async (harness) => {
    const { alice, source, profile, append } = fixture(harness);
    const { session } = seedHostSession(harness.deps, {
      id: alice.environment.hostId,
    });
    harness.hub.unregisterDaemon(session.id);
    const requestId = append(source.id);
    const wait = vi
      .spyOn(harness.hub, "waitForDaemonForHost")
      .mockImplementation(async () => {
        setControlPlaneProfileAccess(
          harness.db,
          profile.profileId,
          alice.user.id,
          false,
        );
        return true;
      });
    const transport = vi.spyOn(harness.hub, "requestHostOnlineRpc");
    try {
      await expect(
        callHostOnlineRpc(harness.deps, {
          hostId: alice.environment.hostId,
          timeoutMs: 1000,
          command: {
            type: "thread.start",
            threadId: alice.thread.id,
            environmentId: alice.environment.id,
            providerId: "qwen-server",
            projectId: alice.project.id,
            workspaceContext: { workspacePath: alice.environment.path! },
            bridgeLaunch: TRANSPORT_TEST_BRIDGE_LAUNCH,
            instructions: "Source probe",
            dynamicTools: [],
            contributedEnv: [],
            injectedSkillSources: [],
            instructionMode: "append",
            input: textInput("Source message"),
            options: {
              model: "qwen-test",
              reasoningLevel: "none",
              serviceTier: "default",
              permissionMode: "full",
              permissionScope: "full",
              approvalReviewer: null,
              permissionEscalation: null,
              providerOptions: {},
            },
            requestId,
          },
        }),
      ).rejects.toMatchObject({
        status: 403,
        body: { code: "message_source_not_authorized" },
      });
      expect(wait).toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    } finally {
      wait.mockRestore();
      transport.mockRestore();
    }
  });
});

it("does not merge managed retries of different source requests", async () => {
  await withTestHarness(async (harness) => {
    const { alice, source, append } = fixture(harness);
    const originalIds = [append(source.id), append(alice.thread.id)];
    const rows = originalIds.map((retryOfTurnRequestId) =>
      createQueuedThreadMessage(harness.db, harness.hub, {
        threadId: alice.thread.id,
        content: textInput("Retry saved input"),
        ...execution,
        waitingOn: null,
        sendAt: null,
        systemNotice: null,
        payload: {
          kind: "retry",
          retryOfTurnRequestId,
          attempt: 2,
          reason: "Retry",
        },
      }),
    );
    expect(
      setQueuedThreadMessageGroupBoundary({
        db: harness.db,
        notifier: harness.hub,
        threadId: alice.thread.id,
        expectedGroupedPrefixQueuedMessageIds: rows.map((row) => row.id),
        groupBoundaryQueuedMessageId: rows[1]!.id,
      }),
    ).toEqual({ kind: "invalid_execution_options" });
    harness.db
      .update(queuedThreadMessages)
      .set({ groupWithNext: true })
      .where(eq(queuedThreadMessages.id, rows[0]!.id))
      .run();
    expect(
      claimQueuedThreadMessageGroup(harness.db, harness.hub, rows[0]!.id, {
        kind: "explicit-send",
      })?.map((row) => row.id),
    ).toEqual([rows[0]!.id]);
  });
});
