import { createControlPlaneInspectionService } from "../../src/control-plane/inspections.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { turnScope } from "@bb/domain";
import { withTestHarness } from "../helpers/test-app.js";
import { withControlPlaneUser } from "../../src/control-plane/access.js";
import { createControlPlaneAgentInvocations } from "../../src/control-plane/agent-invocations.js";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { createMigratedConnection } from "@bb/db/testing";
import {
  controlPlaneAgentInvocations,
  controlPlaneJobBindings,
  reserveControlPlaneUidMaintenance,
  appendStoredThreadEvent,
  createControlPlaneProfile,
  threads,
  createThread,
  noopNotifier,
  publishControlPlaneProfileVersion,
  createControlPlaneJobBinding,
  reserveControlPlaneAgentInvocation,
  requireControlPlaneInvocationTarget,
  requireControlPlaneJobDispatch,
  requireControlPlaneThreadDispatch,
  setControlPlaneProfileAccess,
} from "@bb/db";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";

it("requires explicit parent policy, retains ancestry on native child dispatch and atomically bounds sibling calls", () => {
  const db = createMigratedConnection();
  try {
    const { alice, bob } = seedControlPlaneJobSubjects(db);
    setControlPlaneProfileAccess(
      db,
      bob.profile.profileId,
      alice.user.id,
      true,
    );
    expect(() =>
      reserveControlPlaneAgentInvocation(
        db,
        { kind: "thread", id: alice.thread.id },
        { versionId: bob.profile.versionId, input: "x", key: "legacy" },
      ),
    ).toThrow("not authorized");
    const version = publishControlPlaneProfileVersion(
      db,
      alice.profile.profileId,
      {
        prompt: "Delegate",
        providerId: "qwen-server",
        model: "qwen-test",
        reasoningLevel: "none",
        permissionMode: "full",
        tools: [],
        mcpServers: [],
        delegation: { allowedVersionIds: [bob.profile.versionId] },
      },
    );
    const parent = createControlPlaneJobBinding(db, {
      ...alice.input,
      userId: alice.user.id,
      profileVersionId: version.id,
    });
    const context = { kind: "workflow" as const, id: parent.id };
    const input = {
      versionId: bob.profile.versionId,
      input: "Convert diagram",
      key: "step:0",
    };
    const call = reserveControlPlaneAgentInvocation(db, context, input);
    expect(reserveControlPlaneAgentInvocation(db, context, input).id).toBe(
      call.id,
    );
    expect(() =>
      reserveControlPlaneAgentInvocation(db, context, {
        ...input,
        input: "other",
      }),
    ).toThrow("idempotency conflict");
    const child = createThread(db, noopNotifier, {
      projectId: alice.project.id,
      environmentId: alice.environment.id,
      providerId: "qwen-server",
      status: "active",
      controlPlaneOwnerUserId: alice.user.id,
      controlPlaneProfileVersionId: bob.profile.versionId,
      controlPlaneRun: {
        source: "manual",
        idempotencyKey: call.childKey,
        inputDigest: "digest",
      },
    });
    expect(requireControlPlaneThreadDispatch(db, child.id)?.user.id).toBe(
      alice.user.id,
    );
    db.update(controlPlaneAgentInvocations)
      .set({ createdAt: Date.now() - 600001 })
      .where(eq(controlPlaneAgentInvocations.id, call.id))
      .run();
    expect(() => requireControlPlaneThreadDispatch(db, child.id)).toThrow(
      "not authorized",
    );
    db.update(controlPlaneAgentInvocations)
      .set({ createdAt: Date.now() })
      .where(eq(controlPlaneAgentInvocations.id, call.id))
      .run();
    setControlPlaneProfileAccess(
      db,
      bob.profile.profileId,
      alice.user.id,
      false,
    );
    expect(() => requireControlPlaneThreadDispatch(db, child.id)).toThrow(
      "not authorized",
    );
    setControlPlaneProfileAccess(
      db,
      bob.profile.profileId,
      alice.user.id,
      true,
    );
    for (let i = 1; i < 8; i++)
      reserveControlPlaneAgentInvocation(db, context, {
        ...input,
        key: `step:${i}`,
      });
    expect(() =>
      reserveControlPlaneAgentInvocation(db, context, {
        ...input,
        key: "overflow",
      }),
    ).toThrow("not authorized");
    db.update(controlPlaneAgentInvocations)
      .set({ state: "succeeded" })
      .where(eq(controlPlaneAgentInvocations.id, call.id))
      .run();
    expect(() => requireControlPlaneThreadDispatch(db, child.id)).toThrow(
      "not authorized",
    );
    const another = reserveControlPlaneAgentInvocation(db, context, {
      ...input,
      key: "after-finished",
    });
    expect(another.rootId).toBe(call.rootId);
    db.update(controlPlaneAgentInvocations).set({ state: "succeeded" }).run();
    for (let i = 9; i < 64; i++) {
      const budgeted = reserveControlPlaneAgentInvocation(db, context, {
        ...input,
        key: `total:${i}`,
      });
      db.update(controlPlaneAgentInvocations)
        .set({ state: "succeeded" })
        .where(eq(controlPlaneAgentInvocations.id, budgeted.id))
        .run();
    }
    expect(() =>
      reserveControlPlaneAgentInvocation(db, context, {
        ...input,
        key: "total-overflow",
      }),
    ).toThrow("not authorized");
    expect(() =>
      requireControlPlaneInvocationTarget(
        db,
        { kind: "thread", id: bob.thread.id },
        version.id,
      ),
    ).toThrow("not authorized");
    db.update(threads)
      .set({ status: "idle" })
      .where(eq(threads.id, child.id))
      .run();
    expect(() =>
      requireControlPlaneInvocationTarget(
        db,
        { kind: "thread", id: child.id },
        bob.profile.versionId,
      ),
    ).toThrow("not authorized");
  } finally {
    db.$client.close();
  }
});

