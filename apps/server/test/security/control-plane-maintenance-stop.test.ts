import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  checkpointControlPlaneUidMaintenance,
  getControlPlaneUidMaintenance,
  getThread,
  isThreadQueueAutoSendPaused,
  listEvents,
  reserveControlPlaneUidMaintenance,
  threads,
} from "@bb/db";
import {
  stopThreadForMaintenance,
  requestThreadStopForCurrentState,
  reconcileDaemonReportedThreads,
  hasLiveThreadStopInFlight,
} from "../../src/services/threads/thread-lifecycle.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { seedHostSession, seedTurnStarted } from "../helpers/seed.js";
import {
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
  listQueuedThreadCommands,
} from "../helpers/commands.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
function fixture(
  h: TestAppHarness,
  status: "idle" | "active" | "starting" = "idle",
) {
  const { alice, bob } = seedControlPlaneJobSubjects(h.db);
  seedHostSession(h.deps, { id: alice.environment.hostId });
  h.db
    .update(threads)
    .set({ status })
    .where(eq(threads.id, alice.thread.id))
    .run();
  if (status === "active")
    seedTurnStarted(h.deps, {
      threadId: alice.thread.id,
      environmentId: alice.environment.id,
      providerThreadId: "qwen-maintenance",
      turnId: "maintenance-turn",
    });
  const intent = reserveControlPlaneUidMaintenance(h.db, {
    userId: alice.user.id,
    projectId: alice.project.id,
    operationId: randomUUID(),
    rootGeneration: 0,
  });
  expect(
    checkpointControlPlaneUidMaintenance(
      h.db,
      alice.user.id,
      intent.operationId,
      intent.generation,
      "blocked",
    ),
  ).toBe(true);
  const stop = () =>
    stopThreadForMaintenance(h.deps, alice.thread, alice.environment, {
      userId: alice.user.id,
      operationId: intent.operationId,
      generation: intent.generation,
    });
  return { alice, bob, intent, stop };
}
it.each(["idle", "starting"] as const)(
  "awaits release acknowledgement for a %s thread",
  async (status) => {
    await withTestHarness(async (h) => {
      const { alice, stop } = fixture(h, status);
      let settled = false;
      const task = stop().then(() => {
        settled = true;
      });
      const release = await waitForQueuedCommand(
        h,
        ({ command }) =>
          command.type === "thread.stop" &&
          command.threadId === alice.thread.id &&
          command.intent === "release",
      );
      expect(settled).toBe(false);
      await reportQueuedCommandSuccess(h, release, {
        providerCheckpointId: null,
      });
      await task;
      expect(isThreadQueueAutoSendPaused(h.db, alice.thread.id)).toBe(false);
      expect(getThread(h.db, alice.thread.id)?.status).toBe("idle");
    });
  },
);
it("interrupts then releases active native work without creating a manual pause", async () => {
  await withTestHarness(async (h) => {
    const { alice, stop } = fixture(h, "active");
    let settled = false;
    const task = stop().then(() => {
      settled = true;
    });
    const interrupt = await waitForQueuedCommand(
      h,
      ({ command }) =>
        command.type === "thread.stop" &&
        command.threadId === alice.thread.id &&
        command.intent === "interrupt",
    );
    expect(
      listEvents(h.db, { threadId: alice.thread.id })
        .filter((e) => e.type === "system/thread/interrupted")
        .map((e) => JSON.parse(e.data).reason),
    ).toEqual(["access-maintenance"]);
    await reportQueuedCommandSuccess(h, interrupt, {
      providerCheckpointId: null,
    });
    const release = await waitForQueuedCommand(
      h,
      ({ command }) =>
        command.type === "thread.stop" &&
        command.threadId === alice.thread.id &&
        command.intent === "release",
    );
    expect(settled).toBe(false);
    await reportQueuedCommandSuccess(h, release, {
      providerCheckpointId: null,
    });
    await task;
    expect(isThreadQueueAutoSendPaused(h.db, alice.thread.id)).toBe(false);
  });
});
it("retains UID blocking when a release is unconfirmed", async () => {
  await withTestHarness(async (h) => {
    const { alice, stop } = fixture(h);
    const task = stop();
    const rejected = expect(task).rejects.toBeDefined();
    const release = await waitForQueuedCommand(
      h,
      ({ command }) =>
        command.type === "thread.stop" &&
        command.threadId === alice.thread.id &&
        command.intent === "release",
    );
    await reportQueuedCommandError(h, release, {
      errorCode: "command_timeout",
      errorMessage: "Unconfirmed stop",
    });
    await rejected;
    expect(getControlPlaneUidMaintenance(h.db, alice.user.id)?.phase).toBe(
      "blocked",
    );
  });
});
it("rejects cross-owner maintenance before issuing commands", async () => {
  await withTestHarness(async (h) => {
    const { alice, bob, intent } = fixture(h);
    await expect(
      stopThreadForMaintenance(h.deps, bob.thread, bob.environment, {
        userId: alice.user.id,
        operationId: intent.operationId,
        generation: intent.generation,
      }),
    ).rejects.toThrow("ownership changed");
    expect(listQueuedThreadCommands(h, "thread.stop", bob.thread.id)).toEqual(
      [],
    );
  });
});
it("refuses to release a thread after maintenance is rebased during its interrupt", async () => {
  await withTestHarness(async (h) => {
    const { alice, intent, stop } = fixture(h, "active");
    const task = stop();
    const rejected = expect(task).rejects.toThrow("ownership changed");
    const interrupt = await waitForQueuedCommand(
      h,
      ({ command }) =>
        command.type === "thread.stop" &&
        command.threadId === alice.thread.id &&
        command.intent === "interrupt",
    );
    const next = reserveControlPlaneUidMaintenance(h.db, {
      userId: alice.user.id,
      projectId: alice.project.id,
      operationId: intent.operationId,
      rootGeneration: intent.generation,
      restartGeneration: intent.generation,
    });
    await reportQueuedCommandSuccess(h, interrupt, {
      providerCheckpointId: null,
    });
    await rejected;
    expect(getControlPlaneUidMaintenance(h.db, alice.user.id)?.generation).toBe(
      next.generation,
    );
    expect(
      listQueuedThreadCommands(h, "thread.stop", alice.thread.id).filter(
        (entry) => entry.type === "thread.stop" && entry.intent === "release",
      ),
    ).toHaveLength(0);
  });
});

