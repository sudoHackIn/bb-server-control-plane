import {
  controlPlaneThreads,
  getPendingInteraction,
  getLatestThreadSequence,
  listPendingInteractionsByThread,
  setControlPlaneProfileAccess,
  setPendingInteractionResolving,
  threads,
} from "@bb/db";
import { createBbSdk } from "@bb/sdk/core";
import { createHttpTransport } from "@bb/sdk/node";
import { eq } from "drizzle-orm";
import { turnScope } from "@bb/domain";
import { expect, it, vi } from "vitest";
import { callHostOnlineRpc } from "../../src/services/hosts/online-rpc.js";
import { stopExecutionAdmission } from "../../src/services/system/execution-admission.js";
import {
  internalAuthHeaders,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { createCommandApprovalPayload } from "../helpers/pending-interactions.js";
import {
  seedHostSession,
  seedThreadIdentity,
  seedTurnStarted,
  seedStoredEvent,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function fixture(harness: TestAppHarness) {
  const subjects = seedControlPlaneJobSubjects(harness.db);
  const { session, host } = seedHostSession(harness.deps, {
    id: subjects.alice.environment.hostId,
  });
  for (const subject of Object.values(subjects)) {
    harness.db
      .update(threads)
      .set({ status: "active" })
      .where(eq(threads.id, subject.thread.id))
      .run();
    const providerThreadId = `qwen-${subject.user.login}`;
    harness.db
      .update(controlPlaneThreads)
      .set({ qwenSessionId: providerThreadId })
      .where(eq(controlPlaneThreads.threadId, subject.thread.id))
      .run();
    seedThreadIdentity(harness.deps, {
      threadId: subject.thread.id,
      environmentId: subject.environment.id,
      providerThreadId,
    });
    for (const turnId of [
      `old-${subject.user.login}`,
      `turn-${subject.user.login}`,
    ])
      seedTurnStarted(harness.deps, {
        threadId: subject.thread.id,
        environmentId: subject.environment.id,
        providerThreadId,
        turnId,
      });
  }
  const interaction = {
    threadId: subjects.alice.thread.id,
    turnId: "turn-alice",
    providerId: "qwen-server",
    providerThreadId: "qwen-alice",
    providerRequestId: "approval-alice",
    payload: createCommandApprovalPayload({
      itemId: "item",
      command: "git push",
      cwd: subjects.alice.environment.path ?? "/",
      reason: "Approval",
    }),
  };
  const post = (input = interaction) =>
    harness.app.request("/internal/session/interactive-request", {
      method: "POST",
      headers: internalAuthHeaders(harness),
      body: JSON.stringify({ sessionId: session.id, interaction: input }),
    });
  const sdk = createBbSdk({
    transport: createHttpTransport({
      baseUrl: "http://localhost",
      runtime: "node",
      fetch: async (input, init) => harness.app.fetch(new Request(input, init)),
    }),
  });
  return { ...subjects, session, host, interaction, post, sdk };
}

it("binds managed approval registration to the current turn, native Qwen session and provider before persistence", async () => {
  await withTestHarness(async (harness) => {
    const { alice, bob, interaction, post } = fixture(harness);
    for (const changed of [
      { turnId: "old-alice" },
      { turnId: "missing" },
      { providerThreadId: "qwen-bob" },
      { providerId: "codex" },
      { threadId: bob.thread.id },
    ]) {
      expect((await post({ ...interaction, ...changed })).status).toBe(403);
      expect(
        listPendingInteractionsByThread(harness.db, {
          threadId: alice.thread.id,
        }),
      ).toHaveLength(0);
      expect(
        listPendingInteractionsByThread(harness.db, {
          threadId: bob.thread.id,
        }),
      ).toHaveLength(0);
    }
    const registered = await post();
    expect(registered.status).toBe(200);
    expect(await registered.json()).toMatchObject({
      outcome: "created",
      status: "pending",
    });
    expect((await post()).status).toBe(200);
    expect(
      listPendingInteractionsByThread(harness.db, {
        threadId: alice.thread.id,
      }),
    ).toHaveLength(1);
    setControlPlaneProfileAccess(
      harness.db,
      alice.profile.profileId,
      alice.user.id,
      false,
    );
    expect(
      (await post({ ...interaction, providerRequestId: "revoked" })).status,
    ).toBe(403);
    expect(
      listPendingInteractionsByThread(harness.db, {
        threadId: alice.thread.id,
      }),
    ).toHaveLength(1);
  });
});

it.each(["turn", "session", "profile", "shutdown"] as const)(
  "rechecks %s before full SDK or core approval resolution changes pending state",
  async (changed) => {
    await withTestHarness(async (harness) => {
      const { alice, interaction, post, sdk, session } = fixture(harness);
      expect((await post()).status).toBe(200);
      const saved = listPendingInteractionsByThread(harness.db, {
        threadId: alice.thread.id,
      })[0];
      if (!saved) throw new Error("Missing saved approval");
      if (changed === "turn")
        seedTurnStarted(harness.deps, {
          threadId: alice.thread.id,
          environmentId: alice.environment.id,
          providerThreadId: "qwen-alice",
          turnId: "new-turn",
        });
      if (changed === "session")
        harness.db
          .update(controlPlaneThreads)
          .set({ qwenSessionId: "replaced-session" })
          .where(eq(controlPlaneThreads.threadId, alice.thread.id))
          .run();
      if (changed === "profile")
        setControlPlaneProfileAccess(
          harness.db,
          alice.profile.profileId,
          alice.user.id,
          false,
        );
      if (changed === "shutdown") stopExecutionAdmission(harness.db);
      const args = {
        threadId: alice.thread.id,
        interactionId: saved.id,
        resolution: {
          decision: "allow_once" as const,
          grantedPermissions: null,
        },
      };
      const status = changed === "shutdown" ? 503 : 403;
      expect(() =>
        harness.deps.pendingInteractions.resolvePendingInteraction(args),
      ).toThrow();
      await expect(
        sdk.threads.interactions.resolve(args),
      ).rejects.toMatchObject({ status });
      expect(getPendingInteraction(harness.db, saved.id)).toEqual(saved);
      expect(
        (await post({ ...interaction, providerRequestId: "new-after-change" }))
          .status,
      ).toBe(status);
      const cleanup = await harness.app.request(
        "/internal/session/interactive-request/interrupt",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            providerId: "qwen-server",
            threadIds: [alice.thread.id],
            reason: "thread-stopped",
          }),
        },
      );
      expect(cleanup.status).toBe(200);
      expect(getPendingInteraction(harness.db, saved.id)?.status).toBe(
        "interrupted",
      );
    });
  },
);