it("fences nested invocation depth through saved native workflow roots", () => {
  const db = createMigratedConnection();
  try {
    const { alice, bob } = seedControlPlaneJobSubjects(db);
    setControlPlaneProfileAccess(
      db,
      bob.profile.profileId,
      alice.user.id,
      true,
    );
    const ids = [bob.profile.versionId];
    for (let i = 0; i < 5; i++)
      ids.push(
        publishControlPlaneProfileVersion(db, alice.profile.profileId, {
          prompt: "Delegate",
          providerId: "qwen-server",
          model: "qwen-test",
          reasoningLevel: "none",
          permissionMode: "full",
          tools: [],
          mcpServers: [],
          delegation: { allowedVersionIds: [ids[i]] },
        }).id,
      );
    let parent = createControlPlaneJobBinding(db, {
      ...alice.input,
      userId: alice.user.id,
      profileVersionId: ids[5],
    });
    let rootId: string | null = null;
    for (let i = 4; i >= 1; i--) {
      const call = reserveControlPlaneAgentInvocation(
        db,
        { kind: "workflow", id: parent.id },
        { versionId: ids[i], input: "nested", key: "step:0" },
      );
      expect(call.depth).toBe(5 - i);
      if (rootId === null) rootId = call.rootId;
      expect(call.rootId).toBe(rootId);
      parent = createControlPlaneJobBinding(db, {
        ...alice.input,
        objectId: call.workflowRunId,
        userId: alice.user.id,
        profileVersionId: ids[i],
        originThreadId: null,
      });
    }
    const last = db
      .select()
      .from(controlPlaneAgentInvocations)
      .where(eq(controlPlaneAgentInvocations.workflowRunId, parent.objectId))
      .get();
    if (!last) throw new Error("Missing nested invocation");
    db.update(controlPlaneAgentInvocations)
      .set({ createdAt: Date.now() - 600001 })
      .where(eq(controlPlaneAgentInvocations.id, last.id))
      .run();
    expect(() => requireControlPlaneJobDispatch(db, parent.id)).toThrow(
      "not authorized",
    );
    db.update(controlPlaneAgentInvocations)
      .set({ createdAt: Date.now() })
      .where(eq(controlPlaneAgentInvocations.id, last.id))
      .run();
    expect(() =>
      reserveControlPlaneAgentInvocation(
        db,
        { kind: "workflow", id: parent.id },
        { versionId: ids[0], input: "too-deep", key: "step:0" },
      ),
    ).toThrow("not authorized");
  } finally {
    db.$client.close();
  }
});