it("retains a user stop requested while maintenance is already stopping the thread", async () => {
  await withTestHarness(async (h) => {
    const { alice, stop } = fixture(h, "active");
    const task = stop();
    const interrupt = await waitForQueuedCommand(
      h,
      ({ command }) =>
        command.type === "thread.stop" &&
        command.threadId === alice.thread.id &&
        command.intent === "interrupt",
    );
    const stopping = getThread(h.db, alice.thread.id);
    if (!stopping) throw new Error("Missing thread");
    requestThreadStopForCurrentState(h.deps, stopping, alice.environment);
    expect(isThreadQueueAutoSendPaused(h.db, alice.thread.id)).toBe(true);
    await reportQueuedCommandSuccess(h, interrupt, {
      providerCheckpointId: null,
    });
    const release = await waitForQueuedCommand(
      h,
      ({ command }) =>
        command.type === "thread.stop" &&
        command.threadId === alice.thread.id &&
        command.intent === "release",
    );
    await reportQueuedCommandSuccess(h, release, {
      providerCheckpointId: null,
    });
    await task;
    expect(isThreadQueueAutoSendPaused(h.db, alice.thread.id)).toBe(true);
  });
});

it("does not revive a maintenance-interrupted thread on a late daemon active report", async () => {
  await withTestHarness(async (h) => {
    const { alice, stop } = fixture(h, "active");
    const task = stop();
    const interrupt = await waitForQueuedCommand(
      h,
      ({ command }) =>
        command.type === "thread.stop" &&
        command.threadId === alice.thread.id &&
        command.intent === "interrupt",
    );
    await reportQueuedCommandSuccess(h, interrupt, {
      providerCheckpointId: null,
    });
    const release = await waitForQueuedCommand(
      h,
      ({ command }) =>
        command.type === "thread.stop" &&
        command.threadId === alice.thread.id &&
        command.intent === "release",
    );
    await reportQueuedCommandSuccess(h, release, {
      providerCheckpointId: null,
    });
    await task;
    await reconcileDaemonReportedThreads(h.deps, {
      hostId: alice.environment.hostId,
      activeThreadIds: [alice.thread.id],
      undeliveredEventThreadIds: [],
      sameDaemonInstance: true,
    });
    expect(getThread(h.db, alice.thread.id)?.status).toBe("idle");
    expect(isThreadQueueAutoSendPaused(h.db, alice.thread.id)).toBe(false);
    const lateStop = await waitForQueuedCommandAfter(
      h,
      release.row.cursor,
      ({ command }) =>
        command.type === "thread.stop" &&
        command.threadId === alice.thread.id &&
        command.intent === "interrupt",
    );
    await reportQueuedCommandSuccess(h, lateStop, {
      providerCheckpointId: null,
    });
    await expect
      .poll(() => hasLiveThreadStopInFlight(alice.thread.id))
      .toBe(false);
  });
});
