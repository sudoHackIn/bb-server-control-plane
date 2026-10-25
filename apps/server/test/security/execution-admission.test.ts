import { createBbSdk } from "@bb/sdk/core";
import { createHttpTransport } from "@bb/sdk/node";
import { getQueuedThreadMessage, listEvents, threads } from "@bb/db";
import { expect, it } from "vitest";
import { stopExecutionAdmission } from "../../src/services/system/execution-admission.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { queueParentSystemMessage } from "../../src/services/threads/parent-system-messages.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";

it("closes core HTTP/SDK create, send, queue and dispatch without a policy plugin while leaving reads and stop available", async () => {
  await withTestHarness(async (harness) => {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      path: "/tmp/execution-admission",
    });
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
    });
    const queued = seedQueuedMessage(harness.deps, {
      threadId: thread.id,
      content: textInput("Keep for restart"),
      waitingOn: { kind: "thread-busy" },
    });
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://localhost",
        runtime: "node",
        fetch: async (input, init) =>
          harness.app.fetch(new Request(input, init)),
      }),
    });
    const events = listEvents(harness.db, { threadId: thread.id });
    const count = harness.db.select().from(threads).all().length;
    const initialQueue = getQueuedThreadMessage(harness.db, queued.id);
    stopExecutionAdmission(harness.db);
    const rejected = {
      status: 503,
      body: { code: "server_stopping", retryable: true },
    };
    await expect(
      sdk.threads.spawn({
        projectId: project.id,
        environment: { type: "reuse", environmentId: environment.id },
        providerId: "codex",
        prompt: "Must not create",
      }),
    ).rejects.toMatchObject(rejected);
    await expect(
      sdk.threads.send({
        threadId: thread.id,
        input: textInput("Must not send"),
        mode: "start",
      }),
    ).rejects.toMatchObject(rejected);
    await expect(
      sdk.threads.queuedMessages.create({
        threadId: thread.id,
        input: textInput("Must not queue"),
      }),
    ).rejects.toMatchObject(rejected);
    await expect(
      sdk.threads.queuedMessages.send({
        threadId: thread.id,
        queuedMessageId: queued.id,
        mode: "auto",
      }),
    ).rejects.toMatchObject(rejected);
    await expect(
      queueParentSystemMessage(harness.deps, {
        parentThreadId: thread.id,
        input: textInput("Must not restart a parent during cleanup"),
        systemMessageKind: "child-completed",
        systemMessageSubject: null,
      }),
    ).rejects.toMatchObject(rejected);
    for (const wake of [
      { kind: "thread-ready", threadId: thread.id },
      { kind: "idle-recovery", now: Date.now() },
      { kind: "time-reached", now: Date.now() },
      { kind: "failed-retry", now: Date.now() },
    ] as const)
      await runQueuedMessageDispatch(harness.deps, wake);
    expect(getQueuedThreadMessage(harness.db, queued.id)).toEqual(initialQueue);
    expect(listEvents(harness.db, { threadId: thread.id })).toEqual(events);
    expect(harness.db.select().from(threads).all()).toHaveLength(count);
    await expect(
      sdk.threads.get({ threadId: thread.id }),
    ).resolves.toMatchObject({ id: thread.id });
    const stopped = sdk.threads.stop({ threadId: thread.id });
    const command = await waitForQueuedCommand(
      harness,
      ({ command }) =>
        command.type === "thread.stop" && command.threadId === thread.id,
    );
    await reportQueuedCommandSuccess(harness, command, {
      providerCheckpointId: null,
    });
    await expect(stopped).resolves.toEqual({
      ok: true,
    });
  });
});

it("preserves a claimed queue row without spending retry budget when shutdown wins asynchronous command preparation", async () => {
  await withTestHarness(async (harness) => {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      path: "/tmp/execution-admission-race",
    });
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
    });
    seedThreadRuntimeState(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "existing-session",
    });
    const row = seedQueuedMessage(harness.deps, {
      threadId: thread.id,
      content: textInput("Keep after async preparation"),
      waitingOn: { kind: "thread-busy" },
    });
    const events = listEvents(harness.db, { threadId: thread.id });
    const initial = getQueuedThreadMessage(harness.db, row.id);
    const pending = runQueuedMessageDispatch(harness.deps, {
      kind: "thread-ready",
      threadId: thread.id,
    });
    expect(getQueuedThreadMessage(harness.db, row.id)?.state).toBe("claimed");
    stopExecutionAdmission(harness.db);
    await pending;
    const retained = getQueuedThreadMessage(harness.db, row.id);
    expect(retained).toMatchObject({
      state: initial?.state,
      failureCount: initial?.failureCount,
      failureReason: initial?.failureReason,
      content: initial?.content,
    });
    expect(listEvents(harness.db, { threadId: thread.id })).toEqual(events);
  });
});

it("does not create a thread when shutdown starts after service entry during asynchronous request preparation", async () => {
  await withTestHarness(async (harness) => {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      path: "/tmp/execution-admission-create",
    });
    const before = harness.db.select().from(threads).all();
    const pending = createThreadFromRequest(harness.deps, {
      projectId: project.id,
      environment: { type: "reuse", environmentId: environment.id },
      providerId: "codex",
      model: "gpt-5.4",
      input: textInput("Must not create after preparation"),
      origin: "app",
      startedOnBehalfOf: null,
    });
    stopExecutionAdmission(harness.db);
    await expect(pending).rejects.toMatchObject({
      status: 503,
      body: { code: "server_stopping" },
    });
    expect(harness.db.select().from(threads).all()).toEqual(before);
  });
});