it("reuses an admitted conversation after a lost reply and rejects its interrupted terminal turn", async () => {
  await withTestHarness(async (harness) => {
    const { alice, bob } = seedControlPlaneJobSubjects(harness.db);
    setControlPlaneProfileAccess(
      harness.db,
      bob.profile.profileId,
      alice.user.id,
      true,
    );
    const version = publishControlPlaneProfileVersion(
      harness.db,
      alice.profile.profileId,
      {
        prompt: "Delegate",
        providerId: "qwen-server",
        model: "qwen-test",
        reasoningLevel: "none",
        permissionMode: "full",
        tools: [],
        mcpServers: [],
        delegation: { allowedVersionIds: [bob.profile.versionId] },
      },
    );
    const parent = createThread(harness.db, harness.hub, {
      projectId: alice.project.id,
      environmentId: alice.environment.id,
      providerId: "qwen-server",
      status: "active",
      controlPlaneOwnerUserId: alice.user.id,
      controlPlaneProfileVersionId: version.id,
    });
    const reference = { kind: "thread" as const, id: parent.id };
    const input = {
      versionId: bob.profile.versionId,
      input: "task",
      key: "retry-after-lost-reply",
    };
    const call = reserveControlPlaneAgentInvocation(
      harness.db,
      reference,
      input,
    );
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          projectId: alice.project.id,
          profileVersionId: bob.profile.versionId,
          input: "task",
          source: "manual",
        }),
      )
      .digest("hex");
    const child = createThread(harness.db, harness.hub, {
      projectId: alice.project.id,
      environmentId: alice.environment.id,
      providerId: "qwen-server",
      status: "idle",
      controlPlaneOwnerUserId: alice.user.id,
      controlPlaneProfileVersionId: bob.profile.versionId,
      controlPlaneRun: {
        source: "manual",
        idempotencyKey: call.childKey,
        inputDigest: digest,
      },
    });
    appendStoredThreadEvent(harness.db, harness.hub, {
      threadId: child.id,
      type: "turn/completed",
      scope: turnScope("interrupted"),
      data: { providerThreadId: "session", status: "interrupted" },
    });
    const service = createControlPlaneAgentInvocations(
      harness.deps,
      async () => {
        throw new Error("Unexpected workflow RPC");
      },
    );
    try {
      await expect(
        withControlPlaneUser(alice.user.id, () =>
          service.invoke(reference, input, new AbortController().signal),
        ),
      ).rejects.toThrow("interrupted");
      const saved = harness.db
        .select()
        .from(controlPlaneAgentInvocations)
        .where(eq(controlPlaneAgentInvocations.id, call.id))
        .get();
      expect(saved).toMatchObject({ runId: child.id, state: "cancelled" });
      expect(
        harness.db.select().from(controlPlaneAgentInvocations).all(),
      ).toHaveLength(1);
    } finally {
      await service.close();
    }
  });
});