it("delivers an authorized resolution through the existing daemon contract", async () => {
  await withTestHarness(async (harness) => {
    const { alice, post, sdk } = fixture(harness);
    expect((await post()).status).toBe(200);
    const saved = listPendingInteractionsByThread(harness.db, {
      threadId: alice.thread.id,
    })[0];
    if (!saved) throw new Error("Missing saved approval");
    const resolved = await sdk.threads.interactions.resolve({
      threadId: alice.thread.id,
      interactionId: saved.id,
      resolution: { decision: "allow_once", grantedPermissions: null },
    });
    expect(resolved.status).toBe("resolving");
    const command = await waitForQueuedCommand(
      harness,
      ({ command }) =>
        command.type === "interactive.resolve" &&
        command.interactionId === saved.id,
    );
    expect(command.command).toMatchObject({
      threadId: alice.thread.id,
      providerThreadId: "qwen-alice",
      providerRequestId: "approval-alice",
    });
    expect(command.command).not.toHaveProperty("turnId");
    await reportQueuedCommandSuccess(harness, command, {});
    expect(getPendingInteraction(harness.db, saved.id)?.status).toBe(
      "resolved",
    );
  });
});

it("refuses requests for a completed turn even while the thread status is still active", async () => {
  await withTestHarness(async (harness) => {
    const { alice, post } = fixture(harness);
    seedStoredEvent(harness.deps, {
      threadId: alice.thread.id,
      environmentId: alice.environment.id,
      providerThreadId: "qwen-alice",
      sequence:
        getLatestThreadSequence(harness.db, { threadId: alice.thread.id }) + 1,
      type: "turn/completed",
      scope: turnScope("turn-alice"),
      data: { status: "completed" },
    });
    expect((await post()).status).toBe(403);
    expect(
      listPendingInteractionsByThread(harness.db, {
        threadId: alice.thread.id,
      }),
    ).toHaveLength(0);
  });
});

