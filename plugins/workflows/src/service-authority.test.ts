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
import { createRun, migrations, settleRun } from "./data.js";
import { createWorkflowService } from "./service.js";
import { DEFAULT_WORKFLOW_SETTINGS } from "./settings.js";

function fixture() {
  const owner = randomUUID();
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
    get userId() {
      return caller;
    },
    canReadProject: (id) => id === origin.projectId,
    readOrigin: () => origin,
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
    owner,
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