it("fences a pending reservation immediately when cancellation races native workflow admission", async () => {
  await withTestHarness(async (harness) => {
    const { alice } = seedControlPlaneJobSubjects(harness.db);
    const target = createControlPlaneProfile(
      harness.db,
      {
        slug: "whole-workflow",
        name: "Whole workflow",
        definition: {
          prompt: "Leaf",
          providerId: "qwen-server",
          model: "qwen-test",
          reasoningLevel: "none",
          permissionMode: "full",
          tools: [],
          mcpServers: [],
          workflow: { definitionId: "wfd_invocation-test", revision: 1 },
        },
      },
      {
        definitionId: "wfd_invocation-test",
        revision: 1,
        script:
          'export const meta={name:"leaf",description:"leaf",inputSchema:{type:"string"},outputSchema:{type:"string"}}; return args;',
      },
    );
    setControlPlaneProfileAccess(
      harness.db,
      target.profileId,
      alice.user.id,
      true,
    );
    const parentVersion = publishControlPlaneProfileVersion(
      harness.db,
      alice.profile.profileId,
      {
        prompt: "Delegate",
        providerId: "qwen-server",
        model: "qwen-test",
        reasoningLevel: "none",
        permissionMode: "full",
        tools: [],
        mcpServers: [],
        delegation: { allowedVersionIds: [target.versionId] },
      },
    );
    const parent = createThread(harness.db, harness.hub, {
      projectId: alice.project.id,
      environmentId: alice.environment.id,
      providerId: "qwen-server",
      status: "active",
      controlPlaneOwnerUserId: alice.user.id,
      controlPlaneProfileVersionId: parentVersion.id,
    });
    let release: () => void = () => {};
    const pending = new Promise<void>((done) => {
      release = done;
    });
    let entered: () => void = () => {};
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const service = createControlPlaneAgentInvocations(
      harness.deps,
      async (method, input) => {
        if (method !== "controlPlaneAgentWorkflowStart")
          throw new Error("Unexpected RPC");
        entered();
        await pending;
        const body = z.object({ runId: z.string() }).parse(input);
        createControlPlaneJobBinding(harness.db, {
          kind: "workflow-run",
          objectId: body.runId,
          revision: 1,
          userId: alice.user.id,
          projectId: alice.project.id,
          profileVersionId: target.versionId,
          originThreadId: null,
          sourceBindingId: null,
        });
        throw new Error("A cancelled child must not be admitted");
      },
    );
    const controller = new AbortController();
    const invocation = withControlPlaneUser(alice.user.id, () =>
      service.invoke(
        { kind: "thread", id: parent.id },
        { versionId: target.versionId, input: "task", key: "race" },
        controller.signal,
      ),
    );
    const rejected = expect(invocation).rejects.toThrow("not authorized");
    try {
      await started;
      controller.abort();
      await vi.waitFor(() =>
        expect(
          harness.db.select().from(controlPlaneAgentInvocations).get()?.state,
        ).toBe("cancelled"),
      );
      release();
      await rejected;
    } finally {
      release();
      await service.close();
    }
  });
});

it("fences abandoned reservations and retries durable workflow cleanup across callback generations", async () => {
  await withTestHarness(async (harness) => {
    const { alice, bob } = seedControlPlaneJobSubjects(harness.db);
    setControlPlaneProfileAccess(
      harness.db,
      bob.profile.profileId,
      alice.user.id,
      true,
    );
    const version = publishControlPlaneProfileVersion(
      harness.db,
      alice.profile.profileId,
      {
        prompt: "Delegate",
        providerId: "qwen-server",
        model: "qwen-test",
        reasoningLevel: "none",
        permissionMode: "full",
        tools: [],
        mcpServers: [],
        delegation: { allowedVersionIds: [bob.profile.versionId] },
      },
    );
    const parent = createThread(harness.db, harness.hub, {
      projectId: alice.project.id,
      environmentId: alice.environment.id,
      providerId: "qwen-server",
      status: "active",
      controlPlaneOwnerUserId: alice.user.id,
      controlPlaneProfileVersionId: version.id,
    });
    const call = reserveControlPlaneAgentInvocation(
      harness.db,
      { kind: "thread", id: parent.id },
      {
        versionId: bob.profile.versionId,
        input: "task",
        key: "crash-before-reply",
      },
    );
    createControlPlaneJobBinding(harness.db, {
      ...alice.input,
      objectId: call.workflowRunId,
      userId: alice.user.id,
      profileVersionId: bob.profile.versionId,
      originThreadId: null,
    });
    const service = createControlPlaneAgentInvocations(
      harness.deps,
      async () => {
        throw new Error("Unexpected workflow read");
      },
    );
    const first = vi.fn(async () => {
      throw new Error("Plugin generation disposed");
    });
    const removeFirst = service.registerStop(first);
    try {
      setControlPlaneProfileAccess(
        harness.db,
        bob.profile.profileId,
        alice.user.id,
        false,
      );
      await service.reconcile();
      expect(first).toHaveBeenCalledWith(call.workflowRunId);
      expect(
        harness.db.select().from(controlPlaneAgentInvocations).get(),
      ).toMatchObject({
        id: call.id,
        state: "cancelled",
        cleanupPending: true,
        createdAt: call.createdAt,
        depth: 1,
      });
      setControlPlaneProfileAccess(
        harness.db,
        bob.profile.profileId,
        alice.user.id,
        true,
      );
      expect(() =>
        requireControlPlaneJobDispatch(
          harness.db,
          harness.db
            .select()
            .from(controlPlaneJobBindings)
            .where(eq(controlPlaneJobBindings.objectId, call.workflowRunId))
            .get()!.id,
        ),
      ).toThrow("not authorized");
      const next = vi.fn(async () => true);
      service.registerStop(next);
      removeFirst();
      await service.reconcile();
      expect(next).toHaveBeenCalledWith(call.workflowRunId);
      expect(
        harness.db.select().from(controlPlaneAgentInvocations).get(),
      ).toMatchObject({ state: "cancelled", cleanupPending: false });
      expect(
        harness.db.select().from(controlPlaneAgentInvocations).all(),
      ).toHaveLength(1);
      const paused = reserveControlPlaneAgentInvocation(
        harness.db,
        { kind: "thread", id: parent.id },
        {
          versionId: bob.profile.versionId,
          input: "task",
          key: "capacity-wait",
        },
      );
      reserveControlPlaneUidMaintenance(harness.db, {
        userId: alice.user.id,
        projectId: alice.project.id,
        operationId: "00000000-0000-4000-8000-000000000123",
        rootGeneration: 0,
      });
      await service.reconcile();
      expect(
        harness.db
          .select()
          .from(controlPlaneAgentInvocations)
          .where(eq(controlPlaneAgentInvocations.id, paused.id))
          .get(),
      ).toMatchObject({ state: "pending", createdAt: paused.createdAt });
      const expiredAt = Date.now() - 600001;
      harness.db
        .update(controlPlaneAgentInvocations)
        .set({ createdAt: expiredAt })
        .where(eq(controlPlaneAgentInvocations.id, paused.id))
        .run();
      await service.reconcile();
      expect(
        harness.db
          .select()
          .from(controlPlaneAgentInvocations)
          .where(eq(controlPlaneAgentInvocations.id, paused.id))
          .get(),
      ).toMatchObject({
        state: "cancelled",
        cleanupPending: false,
        createdAt: expiredAt,
        depth: 1,
      });
    } finally {
      await service.close();
    }
  });
});

