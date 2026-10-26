import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  acknowledgeControlPlaneProjectAccessPolicy,
  checkpointControlPlaneUidMaintenance,
  createControlPlaneJobBinding,
  getControlPlaneProjectAccessPolicy,
  getQueuedThreadMessage,
  listEvents,
  requireControlPlaneJobDispatch,
  requireControlPlaneThreadDispatch,
  reserveControlPlaneUidMaintenance,
  setControlPlaneProfileAccess,
  setQueuedThreadMessageFailureReason,
  threads,
  ControlPlaneThreadError,
} from "@bb/db";
import { isControlPlaneMaintenanceError } from "../../src/control-plane/maintenance-errors.js";
import { recordQueuedMessageDrainFailure } from "../../src/services/threads/queue-drain-failure.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import {
  sendNextQueuedMessageIfPresent,
  sendQueuedMessageNow,
} from "../../src/services/threads/queued-messages.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { seedQueuedMessage } from "../helpers/seed.js";
import { textInput } from "../helpers/prompt-input.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function fixture(h: TestAppHarness) {
  const { alice, bob } = seedControlPlaneJobSubjects(h.db);
  h.db
    .update(threads)
    .set({ status: "idle" })
    .where(eq(threads.id, alice.thread.id))
    .run();
  const row = seedQueuedMessage(h.deps, {
    threadId: alice.thread.id,
    content: textInput("Keep through maintenance"),
    model: "qwen-test",
    reasoningLevel: "none",
    senderThreadId: alice.thread.id,
  });
  const begin = () =>
    reserveControlPlaneUidMaintenance(h.db, {
      userId: alice.user.id,
      projectId: alice.project.id,
      operationId: randomUUID(),
      rootGeneration: 0,
    });
  return { alice, bob, row, begin };
}
function maintenanceError(h: TestAppHarness, threadId: string) {
  try {
    requireControlPlaneThreadDispatch(h.db, threadId);
  } catch (error) {
    if (error instanceof ControlPlaneThreadError) return error;
    throw error;
  }
  throw new Error("Expected blocked dispatch");
}

it("preserves repeated automatic and explicit queue sends without events, claims or retry consumption", async () => {
  await withTestHarness(async (h) => {
    const { alice, bob, row, begin } = fixture(h);
    begin();
    const before = listEvents(h.db, { threadId: alice.thread.id });
    for (let i = 0; i < 4; i++) {
      expect(
        await sendNextQueuedMessageIfPresent(h.deps, {
          threadId: alice.thread.id,
        }),
      ).toBe(false);
      expect(
        await sendQueuedMessageNow(h.deps, {
          threadId: alice.thread.id,
          queuedMessageId: row.id,
          mode: "auto",
        }),
      ).toMatchObject({ delivery: "queued", queuedMessage: { id: row.id } });
    }
    expect(getQueuedThreadMessage(h.db, row.id)).toMatchObject({
      content: row.content,
      senderThreadId: row.senderThreadId,
      state: row.state,
      failureCount: 0,
      failureReason: null,
      nextAttemptAt: null,
      claimToken: null,
      claimedAt: null,
    });
    expect(listEvents(h.db, { threadId: alice.thread.id })).toEqual(before);
    expect(
      requireControlPlaneThreadDispatch(h.db, bob.thread.id)?.user.id,
    ).toBe(bob.user.id);
  });
});
it("keeps a previously failed retry's budget and deadline through scheduled retry sweeps", async () => {
  await withTestHarness(async (h) => {
    const { alice, row, begin } = fixture(h);
    setQueuedThreadMessageFailureReason(h.db, h.hub, {
      id: row.id,
      threadId: alice.thread.id,
      failureReason: "Earlier host failure",
      now: 1,
      retryDelaysMs: [10],
    });
    const before = getQueuedThreadMessage(h.db, row.id);
    begin();
    for (let i = 0; i < 4; i++)
      await runQueuedMessageDispatch(h.deps, {
        kind: "failed-retry",
        now: Date.now(),
      });
    expect(getQueuedThreadMessage(h.db, row.id)).toMatchObject({
      state: before?.state,
      failureCount: before?.failureCount,
      failureReason: before?.failureReason,
      nextAttemptAt: before?.nextAttemptAt,
      content: row.content,
      claimToken: null,
    });
  });
});
it("does not record a captured maintenance refusal even when the UID is released before failure handling", async () => {
  await withTestHarness(async (h) => {
    const { alice, row, begin } = fixture(h);
    const intent = begin();
    const error = maintenanceError(h, alice.thread.id);
    expect(isControlPlaneMaintenanceError(error)).toBe(true);
    const policy = getControlPlaneProjectAccessPolicy(h.db, alice.project.id);
    if (!policy) throw new Error("Missing policy");
    expect(
      checkpointControlPlaneUidMaintenance(
        h.db,
        alice.user.id,
        intent.operationId,
        intent.generation,
        "blocked",
      ),
    ).toBe(true);
    acknowledgeControlPlaneProjectAccessPolicy(
      h.db,
      alice.project.id,
      policy.revision,
    );
    for (const phase of ["releasing", "idle"] as const)
      expect(
        checkpointControlPlaneUidMaintenance(
          h.db,
          alice.user.id,
          intent.operationId,
          intent.generation,
          phase,
        ),
      ).toBe(true);
    recordQueuedMessageDrainFailure(h.deps, {
      error,
      now: Date.now(),
      row,
      thread: alice.thread,
    });
    expect(getQueuedThreadMessage(h.db, row.id)?.failureCount).toBe(0);
    expect(
      requireControlPlaneThreadDispatch(h.db, alice.thread.id)
        ?.maintenanceGeneration,
    ).toBe(intent.generation);
  });
});
it("keeps revoked profile authority a permanent denial while maintenance is active", async () => {
  await withTestHarness(async (h) => {
    const { alice, begin } = fixture(h);
    begin();
    setControlPlaneProfileAccess(
      h.db,
      alice.profile.profileId,
      alice.user.id,
      false,
    );
    const error = maintenanceError(h, alice.thread.id);
    expect(error.reason).toBe("unauthorized");
    expect(isControlPlaneMaintenanceError(error)).toBe(false);
  });
});
it("preserves maintenance classification across background job authority without changing ordinary denials", async () => {
  await withTestHarness(async (h) => {
    const { alice, begin } = fixture(h);
    const binding = createControlPlaneJobBinding(h.db, {
      ...alice.input,
      userId: alice.user.id,
      profileVersionId: alice.profile.versionId,
    });
    begin();
    let captured = false;
    try {
      requireControlPlaneJobDispatch(h.db, binding.id);
    } catch (error) {
      captured = true;
      expect(isControlPlaneMaintenanceError(error)).toBe(true);
    }
    expect(captured).toBe(true);
    expect(isControlPlaneMaintenanceError(new Error("maintenance"))).toBe(
      false,
    );
  });
});
