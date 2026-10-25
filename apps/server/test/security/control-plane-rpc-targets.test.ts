import { expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  controlPlaneThreads,
  getStoredTurnRequestEventByRequestId,
  listEvents,
  environments,
  setControlPlaneProfileAccess,
  requireControlPlaneThreadDispatch,
} from "@bb/db";
import { threadScope } from "@bb/domain";
import {
  groupHostDaemonEvents,
  hostDaemonEventBatchResponseSchema,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { internalAuthHeaders } from "../helpers/commands.js";
import { parseStoredTurnRequestEvent } from "../../src/services/threads/stored-turn-request.js";
import type { HostDaemonRpcCommand } from "@bb/host-daemon-contract";
type Command<T extends HostDaemonRpcCommand["type"]> = Extract<
  HostDaemonRpcCommand,
  { type: T }
>;
import { assertControlPlaneRpcTarget } from "../../src/control-plane/rpc-target-authority.js";
import { controlPlaneThreadOwnerForCreate } from "../../src/control-plane/thread-authority.js";
import { withControlPlaneUser } from "../../src/control-plane/access.js";
import { callHostOnlineRpc } from "../../src/services/hosts/online-rpc.js";
import { appendClientTurnEventInTransaction } from "../../src/services/threads/thread-events.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { seedHostSession } from "../helpers/seed.js";
import { TRANSPORT_TEST_BRIDGE_LAUNCH } from "../helpers/provider-registry.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function fixture(harness: TestAppHarness) {
  const subjects = seedControlPlaneJobSubjects(harness.db);
  const { alice } = subjects;
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
      initiator: "user",
      input: [{ type: "text", text: "Own input", mentions: [] }],
      senderThreadId: null,
      source: "tell",
      target: { kind: "thread-start" },
      requestMethod: "thread/start",
    }),
  );
  const command: Command<"thread.start"> = {
    type: "thread.start",
    environmentId: alice.environment.id,
    threadId: alice.thread.id,
    projectId: alice.project.id,
    providerId: "qwen-server",
    bridgeLaunch: TRANSPORT_TEST_BRIDGE_LAUNCH,
    workspaceContext: { workspacePath: alice.environment.path! },
    instructions: "Own input",
    instructionMode: "append",
    injectedSkillSources: [],
    dynamicTools: [],
    contributedEnv: [],
    requestId,
    input: [{ type: "text", text: "Own input", mentions: [] }],
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
  };
  return { ...subjects, command };
}

it("binds both users' commands to the saved environment, host, project, provider and cwd", async () => {
  await withTestHarness(async (harness) => {
    const { alice, bob, command } = fixture(harness);
    const check = (input = command, hostId = alice.environment.hostId) =>
      assertControlPlaneRpcTarget(harness.db, hostId, input);
    expect(() => check()).not.toThrow();
    for (const invalid of [
      { ...command, environmentId: bob.environment.id },
      { ...command, projectId: bob.project.id },
      { ...command, providerId: "codex" },
      {
        ...command,
        workspaceContext: { workspacePath: bob.environment.path! },
      },
    ])
      expect(() => check(invalid)).toThrow("Command target is not authorized");
    expect(() => check(command, "foreign-host")).toThrow(
      "Command target is not authorized",
    );
    expect(() => check({ ...command, threadId: "unknown-thread" })).toThrow();
    expect(() =>
      check({
        ...command,
        threadId: bob.thread.id,
        environmentId: bob.environment.id,
        projectId: bob.project.id,
        workspaceContext: { workspacePath: bob.environment.path! },
      }),
    ).not.toThrow();
  });
});

it("binds idle continuation to the saved native session and complete nested runtime target", async () => {
  await withTestHarness(async (harness) => {
    const { alice, bob, command } = fixture(harness);
    harness.db
      .update(controlPlaneThreads)
      .set({ qwenSessionId: "qwen-alice" })
      .where(eq(controlPlaneThreads.threadId, alice.thread.id))
      .run();
    const {
      type: _type,
      environmentId,
      threadId,
      requestId,
      input,
      options,
      ...context
    } = command;
    const submit: Command<"turn.submit"> = {
      type: "turn.submit",
      environmentId,
      threadId,
      requestId,
      input,
      options,
      bridgeLaunch: command.bridgeLaunch,
      resumeContext: { ...context, providerThreadId: "qwen-alice" },
      target: { mode: "start" },
    };
    const check = (value = submit) =>
      assertControlPlaneRpcTarget(harness.db, alice.environment.hostId, value);
    expect(() => check()).not.toThrow();
    for (const resumeContext of [
      { ...submit.resumeContext, providerThreadId: "qwen-bob" },
      { ...submit.resumeContext, projectId: bob.project.id },
      { ...submit.resumeContext, providerId: "codex" },
      {
        ...submit.resumeContext,
        workspaceContext: { workspacePath: bob.environment.path! },
      },
    ])
      expect(() => check({ ...submit, resumeContext })).toThrow(
        "Command target is not authorized",
      );
  });
});

