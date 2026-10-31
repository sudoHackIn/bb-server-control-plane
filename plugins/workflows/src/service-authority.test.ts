import { randomUUID } from "node:crypto";
import type {
  InternalDoNotUseBackgroundJobBinding,
  InternalDoNotUseBackgroundJobs,
} from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import {
  createRun,
  getRunRequired,
  migrations,
  settleRun,
  claimQueuedRun,
  startCall,
  ownWorker,
  attachCallThread,
  settleCall,
} from "./data.js";
import { createWorkflowService } from "./service.js";
import { registerManagedWorkflowApi } from "./managed-api.js";
import { DEFAULT_WORKFLOW_SETTINGS } from "./settings.js";

function fixture() {
  const owner = randomUUID();
  const pausedOwners = new Set<string>();
  let caller: string | null = owner;
  const profileVersionId = randomUUID();
  const bindings = new Map<string, InternalDoNotUseBackgroundJobBinding>();
  const origin = {
    projectId: "project",
    environmentId: "environment",
    providerId: "qwen-server",
    model: "pinned-model",
    reasoningLevel: "none",
    permissionMode: "full",
  };
  const originLookup = vi.fn(async () =>
    makeThreadResponse({
      id: "origin",
      environmentId: origin.environmentId,
      status: "idle",
    }),
  );
  const spawn = vi.fn(async () => {
    throw new Error("Unexpected worker");
  });
  const send = vi.fn(async () => ({ ok: true }));
  const { bb, harness } = createFakePluginHost({
    pluginId: "workflows",
    sdk: { threads: { get: originLookup, spawn, send, list: async () => [] } },
  });
  const retire = vi.fn(async (id: string) => {
    bindings.delete(id);
  });
  const authority: InternalDoNotUseBackgroundJobs = {
    internal_DO_NOT_USE_executionPausedUserIds: () => [...pausedOwners],
    get userId() {
      return caller;
    },
    canReadProject: (id) => id === origin.projectId,
    readOrigin: () => origin,
    internal_DO_NOT_USE_workflowEnvironment: () => origin,
    async bind(input) {
      const binding = {
        ...input,
        id: randomUUID(),
        ownerUserId: owner,
        profileVersionId,
        enabled: true,
        deletedAt: null,
        createdAt: Date.now(),
      };
      bindings.set(binding.id, binding);
      return binding;
    },
    get: (id) => bindings.get(id) ?? null,
    list: () => ({ bindings: [...bindings.values()], nextCursor: null }),
    async setEnabled(id, enabled) {
      const binding = bindings.get(id);
      if (!binding) throw new Error("Missing test binding");
      binding.enabled = enabled;
      return binding;
    },
    remove: retire,
    listWorkers() {
      return { workers: [], nextCursor: null };
    },
    resolveWorkerProfile() {
      return { ...origin, profileVersionId };
    },
    async startWorker() {
      throw new Error("Test workers not configured");
    },
    async getWorker() {
      throw new Error("Test workers not configured");
    },
    async notifyOrigin() {
      return "accepted";
    },
    async sendWorker() {
      throw new Error("Test workers not configured");
    },
    async archiveWorker() {
      throw new Error("Test workers not configured");
    },
    async stopWorker() {
      throw new Error("Test workers not configured");
    },
    async runAutomationScript() {
      throw new Error("Automations only");
    },
    async stopAutomationScript() {
      throw new Error("Automations only");
    },
    async releaseWorker() {
      throw new Error("Test workers not configured");
    },
    async evaluateWorkflow() {
      throw new Error("Test evaluator not configured");
    },
    withAuthority(id, run) {
      const binding = bindings.get(id);
      if (!binding) throw new Error("Missing test binding");
      return run(binding);
    },
  };
  Object.defineProperty(bb.server, "internal_DO_NOT_USE_backgroundJobs", {
    value: authority,
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const service = createWorkflowService(bb, db);
  const input = {
    projectId: origin.projectId,
    originThreadId: "origin",
    source:
      'export const meta = {name: "owned", description: "Authority adapter consumer"}; return "must not evaluate";',
    args: null,
    resumedFromRunId: null,
  };
  return {
    pausedOwners,
    owner,
    bb,
    authority,
    profileVersionId,
    bindings,
    originLookup,
    spawn,
    send,
    retire,
    harness,
    db,
    service,
    input,
    setCaller(value: string | null) {
      caller = value;
    },
  };
}

it("attaches reserved owner authority and a pinned origin without querying unrestricted thread defaults", async () => {
  const test = fixture();
  try {
    const run = await test.service.start(test.input);
    expect(run).toMatchObject({
      ownerUserId: test.owner,
      originModel: "pinned-model",
      originProvider: "qwen-server",
    });
    expect(run.authorityBindingId).not.toBeNull();
    expect([...test.bindings.values()]).toEqual([
      expect.objectContaining({
        kind: "workflow-run",
        objectId: run.id,
        ownerUserId: test.owner,
        profileVersionId: test.profileVersionId,
        originThreadId: "origin",
      }),
    ]);
    expect(test.originLookup).not.toHaveBeenCalled();
    test.setCaller(randomUUID());
    expect(test.service.get(run.id)).toBeNull();
    expect(test.service.inspect(run.id)).toBeNull();
    expect(test.service.inspectPage(run.id, -1, 10)).toBeNull();
    expect(test.service.inspectLatestForThread("origin")).toBeNull();
    expect(test.service.inspectActiveForThread("origin")).toEqual([]);
    expect(test.service.list("project", 1)).toEqual([]);
    expect(await test.service.stop(run.id)).toBe(false);
    await expect(
      test.service.start({ ...test.input, resumedFromRunId: run.id }),
    ).rejects.toThrow("unknown workflow");
    expect([...test.bindings.values()]).toHaveLength(1);
    test.setCaller(test.owner);
    test.bindings.clear();
    expect(test.service.get(run.id)).toBeNull();
    expect(await test.service.stop(run.id)).toBe(false);
    test.setCaller(null);
    expect(test.service.get(run.id)?.id).toBe(run.id);
    settleRun(test.db, {
      id: run.id,
      status: "failed",
      result: null,
      error: "test",
    });
    await expect(
      test.service.start({ ...test.input, resumedFromRunId: run.id }),
    ).rejects.toThrow("unassigned");
  } finally {
    await test.harness.dispose();
  }
});

it("retires a cross-database reservation when the real native SQLite insert fails", async () => {
  const test = fixture();
  try {
    test.db.exec(
      "CREATE TRIGGER reject_runs BEFORE INSERT ON workflow_runs BEGIN SELECT RAISE(ABORT, 'disk write rejected'); END",
    );
    await expect(test.service.start(test.input)).rejects.toThrow(
      "disk write rejected",
    );
    expect(test.retire).toHaveBeenCalledOnce();
    expect(test.bindings.size).toBe(0);
    expect(test.service.list("project", 10)).toEqual([]);
  } finally {
    await test.harness.dispose();
  }
});

it("delegates managed evaluation and never evaluates unassigned scripts in the shared service process", async () => {
  const test = fixture();
  const controller = new AbortController();
  let worker: Promise<void> | undefined;
  try {
    const owned = await test.service.start(test.input);
    const legacy = createRun(test.db, {
      projectId: "project",
      originThreadId: "origin",
      environmentId: "environment",
      originProvider: "qwen-server",
      originModel: "pinned-model",
      originReasoningLevel: "none",
      originPermissionMode: "full",
      name: "legacy",
      source: test.input.source,
      sourceHash: "legacy",
      argsJson: "null",
      settingsJson: JSON.stringify(DEFAULT_WORKFLOW_SETTINGS),
      resumedFromRunId: null,
    });
    expect(test.service.get(legacy.id)).toBeNull();
    test.setCaller(null);
    worker = test.service.runWorker(controller.signal);
    await vi.waitFor(() => {
      expect(test.service.get(owned.id)?.status).toBe("failed");
      expect(test.service.get(legacy.id)?.status).toBe("failed");
    });
    expect(test.service.get(owned.id)?.error).toContain(
      "Test evaluator not configured",
    );
    expect(test.service.get(legacy.id)?.error).toContain("unassigned");
    expect(test.service.get(owned.id)?.resultJson).toBeNull();
    expect(test.spawn).not.toHaveBeenCalled();
    expect(test.send).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    await worker;
    await test.harness.dispose();
  }
});

it("discovers paginated workers and cleans them without retained run history", async () => {
  const test = fixture();
  const controller = new AbortController();
  let worker: Promise<void> | undefined;
  const remaining = new Set(["orphan-one", "orphan-two"]);
  const archive = vi.fn(async (_parent: string, thread: string) => {
    remaining.delete(thread);
  });
  test.authority.archiveWorker = archive;
  test.authority.listWorkers = ({ cursor }) => {
    const id = cursor === null ? "orphan-one" : "orphan-two";
    return {
      workers: remaining.has(id)
        ? [
            {
              threadId: id,
              parentBindingId: `parent-${id}`,
              runId: "pruned-run",
              callId: null,
              originThreadId: "origin",
            },
          ]
        : [],
      nextCursor: cursor === null ? "next" : null,
    };
  };
  test.setCaller(null);
  try {
    worker = test.service.runWorker(controller.signal);
    await vi.waitFor(() => expect(archive).toHaveBeenCalledTimes(2));
    expect(archive).toHaveBeenCalledWith("parent-orphan-one", "orphan-one");
    expect(archive).toHaveBeenCalledWith("parent-orphan-two", "orphan-two");
    expect(test.spawn).not.toHaveBeenCalled();
    expect(test.send).not.toHaveBeenCalled();
    expect(test.originLookup).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    await worker;
    await test.harness.dispose();
  }
});

it.each(["accepted", "denied", "unavailable"] as const)(
  "uses only the scoped notification adapter for a managed %s outcome",
  async (outcome) => {
    const test = fixture();
    const controller = new AbortController();
    let worker: Promise<void> | undefined;
    const notify = vi.fn(async () => outcome);
    test.authority.notifyOrigin = notify;
    try {
      const run = await test.service.start(test.input);
      settleRun(test.db, {
        id: run.id,
        status: "succeeded",
        result: { value: 42 },
        error: null,
      });
      worker = test.service.runWorker(controller.signal);
      await vi.waitFor(() =>
        expect(getRunRequired(test.db, run.id).notificationSent).toBe(true),
      );
      expect(getRunRequired(test.db, run.id).notificationOutcome).toBe(
        outcome === "accepted" ? "delivered" : "abandoned",
      );
      expect(notify).toHaveBeenCalledWith(
        run.authorityBindingId,
        expect.stringContaining(run.id),
      );
      expect(test.originLookup).not.toHaveBeenCalled();
      expect(test.send).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await worker;
      await test.harness.dispose();
    }
  },
);

it.each([
  new Error("host offline"),
  Object.assign(new Error("maintenance"), {
    name: "ControlPlaneJobError",
    reason: "maintenance",
  }),
])(
  "retries a transient scoped notification failure after service restart: %s",
  async (failure) => {
    const test = fixture();
    const controller = new AbortController();
    let worker: Promise<void> | undefined;
    test.authority.notifyOrigin = async () => {
      throw failure;
    };
    try {
      const run = await test.service.start(test.input);
      settleRun(test.db, {
        id: run.id,
        status: "succeeded",
        result: null,
        error: null,
      });
      worker = test.service.runWorker(controller.signal);
      await vi.waitFor(() =>
        expect(getRunRequired(test.db, run.id).notificationAttemptCount).toBe(
          1,
        ),
      );
      controller.abort();
      await worker;
      expect(getRunRequired(test.db, run.id).notificationOutcome).toBe(
        "pending",
      );
      expect(test.originLookup).not.toHaveBeenCalled();
      expect(test.send).not.toHaveBeenCalled();
      test.db
        .prepare(
          "UPDATE workflow_runs SET notification_next_attempt_at = 0 WHERE id = ?",
        )
        .run(run.id);
      test.authority.notifyOrigin = async () => "accepted";
      const next = new AbortController();
      const restarted = createWorkflowService(test.bb, test.db);
      const running = restarted.runWorker(next.signal);
      try {
        await vi.waitFor(() =>
          expect(getRunRequired(test.db, run.id).notificationOutcome).toBe(
            "delivered",
          ),
        );
      } finally {
        next.abort();
        await running;
      }
    } finally {
      controller.abort();
      await worker;
      await test.harness.dispose();
    }
  },
);

it("retains queued managed work during UID maintenance and claims it after release", async () => {
  const test = fixture();
  const controller = new AbortController();
  let worker: Promise<void> | undefined;
  const evaluate = vi.fn(async () => "resumed");
  test.authority.evaluateWorkflow = evaluate;
  const pauseReads = vi.fn(() => [...test.pausedOwners]);
  test.authority.internal_DO_NOT_USE_executionPausedUserIds = pauseReads;
  try {
    const run = await test.service.start(test.input);
    test.pausedOwners.add(test.owner);
    test.setCaller(null);
    worker = test.service.runWorker(controller.signal);
    await vi.waitFor(() => expect(pauseReads).toHaveBeenCalled());
    expect(getRunRequired(test.db, run.id)).toMatchObject({
      status: "queued",
      startedAt: null,
      error: null,
    });
    expect(evaluate).not.toHaveBeenCalled();
    test.pausedOwners.clear();
    await vi.waitFor(
      () => expect(getRunRequired(test.db, run.id).status).toBe("succeeded"),
      { timeout: 2500 },
    );
    expect(evaluate).toHaveBeenCalledTimes(1);
  } finally {
    controller.abort();
    await worker;
    await test.harness.dispose();
  }
});

it("keeps owned notifications pending without attempts until maintenance releases the owner", async () => {
  const test = fixture();
  const controller = new AbortController();
  let worker: Promise<void> | undefined;
  const reads = vi.fn(() => [...test.pausedOwners]);
  const notify = vi.fn(async () => "accepted" as const);
  test.authority.internal_DO_NOT_USE_executionPausedUserIds = reads;
  test.authority.notifyOrigin = notify;
  try {
    const run = await test.service.start(test.input);
    settleRun(test.db, {
      id: run.id,
      status: "succeeded",
      result: { value: 42 },
      error: null,
    });
    test.pausedOwners.add(test.owner);
    worker = test.service.runWorker(controller.signal);
    await vi.waitFor(() => expect(reads).toHaveBeenCalled());
    expect(getRunRequired(test.db, run.id)).toMatchObject({
      notificationSent: false,
      notificationOutcome: "pending",
      notificationAttemptCount: 0,
    });
    expect(notify).not.toHaveBeenCalled();
    test.pausedOwners.clear();
    await vi.waitFor(() =>
      expect(getRunRequired(test.db, run.id).notificationOutcome).toBe(
        "delivered",
      ),
    );
    expect(notify).toHaveBeenCalledTimes(1);
  } finally {
    controller.abort();
    await worker;
    await test.harness.dispose();
  }
});

it("runs without an origin under pinned managed authority and settles notifications without sending", async () => {
  const test = fixture();
  const controller = new AbortController();
  let worker: Promise<void> | undefined;
  try {
    const notify = vi.spyOn(test.authority, "notifyOrigin");
    const readOrigin = vi.spyOn(test.authority, "readOrigin");
    const evaluate = vi
      .spyOn(test.authority, "evaluateWorkflow")
      .mockResolvedValue({ value: 42 });
    const run = await test.service.start({
      ...test.input,
      originThreadId: null,
      profileVersionId: test.profileVersionId,
    });
    expect(run.originThreadId).toBeNull();
    expect(run.ownerUserId).toBe(test.owner);
    test.setCaller(null);
    worker = test.service.runWorker(controller.signal);
    await vi.waitFor(() =>
      expect(getRunRequired(test.db, run.id).notificationOutcome).toBe(
        "abandoned",
      ),
    );
    expect(getRunRequired(test.db, run.id).status).toBe("succeeded");
    expect(evaluate).toHaveBeenCalled();
    expect(readOrigin).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    await expect(
      test.service.start({ ...test.input, originThreadId: null }),
    ).rejects.toThrow("pinned profile");
  } finally {
    controller.abort();
    await worker;
    await test.harness.dispose();
  }
});

it("admits workflow agents idempotently under a pinned profile and rechecks authority on retry", async () => {
  const test = fixture();
  try {
    const input = {
      ...test.input,
      originThreadId: null,
      profileVersionId: test.profileVersionId,
      runId: `wfa_${"a".repeat(64)}`,
      args: "task",
    };
    const runs = await Promise.all(
      Array.from({ length: 4 }, () => test.service.start(input)),
    );
    expect(new Set(runs.map((run) => run.id))).toEqual(new Set([input.runId]));
    expect(test.bindings.size).toBe(1);
    const restarted = createWorkflowService(test.bb, test.db);
    expect((await restarted.start(input)).id).toBe(input.runId);
    await expect(
      restarted.start({ ...input, args: "changed" }),
    ).rejects.toThrow("idempotency conflict");
    await expect(
      restarted.start({ ...input, profileVersionId: randomUUID() }),
    ).rejects.toThrow("idempotency conflict");
    const guard = vi
      .spyOn(test.authority, "withAuthority")
      .mockImplementation(() => {
        throw new Error("revoked");
      });
    await expect(restarted.start(input)).rejects.toThrow("revoked");
    guard.mockRestore();
  } finally {
    await test.harness.dispose();
  }
});

it.each([
  { value: "invalid", error: "Workflow result is invalid" },
  { value: "x".repeat(1024 * 1024 + 1), error: "byte limit" },
])(
  "persists workflow contract failures instead of publishing an unchecked result: $error",
  async ({ value, error }) => {
    const test = fixture();
    const controller = new AbortController();
    let worker: Promise<void> | undefined;
    try {
      vi.spyOn(test.authority, "evaluateWorkflow").mockResolvedValue(value);
      const input = {
        ...test.input,
        source:
          'export const meta={name:"contract",description:"Validate result",inputSchema:{type:"string",maxLength:4},outputSchema:{type:"number"}};return 42;',
        originThreadId: null,
        profileVersionId: test.profileVersionId,
      };
      await expect(
        test.service.start({ ...input, args: "too long" }),
      ).rejects.toThrow("Workflow args are invalid");
      const run = await test.service.start({ ...input, args: "task" });
      test.setCaller(null);
      worker = test.service.runWorker(controller.signal);
      await vi.waitFor(() =>
        expect(getRunRequired(test.db, run.id).status).toBe("failed"),
      );
      expect(getRunRequired(test.db, run.id).error).toContain(error);
      expect(getRunRequired(test.db, run.id).resultJson).toBeNull();
    } finally {
      controller.abort();
      await worker;
      await test.harness.dispose();
    }
  },
);

it.each([
  "revoked-step",
  "foreign-source",
  "foreign-project",
  "foreign-environment",
  "missing-source",
  "replay-of-replay",
] as const)(
  "rechecks persisted step and source authority before cached consumption: %s",
  async (failure) => {
    const test = fixture();
    const stepVersion = randomUUID();
    let revoked = false;
    const spawn = vi
      .spyOn(test.authority, "startWorker")
      .mockResolvedValue({ threadId: "child", bindingId: randomUUID() });
    vi.spyOn(test.authority, "stopWorker").mockResolvedValue(undefined);
    vi.spyOn(test.authority, "getWorker").mockResolvedValue({
      threadId: "child",
      status: "idle",
      output: "private result",
      error: null,
      idleSequence: 1,
    });
    vi.spyOn(test.authority, "resolveWorkerProfile").mockImplementation(
      (_id, requested) => {
        if (revoked && requested === stepVersion)
          throw new Error("Step profile revoked");
        return {
          profileVersionId: requested ?? test.profileVersionId,
          providerId: "qwen-server",
          model: "pinned-model",
          reasoningLevel: "none",
          permissionMode: "full",
        };
      },
    );
    const { parseAgentOptions } = await import("./validation.js");
    const { toJsonValue } = await import("./json-value.js");
    vi.spyOn(test.authority, "evaluateWorkflow").mockImplementation(
      async (_id, _input, signal, _event, onAgent) => {
        if (!onAgent) throw new Error("Missing scoped agent bridge");
        return onAgent(
          "Inspect project",
          toJsonValue(
            parseAgentOptions({ profileVersionId: stepVersion }),
            "options",
          ),
          signal,
          null,
        );
      },
    );
    const input = {
      ...test.input,
      originThreadId: null,
      profileVersionId: test.profileVersionId,
    };
    async function execute(
      service: ReturnType<typeof createWorkflowService>,
      id: string,
      status: "succeeded" | "failed",
    ) {
      test.setCaller(null);
      const controller = new AbortController();
      const worker = service.runWorker(controller.signal);
      try {
        await vi.waitFor(() =>
          expect(getRunRequired(test.db, id).status).toBe(status),
        );
      } finally {
        controller.abort();
        await worker;
        test.setCaller(test.owner);
      }
    }
    try {
      const original = await test.service.start(input);
      await execute(test.service, original.id, "succeeded");
      expect(spawn).toHaveBeenCalledTimes(1);
      let sourceId = original.id;
      if (failure === "replay-of-replay") {
        const second = createWorkflowService(test.bb, test.db);
        const replay = await second.start({
          ...input,
          resumedFromRunId: sourceId,
        });
        await execute(second, replay.id, "succeeded");
        sourceId = replay.id;
        expect(spawn).toHaveBeenCalledTimes(1);
      }
      const restarted = createWorkflowService(test.bb, test.db);
      const pending = await restarted.start({
        ...input,
        resumedFromRunId: sourceId,
      });
      if (failure === "revoked-step") revoked = true;
      else if (failure === "foreign-source" || failure === "foreign-project") {
        const source = original.authorityBindingId
          ? test.bindings.get(original.authorityBindingId)
          : null;
        if (!source) throw new Error("Missing source authority");
        const foreign = randomUUID();
        if (failure === "foreign-source") {
          test.db
            .prepare("UPDATE workflow_runs SET owner_user_id=? WHERE id=?")
            .run(foreign, original.id);
          test.bindings.set(source.id, { ...source, ownerUserId: foreign });
        } else {
          test.db
            .prepare("UPDATE workflow_runs SET project_id=? WHERE id=?")
            .run(foreign, original.id);
          test.bindings.set(source.id, { ...source, projectId: foreign });
        }
      } else if (failure === "foreign-environment") {
        test.db
          .prepare("UPDATE workflow_runs SET environment_id=? WHERE id=?")
          .run(randomUUID(), original.id);
      } else if (original.authorityBindingId)
        test.bindings.delete(original.authorityBindingId);
      await execute(restarted, pending.id, "failed");
      expect(getRunRequired(test.db, pending.id).resultJson).toBeNull();
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      await test.harness.dispose();
    }
  },
);

it("rejects an idle child's result if its selected profile is revoked while awaiting the worker", async () => {
  const test = fixture();
  const stepVersion = randomUUID();
  let revoked = false;
  vi.spyOn(test.authority, "startWorker").mockResolvedValue({
    threadId: "child",
    bindingId: randomUUID(),
  });
  vi.spyOn(test.authority, "stopWorker").mockResolvedValue(undefined);
  vi.spyOn(test.authority, "getWorker").mockImplementation(async () => {
    revoked = true;
    return {
      threadId: "child",
      status: "idle",
      output: "must not consume",
      error: null,
      idleSequence: 1,
    };
  });
  vi.spyOn(test.authority, "resolveWorkerProfile").mockImplementation(
    (_id, requested) => {
      if (revoked && requested === stepVersion)
        throw new Error("Step profile revoked");
      return {
        profileVersionId: requested ?? test.profileVersionId,
        providerId: "qwen-server",
        model: "pinned-model",
        reasoningLevel: "none",
        permissionMode: "full",
      };
    },
  );
  const { parseAgentOptions } = await import("./validation.js");
  const { toJsonValue } = await import("./json-value.js");
  vi.spyOn(test.authority, "evaluateWorkflow").mockImplementation(
    async (_id, _input, signal, _event, onAgent) => {
      if (!onAgent) throw new Error("Missing scoped agent bridge");
      return onAgent(
        "Inspect project",
        toJsonValue(
          parseAgentOptions({ profileVersionId: stepVersion }),
          "options",
        ),
        signal,
        null,
      );
    },
  );
  const controller = new AbortController();
  let worker: Promise<void> | undefined;
  try {
    const run = await test.service.start({
      ...test.input,
      originThreadId: null,
      profileVersionId: test.profileVersionId,
    });
    test.setCaller(null);
    worker = test.service.runWorker(controller.signal);
    await vi.waitFor(() =>
      expect(getRunRequired(test.db, run.id).status).toBe("failed"),
    );
    expect(getRunRequired(test.db, run.id).resultJson).toBeNull();
    expect(getRunRequired(test.db, run.id).error).toContain("revoked");
  } finally {
    controller.abort();
    await worker;
    await test.harness.dispose();
  }
});

it.each(["step-result", "run-result"] as const)(
  "retains a pending %s during UID maintenance without repeating execution",
  async (boundary) => {
    const test = fixture();
    let paused = false;
    let pauseObserved = false;
    const maintenance = () =>
      Object.assign(new Error("maintenance"), {
        name: "ControlPlaneJobError",
        reason: "maintenance",
      });
    const pause = () => {
      if (!pauseObserved) {
        pauseObserved = true;
        paused = true;
        test.pausedOwners.add(test.owner);
      }
    };
    const withAuthority = test.authority.withAuthority.bind(test.authority);
    vi.spyOn(test.authority, "withAuthority").mockImplementation((id, run) => {
      if (paused) throw maintenance();
      return withAuthority(id, run);
    });
    vi.spyOn(test.authority, "resolveWorkerProfile").mockImplementation(() => {
      if (paused) throw maintenance();
      return {
        profileVersionId: test.profileVersionId,
        providerId: "qwen-server",
        model: "pinned-model",
        reasoningLevel: "none",
        permissionMode: "full",
      };
    });
    const spawn = vi
      .spyOn(test.authority, "startWorker")
      .mockResolvedValue({ threadId: "child", bindingId: randomUUID() });
    vi.spyOn(test.authority, "stopWorker").mockResolvedValue(undefined);
    vi.spyOn(test.authority, "getWorker").mockImplementation(async () => {
      pause();
      return {
        threadId: "child",
        status: "idle",
        output: "safe result",
        error: null,
        idleSequence: 1,
      };
    });
    const { parseAgentOptions } = await import("./validation.js");
    const { toJsonValue } = await import("./json-value.js");
    const evaluate = vi
      .spyOn(test.authority, "evaluateWorkflow")
      .mockImplementation(async (_id, _input, signal, _event, onAgent) => {
        if (boundary === "run-result") {
          pause();
          return "safe result";
        }
        if (!onAgent) throw new Error("Missing scoped agent bridge");
        return onAgent(
          "Inspect project",
          toJsonValue(parseAgentOptions(undefined), "options"),
          signal,
          null,
        );
      });
    const controller = new AbortController();
    let worker: Promise<void> | undefined;
    try {
      const run = await test.service.start({
        ...test.input,
        originThreadId: null,
        profileVersionId: test.profileVersionId,
      });
      test.setCaller(null);
      worker = test.service.runWorker(controller.signal);
      await vi.waitFor(() => expect(paused).toBe(true));
      expect(getRunRequired(test.db, run.id)).toMatchObject({
        status: "running",
        resultJson: null,
      });
      paused = false;
      test.pausedOwners.clear();
      await vi.waitFor(() =>
        expect(getRunRequired(test.db, run.id).status).toBe("succeeded"),
      );
      expect(getRunRequired(test.db, run.id).resultJson).toBe('"safe result"');
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(boundary === "step-result" ? 1 : 0);
    } finally {
      controller.abort();
      await worker;
      await test.harness.dispose();
    }
  },
);

it("inspects native call payloads, actual worker attempts and readable replay provenance without crossing owner scope", async () => {
  const test = fixture();
  try {
    registerManagedWorkflowApi(test.bb, test.service);
    const source = await test.service.start({
      ...test.input,
      args: { task: "inspect" },
    });
    expect(claimQueuedRun(test.db, 4)?.id).toBe(source.id);
    const live = startCall(test.db, {
      runId: source.id,
      callIndex: 0,
      cacheKey: "inspect",
      prompt: "Recorded prompt",
      options: {
        selection: null,
        outputSchema: { type: "object" },
        title: "Convert",
        phase: "Read",
      },
      selection: {
        providerId: "qwen-server",
        model: "model",
        reasoningLevel: "high",
        permissionMode: "full",
      },
      replay: null,
    });
    ownWorker(
      test.db,
      "first-worker",
      source.id,
      live.id,
      source.originThreadId,
    );
    ownWorker(
      test.db,
      "second-worker",
      source.id,
      live.id,
      source.originThreadId,
    );
    attachCallThread(test.db, live.id, "second-worker");
    settleCall(test.db, {
      id: live.id,
      status: "succeeded",
      result: { converted: true },
      error: null,
    });
    const page = await test.harness.callRpc("controlPlaneWorkflowInspection", {
      runId: source.id,
      after: -1,
      limit: 1,
    });
    expect(page).toMatchObject({
      input: { task: "inspect" },
      nextCursor: null,
      callCounts: { total: 1 },
      calls: [{ id: live.id, source: "live", permissionMode: "full" }],
    });
    const detail = await test.harness.callRpc(
      "controlPlaneWorkflowCallInspection",
      { runId: source.id, callId: live.id },
    );
    expect(detail).toMatchObject({
      input: "Recorded prompt",
      outputAvailable: true,
      output: { converted: true },
      workersTruncated: false,
      workers: [
        { threadId: "first-worker", archived: false },
        { threadId: "second-worker", archived: false },
      ],
      replayedFrom: null,
    });
    const resumed = await test.service.start(test.input);
    expect(claimQueuedRun(test.db, 4)?.id).toBe(resumed.id);
    const cached = startCall(test.db, {
      runId: resumed.id,
      callIndex: 0,
      cacheKey: "inspect",
      prompt: "Recorded prompt",
      options: {
        selection: null,
        outputSchema: null,
        title: null,
        phase: null,
      },
      selection: {
        providerId: "qwen-server",
        model: "model",
        reasoningLevel: "high",
        permissionMode: "full",
      },
      replay: { callId: live.id, result: { converted: true } },
    });
    expect(test.service.inspectCallDetail(resumed.id, cached.id)).toMatchObject(
      {
        call: { childThreadId: null, source: "cached" },
        workers: [],
        replayedFrom: { runId: source.id, callId: live.id },
      },
    );
    expect(test.service.inspectCallDetail(source.id, cached.id)).toBeNull();
    test.setCaller(randomUUID());
    expect(
      await test.harness.callRpc("controlPlaneWorkflowInspection", {
        runId: source.id,
        after: -1,
        limit: 1,
      }),
    ).toBeNull();
    expect(
      await test.harness.callRpc("controlPlaneWorkflowCallInspection", {
        runId: source.id,
        callId: live.id,
      }),
    ).toBeNull();
    test.setCaller(test.owner);
    test.bindings.delete(source.authorityBindingId!);
    expect(test.service.inspectCallDetail(resumed.id, cached.id)).toMatchObject(
      { replayedFrom: null, workers: [] },
    );
    test.setCaller(null);
    await expect(
      test.harness.callRpc("controlPlaneWorkflowInspection", {
        runId: resumed.id,
        after: -1,
        limit: 1,
      }),
    ).rejects.toThrow("managed workflow user");
  } finally {
    await test.harness.dispose();
  }
});

it("upgrades the previously deployed native workflow schema without reapplying historical migrations", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "workflows" });
  try {
    const db = bb.storage.database();
    const oldMigrations = migrations.slice(
      0,
      migrations.findIndex((sql) =>
        sql.includes("CREATE INDEX workflow_workers_call_idx"),
      ),
    );
    bb.storage.migrate(db, oldMigrations);
    bb.storage.migrate(db, migrations);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='workflow_workers_call_idx'",
        )
        .get(),
    ).toEqual({ name: "workflow_workers_call_idx" });
    bb.storage.migrate(db, migrations);
  } finally {
    await harness.dispose();
  }
});

