import { expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  controlPlaneTurnSources,
  controlPlaneJobBindings,
  controlPlaneJobNotifications,
  createControlPlaneJobBinding,
  createThread,
  createControlPlaneProfile,
  setControlPlaneProfileAccess,
  noopNotifier,
  threads,
  events,
  listEvents,
} from "@bb/db";
import { appendAndQueueSendThreadMessageInTransaction } from "../../src/services/threads/thread-send.js";
import { createClientTurnRequestId } from "../../src/services/threads/thread-events.js";
import {
  resolveDeferredFirstTurnContext,
  requireDeferredFirstTurnContextCurrent,
} from "../../src/services/threads/deferred-first-turn-context.js";
import { assertControlPlaneTurnRequestSources } from "../../src/control-plane/message-source-authority.js";
import { acceptControlPlaneWorkflowNotification } from "../../src/control-plane/workflow-notifications.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { seedHostSession } from "../helpers/seed.js";
import { TRANSPORT_TEST_BRIDGE_LAUNCH } from "../helpers/provider-registry.js";
import { callHostOnlineRpc } from "../../src/services/hosts/online-rpc.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import type { ClientTurnRequestId } from "@bb/domain";

const execution = {
  model: "qwen-test",
  reasoningLevel: "none",
  permissionMode: "full",
  serviceTier: "default",
  source: "client/turn/requested",
} as const;

it("admits 32 inherited requests and rolls back the event that would exceed the source budget", async () => {
  await withTestHarness(async (harness) => {
    const { alice, append } = fixture(harness);
    let requestId = append();
    for (let index = 1; index < 32; index += 1)
      requestId = append({ sourceRequestId: requestId });
    expect(() =>
      assertControlPlaneTurnRequestSources(
        harness.db,
        alice.thread.id,
        requestId,
      ),
    ).not.toThrow();
    expect(() => append({ sourceRequestId: requestId })).toThrow(
      "Message source is not authorized",
    );
    expect(
      harness.db
        .select()
        .from(controlPlaneTurnSources)
        .where(eq(controlPlaneTurnSources.threadId, alice.thread.id))
        .all(),
    ).toHaveLength(32);
    expect(listEvents(harness.db, { threadId: alice.thread.id })).toHaveLength(
      32,
    );
  });
});