it("keeps cleanup available after revocation but cannot redirect cleanup to another owner's environment", async () => {
  await withTestHarness(async (harness) => {
    const { alice, bob } = fixture(harness);
    setControlPlaneProfileAccess(
      harness.db,
      alice.profile.profileId,
      alice.user.id,
      false,
    );
    const command: Command<"thread.stop"> = {
      type: "thread.stop",
      threadId: alice.thread.id,
      environmentId: alice.environment.id,
      intent: "release",
    };
    expect(() =>
      assertControlPlaneRpcTarget(
        harness.db,
        alice.environment.hostId,
        command,
      ),
    ).not.toThrow();
    harness.db
      .update(environments)
      .set({ path: null, status: "destroyed", providerOwnsPath: true })
      .where(eq(environments.id, alice.environment.id))
      .run();
    expect(() =>
      assertControlPlaneRpcTarget(
        harness.db,
        alice.environment.hostId,
        command,
      ),
    ).not.toThrow();
    expect(() =>
      assertControlPlaneRpcTarget(harness.db, alice.environment.hostId, {
        ...command,
        environmentId: bob.environment.id,
      }),
    ).toThrow();
  });
});

it("refuses provider-owned environment reuse before thread creation and before dispatch", async () => {
  await withTestHarness(async (harness) => {
    const { alice } = fixture(harness);
    const create = () =>
      withControlPlaneUser(alice.user.id, () =>
        controlPlaneThreadOwnerForCreate(harness.db, {
          projectId: alice.project.id,
          providerId: "qwen-server",
          controlPlaneProfileVersionId: alice.profile.versionId,
          environment: { type: "reuse", environmentId: alice.environment.id },
        }),
      );
    harness.db
      .update(environments)
      .set({
        environmentProviderId: "project-checkout",
        environmentProviderPluginId: "environment-project-checkout",
        providerOwnsPath: false,
      })
      .where(eq(environments.id, alice.environment.id))
      .run();
    expect(create()).toBe(alice.user.id);
    harness.db
      .update(environments)
      .set({ providerOwnsPath: true })
      .where(eq(environments.id, alice.environment.id))
      .run();
    expect(create).toThrow();
    expect(() =>
      requireControlPlaneThreadDispatch(harness.db, alice.thread.id),
    ).toThrow();
  });
});

it("checks environment attachment against the registry and refuses service-account setup scripts", async () => {
  await withTestHarness(async (harness) => {
    const { alice, bob } = fixture(harness);
    const command: Command<"environment.attach"> = {
      type: "environment.attach",
      environmentId: alice.environment.id,
      path: alice.environment.path!,
      setupScriptTimeoutMs: null,
      contributedEnv: [],
      initiator: null,
    };
    const check = (value = command) =>
      assertControlPlaneRpcTarget(harness.db, alice.environment.hostId, value);
    expect(() => check()).not.toThrow();
    expect(() => check({ ...command, path: bob.environment.path! })).toThrow();
    expect(() => check({ ...command, setupScriptTimeoutMs: 1000 })).toThrow();
    expect(() =>
      check({
        ...command,
        initiator: { threadId: bob.thread.id, provisioningId: "foreign" },
      }),
    ).toThrow();
  });
});