it("discovers delegated thread provenance from native identity and hides unreadable parents", async () => {
  await withTestHarness(async (harness) => {
    const { alice, bob } = seedControlPlaneJobSubjects(harness.db);
    setControlPlaneProfileAccess(
      harness.db,
      bob.profile.profileId,
      alice.user.id,
      true,
    );
    const version = publishControlPlaneProfileVersion(
      harness.db,
      alice.profile.profileId,
      {
        prompt: "Delegate",
        providerId: "qwen-server",
        model: "qwen-test",
        reasoningLevel: "none",
        permissionMode: "full",
        tools: [],
        mcpServers: [],
        delegation: { allowedVersionIds: [bob.profile.versionId] },
      },
    );
    const parent = createControlPlaneJobBinding(harness.db, {
      ...alice.input,
      userId: alice.user.id,
      profileVersionId: version.id,
    });
    const call = reserveControlPlaneAgentInvocation(
      harness.db,
      { kind: "workflow", id: parent.id },
      { versionId: bob.profile.versionId, input: "task", key: "step:0" },
    );
    const child = createThread(harness.db, harness.hub, {
      projectId: alice.project.id,
      environmentId: alice.environment.id,
      providerId: "qwen-server",
      status: "idle",
      controlPlaneOwnerUserId: alice.user.id,
      controlPlaneProfileVersionId: bob.profile.versionId,
      controlPlaneRun: {
        source: "manual",
        idempotencyKey: call.childKey,
        inputDigest: "digest",
      },
    });
    const inspections = createControlPlaneInspectionService(
      harness.deps,
      async () => {
        throw new Error("Unexpected workflow RPC");
      },
    );
    try {
      const own = inspections.forActor({
        kind: "user",
        userId: alice.user.id,
        authorized: () => true,
      });
      expect(
        own.threads(null, child.id).get(child.id).delegation,
      ).toMatchObject({
        invocationId: call.id,
        state: "pending",
        parent: { kind: "workflow", id: parent.objectId },
      });
      harness.db
        .update(controlPlaneJobBindings)
        .set({ deletedAt: Date.now() })
        .where(eq(controlPlaneJobBindings.id, parent.id))
        .run();
      expect(
        own.threads(null, child.id).get(child.id).delegation?.parent,
      ).toBeNull();
      expect(() =>
        inspections
          .forActor({
            kind: "user",
            userId: bob.user.id,
            authorized: () => true,
          })
          .threads(null, child.id)
          .get(child.id),
      ).toThrow();
    } finally {
      inspections.close();
    }
  });
});