function fixture(harness: TestAppHarness) {
  const { alice, bob } = seedControlPlaneJobSubjects(harness.db);
  const profile = createControlPlaneProfile(harness.db, {
    slug: "deferred-source",
    name: "Deferred source",
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
  function append({
    sourceRequestId,
    retryOf,
    senderThreadId = null,
    accept,
    fail = false,
  }: {
    sourceRequestId?: ClientTurnRequestId;
    retryOf?: ClientTurnRequestId;
    senderThreadId?: string | null;
    accept?: (requestId: ClientTurnRequestId) => void;
    fail?: boolean;
  } = {}) {
    const requestId = createClientTurnRequestId();
    appendAndQueueSendThreadMessageInTransaction({
      db: harness.db,
      thread: alice.thread,
      environmentId: alice.environment.id,
      execution,
      initiator: senderThreadId ? "agent" : "user",
      input: [
        {
          type: "text",
          text: "Undelivered context",
          mentions: [],
          visibility: "agent-only",
        },
      ],
      senderThreadId,
      requestId,
      sourceRequestId,
      ...(retryOf ? { retryOf: { requestId: retryOf, attempt: 2 } } : {}),
      target: { kind: "new-turn" },
      beforeAppendInTransaction: () => accept?.(requestId),
      queueInTransaction: () => {
        if (fail) throw new Error("Interrupted commit");
        return { activeThread: null };
      },
    });
    return requestId;
  }
  return { alice, bob, source, profile, append };
}

it("rechecks deferred context during preparation and commit, then retains its source after another request becomes latest", async () => {
  await withTestHarness(async (harness) => {
    const { alice, source, profile, append } = fixture(harness);
    const first = append({ senderThreadId: source.id });
    harness.db
      .update(threads)
      .set({ status: "error" })
      .where(eq(threads.id, alice.thread.id))
      .run();
    const deferred = resolveDeferredFirstTurnContext(
      harness.db,
      alice.thread.id,
    )!;
    expect(deferred.requestId).toBe(first);
    setControlPlaneProfileAccess(
      harness.db,
      profile.profileId,
      alice.user.id,
      false,
    );
    expect(() =>
      resolveDeferredFirstTurnContext(harness.db, alice.thread.id),
    ).toThrow("Message source is not authorized");
    expect(() =>
      requireDeferredFirstTurnContextCurrent(harness.db, {
        threadId: alice.thread.id,
        requestSequence: deferred.requestSequence,
      }),
    ).toThrow("Message source is not authorized");
    setControlPlaneProfileAccess(
      harness.db,
      profile.profileId,
      alice.user.id,
      true,
    );
    const second = append({ sourceRequestId: first });
    const third = append({ sourceRequestId: second });
    expect(() =>
      assertControlPlaneTurnRequestSources(harness.db, alice.thread.id, third),
    ).not.toThrow();
    setControlPlaneProfileAccess(
      harness.db,
      profile.profileId,
      alice.user.id,
      false,
    );
    expect(() =>
      assertControlPlaneTurnRequestSources(harness.db, alice.thread.id, third),
    ).toThrow("Message source is not authorized");
    expect(
      harness.db
        .select()
        .from(controlPlaneTurnSources)
        .where(eq(controlPlaneTurnSources.requestId, second))
        .get()?.sourceRequestId,
    ).toBe(first);
  });
});

it("rolls back inherited context and notification receipt with a failed request transaction", async () => {
  await withTestHarness(async (harness) => {
    const { alice, append } = fixture(harness);
    const binding = createControlPlaneJobBinding(harness.db, {
      ...alice.input,
      userId: alice.user.id,
      profileVersionId: alice.profile.versionId,
    });
    expect(() =>
      append({
        fail: true,
        accept: (requestId) =>
          acceptControlPlaneWorkflowNotification(
            harness.db,
            binding.id,
            alice.thread.id,
            requestId,
          ),
      }),
    ).toThrow("Interrupted commit");
    expect(harness.db.select().from(controlPlaneTurnSources).all()).toEqual([]);
    expect(
      harness.db.select().from(controlPlaneJobNotifications).all(),
    ).toEqual([]);
    expect(listEvents(harness.db, { threadId: alice.thread.id })).toEqual([]);
  });
});

it("rechecks the exact notification binding for copied input and retains ordinary fresh-message admission", async () => {
  await withTestHarness(async (harness) => {
    const { alice, append } = fixture(harness);
    const binding = createControlPlaneJobBinding(harness.db, {
      ...alice.input,
      userId: alice.user.id,
      profileVersionId: alice.profile.versionId,
    });
    const notice = append({
      accept: (requestId) =>
        acceptControlPlaneWorkflowNotification(
          harness.db,
          binding.id,
          alice.thread.id,
          requestId,
        ),
    });
    const copied = append({ sourceRequestId: notice });
    expect(() =>
      assertControlPlaneTurnRequestSources(harness.db, alice.thread.id, copied),
    ).not.toThrow();
    harness.db
      .update(controlPlaneJobBindings)
      .set({ enabled: false })
      .where(eq(controlPlaneJobBindings.id, binding.id))
      .run();
    expect(() =>
      assertControlPlaneTurnRequestSources(harness.db, alice.thread.id, copied),
    ).toThrow("Message source is not authorized");
    expect(() => append({ sourceRequestId: notice })).toThrow(
      "Message source is not authorized",
    );
    const fresh = append();
    expect(() =>
      assertControlPlaneTurnRequestSources(harness.db, alice.thread.id, fresh),
    ).not.toThrow();
  });
});

it("does not infer legacy notification provenance or accept a foreign inherited request ID", async () => {
  await withTestHarness(async (harness) => {
    const { alice, bob, append } = fixture(harness);
    const old = append();
    const binding = createControlPlaneJobBinding(harness.db, {
      ...alice.input,
      userId: alice.user.id,
      profileVersionId: alice.profile.versionId,
    });
    harness.db
      .delete(controlPlaneTurnSources)
      .where(eq(controlPlaneTurnSources.requestId, old))
      .run();
    harness.db
      .insert(controlPlaneJobNotifications)
      .values({
        bindingId: binding.id,
        threadId: alice.thread.id,
        acceptedAt: Date.now(),
      })
      .run();
    expect(() =>
      assertControlPlaneTurnRequestSources(harness.db, alice.thread.id, old),
    ).toThrow("Message source is not authorized");
    expect(() =>
      assertControlPlaneTurnRequestSources(harness.db, bob.thread.id, old),
    ).toThrow("Message source is not authorized");
    const fresh = append();
    expect(() =>
      assertControlPlaneTurnRequestSources(harness.db, alice.thread.id, fresh),
    ).not.toThrow();
  });
});

it("refuses cyclic or pruned inherited requests without rejecting a shared ancestor", async () => {
  await withTestHarness(async (harness) => {
    const { alice, append } = fixture(harness);
    const first = append();
    const second = append({ sourceRequestId: first });
    const shared = append({ sourceRequestId: first, retryOf: first });
    expect(() =>
      assertControlPlaneTurnRequestSources(harness.db, alice.thread.id, shared),
    ).not.toThrow();
    harness.db
      .update(controlPlaneTurnSources)
      .set({ sourceRequestId: second })
      .where(eq(controlPlaneTurnSources.requestId, first))
      .run();
    expect(() =>
      assertControlPlaneTurnRequestSources(harness.db, alice.thread.id, second),
    ).toThrow("Message source is not authorized");
    harness.db
      .update(controlPlaneTurnSources)
      .set({ sourceRequestId: null })
      .where(eq(controlPlaneTurnSources.requestId, first))
      .run();
    harness.db
      .delete(events)
      .where(
        and(
          eq(events.threadId, alice.thread.id),
          eq(events.type, "client/turn/requested"),
        ),
      )
      .run();
    expect(() =>
      assertControlPlaneTurnRequestSources(harness.db, alice.thread.id, second),
    ).toThrow("Message source is not authorized");
  });
});

it("rechecks inherited notification authority after reconnect before actual daemon transport", async () => {
  await withTestHarness(async (harness) => {
    const { alice, append } = fixture(harness);
    const binding = createControlPlaneJobBinding(harness.db, {
      ...alice.input,
      userId: alice.user.id,
      profileVersionId: alice.profile.versionId,
    });
    const notice = append({
      accept: (requestId) =>
        acceptControlPlaneWorkflowNotification(
          harness.db,
          binding.id,
          alice.thread.id,
          requestId,
        ),
    });
    const requestId = append({ sourceRequestId: notice });
    const { session } = seedHostSession(harness.deps, {
      id: alice.environment.hostId,
    });
    harness.hub.unregisterDaemon(session.id);
    const wait = vi
      .spyOn(harness.hub, "waitForDaemonForHost")
      .mockImplementation(async () => {
        harness.db
          .update(controlPlaneJobBindings)
          .set({ enabled: false })
          .where(eq(controlPlaneJobBindings.id, binding.id))
          .run();
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
            environmentId: alice.environment.id,
            threadId: alice.thread.id,
            projectId: alice.project.id,
            providerId: "qwen-server",
            bridgeLaunch: TRANSPORT_TEST_BRIDGE_LAUNCH,
            workspaceContext: { workspacePath: alice.environment.path! },
            instructions: "Inherited context",
            instructionMode: "append",
            injectedSkillSources: [],
            dynamicTools: [],
            contributedEnv: [],
            requestId,
            input: [{ type: "text", text: "Inherited context", mentions: [] }],
            options: {
              model: "qwen-test",
              reasoningLevel: "none",
              serviceTier: "default",
              providerOptions: {},
              permissionMode: "full",
              permissionScope: "full",
              permissionEscalation: null,
              approvalReviewer: null,
            },
          },
        }),
      ).rejects.toMatchObject({
        status: 403,
        body: { code: "message_source_not_authorized" },
      });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      wait.mockRestore();
      transport.mockRestore();
    }
  });
});

it("refuses an unmarked legacy ordinary request without requiring a legacy notification receipt", async () => {
  await withTestHarness(async (harness) => {
    const { alice, append } = fixture(harness);
    const old = append();
    harness.db
      .delete(controlPlaneTurnSources)
      .where(eq(controlPlaneTurnSources.requestId, old))
      .run();
    expect(() =>
      assertControlPlaneTurnRequestSources(harness.db, alice.thread.id, old),
    ).toThrow("Message source is not authorized");
    expect(() => append({ sourceRequestId: old })).toThrow(
      "Message source is not authorized",
    );
    const fresh = append();
    expect(() =>
      assertControlPlaneTurnRequestSources(harness.db, alice.thread.id, fresh),
    ).not.toThrow();
  });
});