it.each(["setup", "teardown"] as const)(
  "never runs a %s script under the service identity in any registered HOME",
  async (kind) => {
    await withTestHarness(async (harness) => {
      const { alice, bob } = fixture(harness);
      for (const path of [
        alice.user.home,
        `${alice.user.home}/project`,
        `${bob.user.home}/project`,
        `${alice.user.home}/../${alice.user.home.split("/").at(-1)}/project`,
      ])
        expect(() =>
          assertControlPlaneRpcTarget(harness.db, alice.environment.hostId, {
            type: "environment.hook.run",
            operationId: "hook",
            path,
            kind,
            timeoutMs: 1000,
            contributedEnv: [],
            resumeOnly: false,
          }),
        ).toThrow("Command target is not authorized");
      expect(() =>
        assertControlPlaneRpcTarget(harness.db, alice.environment.hostId, {
          type: "environment.hook.run",
          operationId: "hook",
          path: `${alice.user.home}-other`,
          kind,
          timeoutMs: 1000,
          contributedEnv: [],
          resumeOnly: false,
        }),
      ).not.toThrow();
    });
  },
);

it("rechecks target assignment after reconnect before actual transport", async () => {
  await withTestHarness(async (harness) => {
    const { alice, bob, command } = fixture(harness);
    const { session } = seedHostSession(harness.deps, {
      id: alice.environment.hostId,
    });
    const foreign = seedHostSession(harness.deps, {
      id: "foreign-rpc-target-host",
    });
    harness.hub.unregisterDaemon(session.id);
    const wait = vi
      .spyOn(harness.hub, "waitForDaemonForHost")
      .mockImplementation(async () => {
        harness.db
          .update(environments)
          .set({ hostId: foreign.host.id })
          .where(eq(environments.id, alice.environment.id))
          .run();
        return true;
      });
    const transport = vi.spyOn(harness.hub, "requestHostOnlineRpc");
    try {
      await expect(
        callHostOnlineRpc(harness.deps, {
          hostId: alice.environment.hostId,
          timeoutMs: 1000,
          command: { ...command, environmentId: bob.environment.id },
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(wait).not.toHaveBeenCalled();
      await expect(
        callHostOnlineRpc(harness.deps, {
          hostId: alice.environment.hostId,
          timeoutMs: 1000,
          command,
        }),
      ).rejects.toMatchObject({
        status: 403,
        body: { code: "rpc_target_not_authorized" },
      });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      wait.mockRestore();
      transport.mockRestore();
    }
  });
});

it("cannot replace a canonical request or append server operations through a managed daemon event batch", async () => {
  await withTestHarness(async (harness) => {
    const { alice, command } = fixture(harness);
    const { session, host } = seedHostSession(harness.deps, {
      id: alice.environment.hostId,
    });
    const row = getStoredTurnRequestEventByRequestId(
      harness.db,
      alice.thread.id,
      command.requestId,
    )!;
    const saved = parseStoredTurnRequestEvent(row);
    const base = { threadId: alice.thread.id, scope: threadScope() };
    const eventValues: HostDaemonEventEnvelope["event"][] = [
      {
        ...saved,
        ...base,
        type: "client/turn/requested",
        input: [{ type: "text", text: "Forged user input", mentions: [] }],
      },
      { ...saved, ...base, type: "client/thread/start" },
      { ...saved, ...base, type: "client/turn/start" },
      {
        ...base,
        type: "client/turn/rejected",
        requestId: command.requestId,
        reason: "forged",
        message: "Forged rejection",
      },
      {
        ...base,
        type: "system/manager/user_message",
        text: "Forged system input",
      },
      {
        ...base,
        type: "system/operation",
        operation: "environment-directory-updated",
        operationId: "forged",
        status: "completed",
        message: "Forged operation",
      },
      {
        ...base,
        type: "system/thread-provisioning",
        provisioningId: "forged",
        environmentId: alice.environment.id,
        status: "completed",
        entries: [],
      },
      {
        ...base,
        type: "system/error",
        message: "Provider status remains supported",
      },
    ];
    const response = await harness.app.request("/internal/session/events", {
      method: "POST",
      headers: internalAuthHeaders(harness, { hostId: host.id }),
      body: JSON.stringify({
        sessionId: session.id,
        eventGroups: groupHostDaemonEvents(
          eventValues.map((event) => ({ threadId: alice.thread.id, event })),
        ),
      }),
    });
    expect(response.status).toBe(200);
    const result = hostDaemonEventBatchResponseSchema.parse(
      await response.json(),
    );
    expect(result.acceptedEvents.map((event) => event.eventIndex)).toEqual([7]);
    expect(result.rejectedEvents).toEqual([]);
    const stored = listEvents(harness.db, { threadId: alice.thread.id });
    expect(stored).toHaveLength(2);
    expect(stored[0]?.data).toBe(row.data);
    expect(stored[1]?.type).toBe("system/error");
  });
});
