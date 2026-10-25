import { eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import {
  createThread,
  createProject,
  createControlPlaneProject,
  createControlPlaneProfile,
  getThread,
  noopNotifier,
  updateThread,
  threads,
  controlPlaneProjectAccess,
  setControlPlaneProfileAccess,
  listEvents,
  listQueuedThreadMessages,
} from "@bb/db";
import { appendClientTurnEventInTransaction } from "../../src/services/threads/thread-events.js";
import { assertControlPlaneTurnRequestSources } from "../../src/control-plane/message-source-authority.js";
import { callHostOnlineRpc } from "../../src/services/hosts/online-rpc.js";
import { seedHostSession } from "../helpers/seed.js";
import { TRANSPORT_TEST_BRIDGE_LAUNCH } from "../helpers/provider-registry.js";
import type { SystemMessageKind, SystemMessageSubject } from "@bb/domain";
import { assertControlPlaneSystemMessage } from "../../src/control-plane/system-message-authority.js";
import { assertValidParentThread } from "../../src/services/threads/thread-parent.js";
import { queueParentSystemMessage } from "../../src/services/threads/parent-system-messages.js";
import { deliverLegacyDeferredThreadMessages } from "../../src/services/threads/legacy-deferred-messages.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { withTestHarness } from "../helpers/test-app.js";

it("rejects cross-owner parent changes at API preparation and atomic database mutation, but permits detach", async () => {
  await withTestHarness(async ({ db }) => {
    const { alice, bob } = seedControlPlaneJobSubjects(db);
    expect(() =>
      assertValidParentThread(
        { db },
        { childThreadId: alice.thread.id, parentThreadId: bob.thread.id },
      ),
    ).toThrow("Thread execution is not authorized");
    expect(() =>
      updateThread(db, noopNotifier, alice.thread.id, {
        parentThreadId: bob.thread.id,
        title: "Must roll back",
      }),
    ).toThrow();
    expect(getThread(db, alice.thread.id)?.parentThreadId).toBeNull();
    expect(getThread(db, alice.thread.id)?.title).not.toBe("Must roll back");
    const child = createThread(db, noopNotifier, {
      projectId: alice.project.id,
      environmentId: alice.environment.id,
      providerId: "qwen-server",
      controlPlaneOwnerUserId: alice.user.id,
      controlPlaneProfileVersionId: alice.profile.versionId,
    });
    updateThread(db, noopNotifier, child.id, {
      parentThreadId: alice.thread.id,
    });
    expect(getThread(db, child.id)?.parentThreadId).toBe(alice.thread.id);
    db.delete(controlPlaneProjectAccess)
      .where(eq(controlPlaneProjectAccess.userId, alice.user.id))
      .run();
    expect(() =>
      updateThread(db, noopNotifier, child.id, {
        parentThreadId: bob.thread.id,
      }),
    ).toThrow();
    updateThread(db, noopNotifier, child.id, { parentThreadId: null });
    expect(getThread(db, child.id)?.parentThreadId).toBeNull();
  });
});

it("does not connect managed threads to unmanaged operator threads in either direction", async () => {
  await withTestHarness(async ({ db }) => {
    const { alice } = seedControlPlaneJobSubjects(db);
    const { project } = createProject(db, noopNotifier, {
      name: "Operator",
      source: {
        type: "local_path",
        hostId: alice.environment.hostId,
        path: "/tmp/operator-project",
      },
    });
    const operator = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "test",
    });
    for (const [child, parent] of [
      [alice.thread.id, operator.id],
      [operator.id, alice.thread.id],
    ])
      expect(() =>
        updateThread(db, noopNotifier, child!, { parentThreadId: parent! }),
      ).toThrow();
  });
});

for (const kind of [
  "ownership-assigned",
  "ownership-removed",
  "child-needs-attention",
  "child-completed",
  "child-failed",
  "child-interrupted",
] as const) {
  it(`checks every subject of ${kind} before creating a turn or queue entry`, async () => {
    await withTestHarness(async (harness) => {
      const { alice, bob } = seedControlPlaneJobSubjects(harness.db);
      await expect(
        queueParentSystemMessage(harness.deps, {
          parentThreadId: alice.thread.id,
          input: [{ type: "text", text: "Foreign result", mentions: [] }],
          systemMessageKind: kind,
          systemMessageSubject: {
            kind: "thread",
            threadId: bob.thread.id,
            threadName: "Foreign",
          },
        }),
      ).rejects.toThrow("Message source is not authorized");
      expect(listEvents(harness.db, { threadId: alice.thread.id })).toEqual([]);
      expect(listQueuedThreadMessages(harness.db, alice.thread.id)).toEqual([]);
    });
  });
}

