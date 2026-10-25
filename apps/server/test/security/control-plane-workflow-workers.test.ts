import { threadScope, turnScope } from "@bb/domain";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import {
  createControlPlaneJobBinding,
  createThread,
  appendStoredThreadEvent,
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
      ).toEqual({
        threadId: child.id,
        status: "idle",
        output: null,
        error: null,
        idleSequence: null,
      });
      appendStoredThreadEvent(harness.db, harness.hub, {
        threadId: child.id,
        type: "system/error",
        scope: threadScope(),
        data: {
          code: "provider_failed",
          message: "Provider failed",
          detail: "HTTP 503: provider unavailable",
        },
      });
      harness.db
        .update(threads)
        .set({ status: "error" })
        .where(eq(threads.id, child.id))
        .run();
      expect(
        (
          await withControlPlaneUser(alice.user.id, () =>
            jobs.getWorker(a.id, child.id),
          )
        ).error,
      ).toBe("Provider failed\nHTTP 503: provider unavailable");
      appendStoredThreadEvent(harness.db, harness.hub, {
        threadId: child.id,
        type: "turn/completed",
        scope: turnScope("failed-turn"),
        data: {
          providerThreadId: "session",
          status: "failed",
          error: { message: "HTTP 401: authentication failed" },
        },
      });
      expect(
        (
          await withControlPlaneUser(alice.user.id, () =>
            jobs.getWorker(a.id, child.id),
          )
        ).error,
      ).toBe("HTTP 401: authentication failed");
      appendStoredThreadEvent(harness.db, harness.hub, {
        threadId: child.id,
        type: "system/error",
        scope: threadScope(),
        data: {
          code: "not_authorized",
          message: "Permission denied",
          detail: "HTTP 403",
        },
      });
      expect(
        (
          await withControlPlaneUser(alice.user.id, () =>
            jobs.getWorker(a.id, child.id),
          )
        ).error,
      ).toBe("Permission denied\nHTTP 403");
      appendStoredThreadEvent(harness.db, harness.hub, {
        threadId: child.id,
        type: "turn/completed",
        scope: turnScope("completed-turn"),
        data: { providerThreadId: "session", status: "completed" },
      });
      harness.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, child.id))
        .run();
      const idle = await withControlPlaneUser(alice.user.id, () =>
        jobs.getWorker(a.id, child.id),
      );
      expect(idle.error).toBeNull();
      expect(idle.idleSequence).toBeGreaterThan(0);
      expect(
        await jobs.releaseWorker(a.id, child.id, (idle.idleSequence ?? 1) - 1),
      ).toBe(false);
      harness.db
        .update(threads)
        .set({ status: "active" })
        .where(eq(threads.id, child.id))
        .run();
      expect(
        await jobs.releaseWorker(a.id, child.id, idle.idleSequence ?? 0),
      ).toBe(false);
      harness.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, child.id))
        .run();
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

it("discovers only authoritative worker mappings with source-filtered cursor pages", async () => {
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
      const expected = new Map<string, string[]>();
      for (const subject of [alice, bob]) {
        const parent = await withControlPlaneUser(subject.user.id, () =>
          jobs.bind(subject.input),
        );
        const ids = [];
        for (let index = 0; index < 2; index++) {
          const binding = createControlPlaneJobBinding(harness.db, {
            ...subject.input,
            kind: "workflow-worker",
            objectId: randomUUID(),
            userId: subject.user.id,
            profileVersionId: subject.profile.versionId,
            sourceBindingId: parent.id,
          });
          const child = createThread(harness.db, harness.hub, {
            projectId: subject.project.id,
            environmentId: subject.environment.id,
            providerId: "qwen-server",
            status: "idle",
            originPluginId: "workflows",
            controlPlaneOwnerUserId: subject.user.id,
            controlPlaneProfileVersionId: subject.profile.versionId,
            controlPlaneJobBindingId: binding.id,
            pluginMetadata: {
              pluginId: "workflows",
              metadata: {
                workflowWorker: 1,
                runId: parent.objectId,
                callId: `call-${index}`,
              },
            },
          });
          ids.push(child.id);
        }
        expected.set(subject.user.id, ids);
      }
      expect(
        jobs.listWorkers({
          cursor: null,
          limit: 100,
          includeArchived: false,
        }).workers,
      ).toHaveLength(4);
      for (const subject of [alice, bob])
        withControlPlaneUser(subject.user.id, () => {
          const first = jobs.listWorkers({
            cursor: null,
            limit: 1,
            includeArchived: false,
          });
          expect(first.workers).toHaveLength(1);
          expect(first.workers[0]?.callId).toMatch(/^call-/u);
          expect(first.nextCursor).not.toBeNull();
          const second = jobs.listWorkers({
            cursor: first.nextCursor,
            includeArchived: false,
            limit: 1,
          });
          expect(second.nextCursor).toBeNull();
          expect(
            [...first.workers, ...second.workers].map((w) => w.threadId).sort(),
          ).toEqual(expected.get(subject.user.id)?.sort());
        });
      await jobs.archiveWorker(
        jobs.listWorkers({ cursor: null, limit: 1, includeArchived: false })
          .workers[0]!.parentBindingId,
        jobs.listWorkers({ cursor: null, limit: 1, includeArchived: false })
          .workers[0]!.threadId,
      );
      expect(
        jobs.listWorkers({
          cursor: null,
          limit: 100,
          includeArchived: false,
        }).workers,
      ).toHaveLength(3);
      expect(
        jobs.listWorkers({ cursor: null, limit: 100, includeArchived: true })
          .workers,
      ).toHaveLength(4);
      const first = jobs.listWorkers({
        cursor: null,
        limit: 1,
        includeArchived: false,
      }).workers[0]!;
      harness.db.delete(threads).where(eq(threads.id, first.threadId)).run();
      await expect(
        jobs.archiveWorker(first.parentBindingId, first.threadId),
      ).resolves.toBeUndefined();
      await expect(
        jobs.getWorker(first.parentBindingId, first.threadId),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await workers.close();
    }
  });
});