it("persists managed evaluator scopes across same-run replay and fences foreign or revoked trace reads", async () => {
  const test = fixture();
  const { runIsolatedWorkflow } = await import("./isolated-evaluator.js");
  const { toJsonValue } = await import("./json-value.js");
  const spawn = vi
    .spyOn(test.authority, "startWorker")
    .mockResolvedValue({ threadId: "child", bindingId: randomUUID() });
  vi.spyOn(test.authority, "stopWorker").mockResolvedValue(undefined);
  vi.spyOn(test.authority, "getWorker").mockResolvedValue({
    threadId: "child",
    status: "idle",
    output: "result",
    error: null,
    idleSequence: 1,
  });
  vi.spyOn(test.authority, "evaluateWorkflow").mockImplementation(
    async (_id, input, signal, onEvent, onAgent) =>
      runIsolatedWorkflow(
        input,
        onEvent,
        signal,
        (prompt, options, childSignal, scopeId) => {
          if (!onAgent) throw new Error("Missing dispatch");
          return onAgent(
            prompt,
            toJsonValue(options, "options"),
            childSignal,
            scopeId,
          );
        },
      ),
  );
  try {
    const child =
      'export const meta={name:"saved-child",description:"Scoped VM"}; return (await parallel([()=>agent("task"),()=>42]))[0];';
    const run = await test.service.start({
      ...test.input,
      originThreadId: null,
      profileVersionId: test.profileVersionId,
      source: `export const meta={name:"parent",description:"trace"};return await workflow({script:${JSON.stringify(child)}});`,
    });
    async function execute() {
      test.setCaller(null);
      const service = createWorkflowService(test.bb, test.db);
      const controller = new AbortController();
      const pending = service.runWorker(controller.signal);
      try {
        await vi.waitFor(() => {
          const row = getRunRequired(test.db, run.id);
          expect(row.error).toBeNull();
          expect(row.status).toBe("succeeded");
        });
      } finally {
        controller.abort();
        await pending;
        test.setCaller(test.owner);
      }
    }
    await execute();
    const old = test.service.trace(run.id, null, -1, 100);
    expect(old?.entries.find((e) => e.kind === "workflow")).toMatchObject({
      name: "saved-child",
      status: "succeeded",
    });
    expect(old?.entries.find((e) => e.kind === "agent")).toMatchObject({
      source: "live",
      callId: expect.any(String),
    });
    test.db
      .prepare("UPDATE workflow_runs SET status='queued' WHERE id=?")
      .run(run.id);
    await execute();
    const next = test.service.trace(run.id, null, -1, 100);
    expect(next?.attempt?.sequence).toBe(2);
    expect(next?.entries.find((e) => e.kind === "agent")?.source).toBe(
      "cached",
    );
    expect(
      test.service
        .trace(run.id, old?.attempt?.id ?? null, -1, 100)
        ?.entries.find((e) => e.kind === "agent")?.source,
    ).toBe("live");
    expect(spawn).toHaveBeenCalledTimes(1);
    test.setCaller(randomUUID());
    expect(test.service.trace(run.id, null, -1, 100)).toBeNull();
    test.setCaller(test.owner);
    if (!run.authorityBindingId) throw new Error("Missing binding");
    test.bindings.delete(run.authorityBindingId);
    expect(
      test.service.trace(run.id, old?.attempt?.id ?? null, -1, 100),
    ).toBeNull();
  } finally {
    await test.harness.dispose();
  }
});
