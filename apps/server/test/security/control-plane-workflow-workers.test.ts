import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import {
  createControlPlaneJobBinding,
  createThread,
  getThread,
  controlPlaneJobBindings,
  controlPlaneUsers,
  threads,
  setControlPlaneProfileAccess,
} from "@bb/db";
import { withTestHarness } from "../helpers/test-app.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { createControlPlaneWorkflowWorkers } from "../../src/control-plane/workflow-workers.js";
import { createControlPlaneBackgroundJobs } from "../../src/control-plane/background-jobs.js";
import { withControlPlaneUser } from "../../src/control-plane/access.js";

it("scopes worker metadata and actions to the owning parent and denies unapproved creation before native dispatch", async () => {
  await withTestHarness(async (harness) => {
    const { alice, bob } = seedControlPlaneJobSubjects(harness.db);
    const workers = createControlPlaneWorkflowWorkers(harness.deps);
    const jobs = createControlPlaneBackgroundJobs(
      harness.db,
      "workflows",
      true,
      workers,
    );
    try {
      const a = await withControlPlaneUser(alice.user.id, () =>
        jobs.bind(alice.input),
      );
      const b = await withControlPlaneUser(bob.user.id, () =>
        jobs.bind(bob.input),
      );
      const binding = createControlPlaneJobBinding(harness.db, {
        ...alice.input,
        userId: alice.user.id,
        profileVersionId: alice.profile.versionId,
        kind: "workflow-worker",
        objectId: randomUUID(),
        sourceBindingId: a.id,
      });
      const child = createThread(harness.db, harness.hub, {
        projectId: alice.project.id,
        environmentId: alice.environment.id,
        providerId: "qwen-server",
        status: "idle",
        originPluginId: "workflows",
        controlPlaneOwnerUserId: alice.user.id,
        controlPlaneProfileVersionId: alice.profile.versionId,
        controlPlaneJobBindingId: binding.id,
      });
      expect(
        await withControlPlaneUser(alice.user.id, () =>
          jobs.getWorker(a.id, child.id),
        ),
      ).toEqual({ threadId: child.id, status: "idle", output: null });
      await expect(
        withControlPlaneUser(bob.user.id, async () =>
          jobs.getWorker(a.id, child.id),
        ),
      ).rejects.toThrow("not authorized");
      await expect(
        withControlPlaneUser(bob.user.id, async () =>
          jobs.getWorker(b.id, child.id),
        ),
      ).rejects.toThrow("not authorized");
      await expect(
        withControlPlaneUser(bob.user.id, async () =>
          jobs.stopWorker(b.id, child.id),
        ),
      ).rejects.toThrow("not authorized");
      const aborted = new AbortController();
      aborted.abort();
      await expect(
        withControlPlaneUser(alice.user.id, () =>
          jobs.startWorker(
            a.id,
            {
              callId: "cancelled",
              prompt: "Must not create",
              title: null,
              profileVersionId: null,
            },
            aborted.signal,
          ),
        ),
      ).rejects.toThrow("cancelled before");
      const before = harness.db
        .select()
        .from(controlPlaneJobBindings)
        .all().length;
      await expect(
        withControlPlaneUser(alice.user.id, () =>
          jobs.startWorker(a.id, {
            callId: "test",
            prompt: "Work",
            title: null,
            profileVersionId: bob.profile.versionId,
          }),
        ),
      ).rejects.toThrow();
      await expect(
        withControlPlaneUser(alice.user.id, () =>
          jobs.startWorker(a.id, {
            callId: "test",
            prompt: "Work",
            title: null,
            profileVersionId: null,
            ...{ uid: bob.user.uid },
          }),
        ),
      ).rejects.toThrow();
      expect(
        harness.db.select().from(controlPlaneJobBindings).all().length,
      ).toBe(before);
      await withControlPlaneUser(alice.user.id, () =>
        jobs.setEnabled(a.id, false),
      );
      await expect(
        withControlPlaneUser(alice.user.id, () =>
          jobs.sendWorker(a.id, child.id, "Must not execute"),
        ),
      ).rejects.toThrow("not authorized");
      setControlPlaneProfileAccess(
        harness.db,
        alice.profile.profileId,
        alice.user.id,
        false,
      );
      expect(
        await withControlPlaneUser(alice.user.id, () =>
          jobs.getWorker(a.id, child.id),
        ),
      ).toMatchObject({ threadId: child.id });
      await withControlPlaneUser(alice.user.id, () =>
        jobs.stopWorker(a.id, child.id),
      );
      expect(
        harness.db
          .select()
          .from(controlPlaneJobBindings)
          .where(eq(controlPlaneJobBindings.id, binding.id))
          .get()?.enabled,
      ).toBe(false);
      harness.db
        .update(controlPlaneUsers)
        .set({ enabled: false })
        .where(eq(controlPlaneUsers.id, alice.user.id))
        .run();
      expect(await jobs.getWorker(a.id, child.id)).toMatchObject({
        threadId: child.id,
      });
      await jobs.stopWorker(a.id, child.id);
      await jobs.archiveWorker(a.id, child.id);
      expect(getThread(harness.db, child.id)?.archivedAt).not.toBeNull();
      await expect(
        jobs.sendWorker(a.id, child.id, "Must not execute for a disabled user"),
      ).rejects.toThrow("not authorized");
      expect(
        harness.db
          .select()
          .from(controlPlaneJobBindings)
          .where(eq(controlPlaneJobBindings.id, a.id))
          .get()?.enabled,
      ).toBe(false);
    } finally {
      await workers.close();
    }
  });
});

it("fences a worker reservation when cancellation arrives during native creation", async () => {
  await withTestHarness(async (harness) => {
    const { alice } = seedControlPlaneJobSubjects(harness.db);
    const workers = createControlPlaneWorkflowWorkers(harness.deps);
    const jobs = createControlPlaneBackgroundJobs(
      harness.db,
      "workflows",
      true,
      workers,
    );
    let release = () => {};
    const registrations = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waitForRegistrations = vi
      .spyOn(harness.deps.providerRegistry, "whenRegistrationsSettled")
      .mockReturnValue(registrations);
    const controller = new AbortController();
    try {
      const parent = await withControlPlaneUser(alice.user.id, () =>
        jobs.bind(alice.input),
      );
      const before = harness.db.select().from(threads).all().length;
      const pending = withControlPlaneUser(alice.user.id, () =>
        jobs.startWorker(
          parent.id,
          {
            callId: "race",
            prompt: "Must not launch",
            title: null,
            profileVersionId: null,
          },
          controller.signal,
        ),
      );
      const outcome = pending.then(
        () => null,
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(waitForRegistrations).toHaveBeenCalled());
      const binding = harness.db
        .select()
        .from(controlPlaneJobBindings)
        .where(eq(controlPlaneJobBindings.sourceBindingId, parent.id))
        .get();
      expect(binding?.enabled).toBe(true);
      controller.abort();
      expect(
        harness.db
          .select()
          .from(controlPlaneJobBindings)
          .where(eq(controlPlaneJobBindings.sourceBindingId, parent.id))
          .get()?.enabled,
      ).toBe(false);
      release();
      expect(await outcome).toBeInstanceOf(Error);
      expect(harness.db.select().from(threads).all().length).toBe(before);
      expect(
        harness.db
          .select()
          .from(controlPlaneJobBindings)
          .where(eq(controlPlaneJobBindings.sourceBindingId, parent.id))
          .get()?.deletedAt,
      ).not.toBeNull();
    } finally {
      controller.abort();
      release();
      waitForRegistrations.mockRestore();
      await workers.close();
    }
  });
});