it("checks a complete outcome batch and still allows archived same-owner results from a retired profile", async () => {
  await withTestHarness(async ({ db }) => {
    const { alice, bob } = seedControlPlaneJobSubjects(db);
    const retiredProfile = createControlPlaneProfile(db, {
      slug: "retired",
      name: "Retired",
      definition: {
        prompt: "Retired source",
        providerId: "qwen-server",
        model: "qwen-test",
        reasoningLevel: "none",
        permissionMode: "full",
        tools: [],
        mcpServers: [],
      },
    });
    setControlPlaneProfileAccess(
      db,
      retiredProfile.profileId,
      alice.user.id,
      true,
    );
    const child = createThread(db, noopNotifier, {
      projectId: alice.project.id,
      providerId: "qwen-server",
      controlPlaneOwnerUserId: alice.user.id,
      controlPlaneProfileVersionId: retiredProfile.versionId,
    });
    setControlPlaneProfileAccess(
      db,
      retiredProfile.profileId,
      alice.user.id,
      false,
    );
    db.update(threads)
      .set({ archivedAt: Date.now() })
      .where(eq(threads.id, child.id))
      .run();
    const subject = {
      kind: "thread-batch",
      count: 1,
      outcomes: [{ threadId: child.id, status: "completed" }],
    } as const;
    expect(() =>
      assertControlPlaneSystemMessage(db, alice.thread.id, "child-completed", {
        kind: "thread",
        threadId: child.id,
        threadName: "Child",
      }),
    ).not.toThrow();
    expect(() =>
      assertControlPlaneSystemMessage(
        db,
        alice.thread.id,
        "child-outcome-batch",
        { ...subject, outcomes: [...subject.outcomes] },
      ),
    ).not.toThrow();
    expect(() =>
      assertControlPlaneSystemMessage(
        db,
        alice.thread.id,
        "child-outcome-batch",
        {
          kind: "thread-batch",
          count: 2,
          outcomes: [
            ...subject.outcomes,
            { threadId: bob.thread.id, status: "failed" },
          ],
        },
      ),
    ).toThrow();
    db.update(threads)
      .set({ deletedAt: Date.now() })
      .where(eq(threads.id, child.id))
      .run();
    expect(() =>
      assertControlPlaneSystemMessage(db, alice.thread.id, "child-completed", {
        kind: "thread",
        threadId: child.id,
        threadName: "Child",
      }),
    ).toThrow();
  });
});

it("denies malformed managed metadata, stale directories and unlabeled messages", async () => {
  await withTestHarness(async ({ db }) => {
    const { alice } = seedControlPlaneJobSubjects(db);
    const invalid: [SystemMessageKind, SystemMessageSubject | null][] = [
      ["unlabeled", null],
      ["child-completed", null],
      ["child-outcome-batch", { kind: "thread-batch", count: 1 }],
      [
        "environment-directory-updated",
        { kind: "directory", path: "/tmp/other" },
      ],
      [
        "tool-result-delivered",
        { kind: "tool-call", toolName: "", suppress: false },
      ],
    ];
    for (const [kind, subject] of invalid)
      expect(() =>
        assertControlPlaneSystemMessage(db, alice.thread.id, kind, subject),
      ).toThrow("Message source is not authorized");
    expect(() =>
      assertControlPlaneSystemMessage(
        db,
        alice.thread.id,
        "environment-directory-updated",
        { kind: "directory", path: alice.environment.path! },
      ),
    ).not.toThrow();
    expect(() =>
      assertControlPlaneSystemMessage(
        db,
        alice.thread.id,
        "tool-result-delivered",
        { kind: "tool-call", toolName: "owned-completion", suppress: false },
      ),
    ).not.toThrow();
    setControlPlaneProfileAccess(
      db,
      alice.profile.profileId,
      alice.user.id,
      false,
    );
    expect(() =>
      assertControlPlaneSystemMessage(
        db,
        alice.thread.id,
        "tool-result-delivered",
        { kind: "tool-call", toolName: "owned-completion", suppress: false },
      ),
    ).toThrow();
  });
});

it.each([true, false])(
  "retains unknown legacy input without dispatch or duplicate errors when unowned replay is %s",
  async (allowUnownedLegacyReplay) => {
    await withTestHarness(async (harness) => {
      const { alice } = seedControlPlaneJobSubjects(harness.db);
      const payload = JSON.stringify({
        kind: "send",
        request: {
          input: [{ type: "text", text: "Unknown old sender", mentions: [] }],
        },
      });
      harness.db.run(
        sql`INSERT INTO deferred_thread_messages_legacy (id, thread_id, kind, payload, created_at) VALUES ('legacy-unowned', ${alice.thread.id}, 'send', ${payload}, 1)`,
      );
      const options = { allowUnownedLegacyReplay };
      await deliverLegacyDeferredThreadMessages(harness.deps, options);
      await deliverLegacyDeferredThreadMessages(harness.deps, options);
      expect(
        harness.db.get<{ payload: string }>(
          sql`SELECT payload FROM deferred_thread_messages_legacy WHERE id='legacy-unowned'`,
        )?.payload,
      ).toBe(payload);
      const events = listEvents(harness.db, { threadId: alice.thread.id });
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("system/error");
      expect(events[0]?.data).toContain("legacy_deferred_not_authorized");
      expect(events[0]?.data).not.toContain("Unknown old sender");
      expect(listQueuedThreadMessages(harness.db, alice.thread.id)).toEqual([]);
    });
  },
);

