import { expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createMigratedConnection } from "@bb/db/testing";
import {
  controlPlaneTaskSources,
  controlPlaneTaskSourceItems,
  setControlPlaneProfileAccess,
} from "@bb/db";
import {
  controlPlaneAgentRunSchema,
  controlPlaneAgentRunStartSchema,
} from "@bb/domain";
import { Hono } from "hono";
import { createControlPlaneClient } from "@bb/sdk/node";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { createControlPlaneTaskSourceService } from "../../src/control-plane/task-sources/service.js";
import { beadsTaskSourceAdapter } from "../../src/control-plane/task-sources/beads.js";
import {
  installControlPlaneTaskSourceRoutes,
  isControlPlaneTaskSourcePath,
} from "../../src/control-plane/task-sources/routes.js";
function fixture() {
  const db = createMigratedConnection();
  const { alice, bob } = seedControlPlaneJobSubjects(db);
  const start = vi.fn(async () =>
    controlPlaneAgentRunSchema.parse({
      runId: "thr_task",
      threadId: "thr_task",
      projectId: alice.project.id,
      profileId: alice.profile.profileId,
      profileVersionId: alice.profile.versionId,
      source: "manual",
      title: "task",
      status: "starting",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  const run = vi.fn(async () =>
    JSON.stringify([{ id: "bd-1", title: "Task", description: "original" }]),
  );
  let time = 1000;
  const options = { run, now: () => time };
  const service = createControlPlaneTaskSourceService(db, { start }, options);
  const source = service.create(alice.user.id, {
    kind: "beads",
    projectId: alice.project.id,
    profileVersionId: alice.profile.versionId,
    name: "Work",
    intervalSeconds: 60,
  });
  return {
    db,
    alice,
    bob,
    start,
    run,
    service,
    source,
    options,
    time: (value: number) => {
      time = value;
    },
    close: () => {
      service.close();
      db.$client.close();
    },
  };
}
it("uses project ownership and immutable targets; paused sources and foreign IDs cannot poll", async () => {
  const f = fixture();
  try {
    expect(f.source.enabled).toBe(false);
    await expect(
      f.service.pollNow(f.alice.user.id, f.source.id),
    ).rejects.toMatchObject({ status: 409 });
    for (const operation of [
      () => f.service.get(f.bob.user.id, f.source.id),
      () => f.service.history(f.bob.user.id, f.source.id),
      () => f.service.setEnabled(f.bob.user.id, f.source.id, true),
    ])
      expect(operation).toThrow("not found");
    expect(() =>
      f.service.create(f.alice.user.id, {
        kind: "beads",
        projectId: f.alice.project.id,
        profileVersionId: f.alice.profile.versionId,
        name: "Duplicate",
      }),
    ).toThrow("already");
    f.service.setEnabled(f.alice.user.id, f.source.id, true);
    await f.service.tick();
    expect(f.start).toHaveBeenCalledWith(
      f.alice.user.id,
      expect.objectContaining({
        projectId: f.alice.project.id,
        profileVersionId: f.alice.profile.versionId,
        input: expect.stringContaining("original"),
      }),
    );
    expect(f.service.history(f.alice.user.id, f.source.id).items[0].state).toBe(
      "accepted",
    );
    expect(
      JSON.stringify(f.service.history(f.alice.user.id, f.source.id)),
    ).not.toContain("original");
  } finally {
    f.close();
  }
});
it("coalesces concurrent polling and keeps the first input and native key after lost replies and restart", async () => {
  const f = fixture();
  try {
    f.service.setEnabled(f.alice.user.id, f.source.id, true);
    f.start.mockRejectedValueOnce(new Error("private provider details"));
    await Promise.all([
      f.service.pollNow(f.alice.user.id, f.source.id),
      f.service.pollNow(f.alice.user.id, f.source.id),
    ]);
    expect(f.start).toHaveBeenCalledTimes(1);
    const originalKey = f.start.mock.calls[0];
    const row = f.db.select().from(controlPlaneTaskSourceItems).get();
    expect(row?.state).toBe("pending");
    expect(
      f.service.get(f.alice.user.id, f.source.id).checkpoint,
    ).not.toBeNull();
    expect(
      JSON.stringify(f.service.history(f.alice.user.id, f.source.id)),
    ).not.toContain("private provider");
    f.run.mockResolvedValue(
      JSON.stringify([
        { id: "bd-1", title: "Changed", description: "different" },
      ]),
    );
    const restarted = createControlPlaneTaskSourceService(
      f.db,
      { start: f.start },
      f.options,
    );
    await restarted.pollNow(f.alice.user.id, f.source.id);
    expect(f.start.mock.calls[1]).toEqual(originalKey);
    await restarted.pollNow(f.alice.user.id, f.source.id);
    expect(f.start).toHaveBeenCalledTimes(2);
    expect(f.db.select().from(controlPlaneTaskSourceItems).all()).toHaveLength(
      1,
    );
    restarted.close();
    expect(
      controlPlaneAgentRunStartSchema.shape.idempotencyKey.safeParse(
        `task-source:${row?.id}`,
      ).success,
    ).toBe(false);
  } finally {
    f.close();
  }
});
it("backs off on source errors, fences grant revocation and does not advance a bad checkpoint", async () => {
  const f = fixture();
  try {
    f.service.setEnabled(f.alice.user.id, f.source.id, true);
    f.run.mockResolvedValue("not JSON");
    await f.service.tick();
    expect(f.service.get(f.alice.user.id, f.source.id)).toMatchObject({
      failures: 1,
      nextPollAt: 121000,
      checkpoint: null,
    });
    f.time(120999);
    await f.service.tick();
    expect(f.run).toHaveBeenCalledTimes(1);
    f.time(121000);
    await f.service.tick();
    expect(f.run).toHaveBeenCalledTimes(2);
    setControlPlaneProfileAccess(
      f.db,
      f.alice.profile.profileId,
      f.alice.user.id,
      false,
    );
    f.time(1000000);
    await f.service.tick();
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.start).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
it("rechecks authority after reading and retains no tasks if paused or revoked during a read", async () => {
  const f = fixture();
  try {
    f.service.setEnabled(f.alice.user.id, f.source.id, true);
    f.run.mockImplementation(async () => {
      f.service.setEnabled(f.alice.user.id, f.source.id, false);
      return JSON.stringify([{ id: "bd-1", title: "Task" }]);
    });
    await f.service.pollNow(f.alice.user.id, f.source.id);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.db.select().from(controlPlaneTaskSourceItems).all()).toHaveLength(
      0,
    );
    expect(f.service.get(f.alice.user.id, f.source.id).checkpoint).toBeNull();
    expect(f.service.get(f.alice.user.id, f.source.id).failures).toBe(0);
    f.service.setEnabled(f.alice.user.id, f.source.id, true);
    f.run.mockImplementation(async () => {
      setControlPlaneProfileAccess(
        f.db,
        f.alice.profile.profileId,
        f.alice.user.id,
        false,
      );
      return JSON.stringify([{ id: "bd-1", title: "Task" }]);
    });
    await f.service.pollNow(f.alice.user.id, f.source.id);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.db.select().from(controlPlaneTaskSourceItems).all()).toHaveLength(
      0,
    );
    expect(f.service.get(f.alice.user.id, f.source.id).checkpoint).toBeNull();
    expect(f.service.get(f.alice.user.id, f.source.id).failures).toBe(1);
  } finally {
    f.close();
  }
});
it("shares the poll kernel with another adapter and bounds invalid and duplicate batches", async () => {
  const f = fixture();
  try {
    const poll = vi.fn(async () => ({
      checkpoint: "cursor-2",
      tasks: [{ id: "external-2", title: "Generic", input: "work" }],
    }));
    const service = createControlPlaneTaskSourceService(
      f.db,
      { start: f.start },
      { adapters: [{ kind: "example", poll }] },
    );
    f.db
      .update(controlPlaneTaskSources)
      .set({ kind: "example", enabled: true })
      .where(eq(controlPlaneTaskSources.id, f.source.id))
      .run();
    await service.tick();
    expect(poll).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpoint: null,
        sourceId: f.source.id,
        userId: f.alice.user.id,
        projectId: f.alice.project.id,
      }),
    );
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.db.select().from(controlPlaneTaskSources).get()?.checkpoint).toBe(
      "cursor-2",
    );
    service.close();
    await expect(
      beadsTaskSourceAdapter.poll({
        sourceId: f.source.id,
        userId: f.alice.user.id,
        projectId: f.alice.project.id,
        checkpoint: null,
        signal: new AbortController().signal,
        run: async () =>
          JSON.stringify([
            { id: "x", title: "One" },
            { id: "x", title: "Two" },
          ]),
      }),
    ).rejects.toThrow("Duplicate");
  } finally {
    f.close();
  }
});
it("exposes the same restricted SDK management paths without returning saved task input", async () => {
  const f = fixture();
  try {
    const app = new Hono();
    app.onError((error, c) =>
      c.json(
        { error: "denied" },
        "status" in error && error.status === 404 ? 404 : 500,
      ),
    );
    installControlPlaneTaskSourceRoutes(app, f.service, (c) =>
      c.req.header("authorization") === "alice"
        ? { user: { id: f.alice.user.id } }
        : null,
    );
    const client = createControlPlaneClient({
      origin: "https://test",
      fetch: async (input, init) =>
        app.request(
          new Request(input, {
            ...init,
            headers: { ...init?.headers, authorization: "alice" },
          }),
        ),
    });
    expect(
      (await client.taskSources.list({ projectId: f.alice.project.id }))
        .sources,
    ).toHaveLength(1);
    await client.taskSources.setEnabled(f.source.id, true);
    await client.taskSources.poll(f.source.id);
    expect(
      (await client.taskSources.history(f.source.id)).items[0],
    ).toMatchObject({ externalId: "bd-1", state: "accepted" });
    expect(
      (await app.request(`/control-plane/user/task-sources/${f.source.id}`))
        .status,
    ).toBe(401);
    expect(
      isControlPlaneTaskSourcePath(
        `/control-plane/user/task-sources/${f.source.id}/poll`,
        "POST",
      ),
    ).toBe(true);
    expect(
      isControlPlaneTaskSourcePath(
        `/control-plane/user/task-sources/${f.source.id}/poll/extra`,
        "POST",
      ),
    ).toBe(false);
  } finally {
    f.close();
  }
});

it("does not accelerate long-interval sources after a failure", async () => {
  const f = fixture();
  try {
    f.db
      .update(controlPlaneTaskSources)
      .set({ intervalSeconds: 86400, enabled: true })
      .where(eq(controlPlaneTaskSources.id, f.source.id))
      .run();
    f.run.mockResolvedValue("invalid");
    await f.service.tick();
    expect(f.service.get(f.alice.user.id, f.source.id).nextPollAt).toBe(
      86401000,
    );
  } finally {
    f.close();
  }
});