it("rejects a resolution command with a substituted saved interaction identity before transport", async () => {
  await withTestHarness(async (harness) => {
    const { alice, bob, host, post } = fixture(harness);
    expect((await post()).status).toBe(200);
    const saved = listPendingInteractionsByThread(harness.db, {
      threadId: alice.thread.id,
    })[0];
    if (!saved) throw new Error("Missing saved approval");
    setPendingInteractionResolving(harness.db, {
      id: saved.id,
      resolution: JSON.stringify({
        decision: "allow_once",
        grantedPermissions: null,
      }),
    });
    const send = vi.spyOn(harness.hub, "requestHostOnlineRpc");
    try {
      for (const changed of [
        { interactionId: "missing" },
        { threadId: bob.thread.id },
        { providerRequestId: "substituted" },
        { providerThreadId: "qwen-bob" },
        { providerId: "codex" },
        { environmentId: bob.environment.id },
        { resolution: { decision: "deny" as const } },
      ]) {
        await expect(
          callHostOnlineRpc(harness.deps, {
            hostId: host.id,
            timeoutMs: 1000,
            command: {
              type: "interactive.resolve",
              environmentId: alice.environment.id,
              threadId: alice.thread.id,
              interactionId: saved.id,
              providerId: "qwen-server",
              providerThreadId: "qwen-alice",
              providerRequestId: "approval-alice",
              resolution: { decision: "allow_once", grantedPermissions: null },
              ...changed,
            },
          }),
        ).rejects.toMatchObject({ status: 403 });
      }
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
  });
});

it("rechecks the saved approval and grants after reconnect before an outbound resolution is sent", async () => {
  await withTestHarness(async (harness) => {
    const { alice, post, session, host } = fixture(harness);
    expect((await post()).status).toBe(200);
    const saved = listPendingInteractionsByThread(harness.db, {
      threadId: alice.thread.id,
    })[0];
    if (!saved) throw new Error("Missing saved approval");
    setPendingInteractionResolving(harness.db, {
      id: saved.id,
      resolution: JSON.stringify({
        decision: "allow_once",
        grantedPermissions: null,
      }),
    });
    harness.hub.unregisterDaemon(session.id);
    const wait = vi
      .spyOn(harness.hub, "waitForDaemonForHost")
      .mockImplementation(async () => {
        setControlPlaneProfileAccess(
          harness.db,
          alice.profile.profileId,
          alice.user.id,
          false,
        );
        return true;
      });
    const send = vi.spyOn(harness.hub, "requestHostOnlineRpc");
    try {
      await expect(
        callHostOnlineRpc(harness.deps, {
          hostId: host.id,
          timeoutMs: 1000,
          command: {
            type: "interactive.resolve",
            environmentId: alice.environment.id,
            threadId: alice.thread.id,
            interactionId: saved.id,
            providerId: "qwen-server",
            providerThreadId: "qwen-alice",
            providerRequestId: "approval-alice",
            resolution: { decision: "allow_once", grantedPermissions: null },
          },
        }),
      ).rejects.toMatchObject({
        status: 403,
        body: { code: "daemon_request_not_authorized" },
      });
      expect(wait).toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      wait.mockRestore();
      send.mockRestore();
    }
  });
});