it("rechecks current read access to a same-owner source project after a notice was recorded", async () => {
  await withTestHarness(async ({ db }) => {
    const { alice } = seedControlPlaneJobSubjects(db);
    const { project } = createControlPlaneProject(db, noopNotifier, {
      userId: alice.user.id,
      hostId: alice.environment.hostId,
      name: "Other",
      slug: "other",
    });
    const source = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "qwen-server",
      controlPlaneOwnerUserId: alice.user.id,
      controlPlaneProfileVersionId: alice.profile.versionId,
    });
    const subject = {
      kind: "thread",
      threadId: source.id,
      threadName: "Owned result",
    } as const;
    const request = db.transaction((tx) =>
      appendClientTurnEventInTransaction(tx, {
        threadId: alice.thread.id,
        environmentId: alice.environment.id,
        type: "client/turn/requested",
        execution: {
          model: "qwen-test",
          reasoningLevel: "none",
          permissionMode: "full",
          serviceTier: "default",
          source: "client/turn/requested",
        },
        initiator: "system",
        input: [{ type: "text", text: "Owned status", mentions: [] }],
        senderThreadId: null,
        source: "tell",
        target: { kind: "new-turn" },
        requestMethod: "turn/start",
        systemMessageKind: "ownership-removed",
        systemMessageSubject: subject,
      }),
    );
    expect(() =>
      assertControlPlaneTurnRequestSources(
        db,
        alice.thread.id,
        request.requestId,
      ),
    ).not.toThrow();
    db.delete(controlPlaneProjectAccess)
      .where(eq(controlPlaneProjectAccess.projectId, project.id))
      .run();
    expect(() =>
      assertControlPlaneSystemMessage(
        db,
        alice.thread.id,
        "ownership-removed",
        subject,
      ),
    ).toThrow("Message source is not authorized");
    expect(() =>
      assertControlPlaneTurnRequestSources(
        db,
        alice.thread.id,
        request.requestId,
      ),
    ).toThrow("Message source is not authorized");
  });
});

it("rechecks a saved system subject after reconnect before actual daemon transport", async () => {
  await withTestHarness(async (harness) => {
    const { alice } = seedControlPlaneJobSubjects(harness.db);
    const { project } = createControlPlaneProject(harness.db, noopNotifier, {
      userId: alice.user.id,
      hostId: alice.environment.hostId,
      name: "Status source",
      slug: "status-source",
    });
    const child = createThread(harness.db, noopNotifier, {
      projectId: project.id,
      providerId: "qwen-server",
      controlPlaneOwnerUserId: alice.user.id,
      controlPlaneProfileVersionId: alice.profile.versionId,
    });
    const { requestId } = harness.db.transaction((tx) =>
      appendClientTurnEventInTransaction(tx, {
        threadId: alice.thread.id,
        environmentId: alice.environment.id,
        type: "client/turn/requested",
        execution: {
          model: "qwen-test",
          reasoningLevel: "none",
          permissionMode: "full",
          serviceTier: "default",
          source: "client/turn/requested",
        },
        initiator: "system",
        input: [{ type: "text", text: "Owned status", mentions: [] }],
        senderThreadId: null,
        source: "tell",
        target: { kind: "thread-start" },
        requestMethod: "thread/start",
        systemMessageKind: "child-completed",
        systemMessageSubject: {
          kind: "thread",
          threadId: child.id,
          threadName: "Owned source",
        },
      }),
    );
    const { session } = seedHostSession(harness.deps, {
      id: alice.environment.hostId,
    });
    harness.hub.unregisterDaemon(session.id);
    const wait = vi
      .spyOn(harness.hub, "waitForDaemonForHost")
      .mockImplementation(async () => {
        harness.db
          .delete(controlPlaneProjectAccess)
          .where(eq(controlPlaneProjectAccess.projectId, project.id))
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
            instructions: "Owned status",
            instructionMode: "append",
            injectedSkillSources: [],
            dynamicTools: [],
            contributedEnv: [],
            requestId,
            input: [{ type: "text", text: "Owned status", mentions: [] }],
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
