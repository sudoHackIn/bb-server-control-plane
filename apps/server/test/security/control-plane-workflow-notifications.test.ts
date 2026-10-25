import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  controlPlaneJobNotifications,
  controlPlaneJobBindings,
  createControlPlaneJobBinding,
  setControlPlaneProfileAccess,
  events,
} from "@bb/db";
import { withTestHarness } from "../helpers/test-app.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import {
  acceptControlPlaneWorkflowNotification,
  notifyControlPlaneWorkflowOrigin,
} from "../../src/control-plane/workflow-notifications.js";
import {
  withControlPlaneUser,
  withControlPlaneService,
} from "../../src/control-plane/access.js";
import { appendAndQueueSendThreadMessageInTransaction } from "../../src/services/threads/thread-send.js";
import { createClientTurnRequestId } from "../../src/services/threads/thread-events.js";

it("commits one durable acceptance with the canonical request and rolls it back when append fails", async () => {
  await withTestHarness(async (harness) => {
    const { alice } = seedControlPlaneJobSubjects(harness.db);
    const binding = createControlPlaneJobBinding(harness.db, {
      ...alice.input,
      userId: alice.user.id,
      profileVersionId: alice.profile.versionId,
    });
    function append(fail: boolean) {
      appendAndQueueSendThreadMessageInTransaction({
        db: harness.db,
        thread: alice.thread,
        environmentId: alice.environment.id,
        execution: {
          model: "qwen-test",
          reasoningLevel: "none",
          permissionMode: "full",
          serviceTier: "default",
          source: "client/turn/requested",
        },
        initiator: "user",
        input: [
          {
            type: "text",
            text: "Workflow finished",
            mentions: [],
            visibility: "agent-only",
          },
        ],
        requestId: createClientTurnRequestId(),
        senderThreadId: null,
        target: { kind: "thread-start" },
        beforeAppendInTransaction: ({ tx }) =>
          acceptControlPlaneWorkflowNotification(
            tx,
            binding.id,
            alice.thread.id,
          ),
        queueInTransaction: () => {
          if (fail) throw new Error("append interrupted");
          return { activeThread: null };
        },
      });
    }
    expect(() => append(true)).toThrow("append interrupted");
    expect(
      harness.db.select().from(controlPlaneJobNotifications).all(),
    ).toEqual([]);
    expect(
      harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, alice.thread.id))
        .all(),
    ).toEqual([]);
    append(false);
    expect(
      harness.db.select().from(controlPlaneJobNotifications).all(),
    ).toEqual([
      {
        bindingId: binding.id,
        threadId: alice.thread.id,
        acceptedAt: expect.any(Number),
      },
    ]);
    const count = harness.db
      .select()
      .from(events)
      .where(eq(events.threadId, alice.thread.id))
      .all().length;
    expect(() => append(false)).toThrow();
    expect(
      harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, alice.thread.id))
        .all(),
    ).toHaveLength(count);
    await expect(
      withControlPlaneService(() =>
        notifyControlPlaneWorkflowOrigin(
          harness.deps,
          binding.id,
          "Retry after lost acknowledgement",
        ),
      ),
    ).resolves.toBe("accepted");
    expect(
      harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, alice.thread.id))
        .all(),
    ).toHaveLength(count);
  });
});

it("does not accept notifications from another owner, a substituted origin or after revocation", async () => {
  await withTestHarness(async (harness) => {
    const { alice, bob } = seedControlPlaneJobSubjects(harness.db);
    const binding = createControlPlaneJobBinding(harness.db, {
      ...alice.input,
      userId: alice.user.id,
      profileVersionId: alice.profile.versionId,
    });
    await expect(
      withControlPlaneUser(bob.user.id, () =>
        notifyControlPlaneWorkflowOrigin(harness.deps, binding.id, "foreign"),
      ),
    ).resolves.toBe("denied");
    expect(() =>
      acceptControlPlaneWorkflowNotification(
        harness.db,
        binding.id,
        bob.thread.id,
      ),
    ).toThrow();
    setControlPlaneProfileAccess(
      harness.db,
      alice.profile.profileId,
      alice.user.id,
      false,
    );
    await expect(
      notifyControlPlaneWorkflowOrigin(harness.deps, binding.id, "revoked"),
    ).resolves.toBe("denied");
    expect(
      harness.db.select().from(controlPlaneJobNotifications).all(),
    ).toEqual([]);
    setControlPlaneProfileAccess(
      harness.db,
      alice.profile.profileId,
      alice.user.id,
      true,
    );
    harness.db
      .update(controlPlaneJobBindings)
      .set({ enabled: false })
      .where(eq(controlPlaneJobBindings.id, binding.id))
      .run();
    await expect(
      notifyControlPlaneWorkflowOrigin(harness.deps, binding.id, "disabled"),
    ).resolves.toBe("denied");
    expect(
      harness.db.select().from(controlPlaneJobNotifications).all(),
    ).toEqual([]);
  });
});
