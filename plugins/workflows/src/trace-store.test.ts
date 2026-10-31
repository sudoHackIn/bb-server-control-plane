import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  migrations,
  createRun,
  claimQueuedRun,
  startCall,
  settleCall,
  recoverInterruptedRuns,
} from "./data.js";
import { createStoredWorkflowTrace, readWorkflowTrace } from "./trace-store.js";
import { createTraceEmitter, traceEventSchema } from "./execution-trace.js";
import { runIsolatedWorkflow } from "./isolated-evaluator.js";
import { DEFAULT_WORKFLOW_SETTINGS } from "./settings.js";

function createFixture(oldSchema = false) {
  const { bb, harness } = createFakePluginHost({ pluginId: "workflows" });
  const db = bb.storage.database();
  bb.storage.migrate(db, oldSchema ? migrations.slice(0, -1) : migrations);
  const run = createRun(db, {
    projectId: "project",
    environmentId: "env",
    originThreadId: null,
    originProvider: "qwen",
    originModel: "model",
    originReasoningLevel: "none",
    originPermissionMode: "full",
    name: "trace",
    source:
      'export const meta={name:"trace",description:"trace"}; return null;',
    sourceHash: "hash",
    argsJson: "null",
    settingsJson: JSON.stringify(DEFAULT_WORKFLOW_SETTINGS),
    resumedFromRunId: null,
  });
  claimQueuedRun(db, 1);
  return { bb, harness, db, run };
}
it("persists concurrent nested VM scopes and explicit parallel boundaries without guessing branch membership", async () => {
  const { db, run, harness } = createFixture();
  try {
    const trace = createStoredWorkflowTrace(db, run.id);
    const child =
      'export const meta={name:"child",description:"test"}; return await parallel([async()=>{await agent("inside-"+args);return args},()=>{throw Error("branch failed")}]);';
    let index = 0;
    const value = await runIsolatedWorkflow(
      {
        captureTrace: true,
        body: `return await parallel([()=>workflow({script:${JSON.stringify(child)}},"A"),()=>workflow({script:${JSON.stringify(child)}},"B"),()=>agent("outside")]);`,
        args: null,
        maxAgentCalls: 10,
        maxConcurrentAgents: 3,
        timeoutMs: 10000,
      },
      (event) => {
        if (event.type === "trace")
          trace.observe(traceEventSchema.parse(event.value));
      },
      new AbortController().signal,
      async (prompt, options, signal, scopeId) => {
        const callIndex = index++;
        const linked = trace.call(callIndex, scopeId);
        const call = startCall(db, {
          runId: run.id,
          callIndex,
          cacheKey: prompt,
          prompt,
          options,
          selection: {
            providerId: "qwen",
            model: "model",
            reasoningLevel: "none",
            permissionMode: "full",
          },
          replay: null,
        });
        linked.admitted(call);
        await new Promise((resolve) =>
          setTimeout(resolve, prompt.endsWith("A") ? 10 : 1),
        );
        expect(signal.aborted).toBe(false);
        settleCall(db, {
          id: call.id,
          status: "succeeded",
          result: prompt,
          error: null,
        });
        linked.finish("succeeded");
        return prompt;
      },
    );
    trace.finish("succeeded");
    expect(value).toEqual([["A", null], ["B", null], "outside"]);
    const page = readWorkflowTrace(db, run.id, null, -1, 100);
    expect(page?.attempt).toMatchObject({
      sequence: 1,
      status: "succeeded",
      truncated: false,
    });
    const scopes = page?.entries.filter((e) => e.kind === "workflow") ?? [];
    expect(scopes).toHaveLength(2);
    expect(
      scopes.every(
        (e) => e.sourceHash?.length === 64 && e.status === "succeeded",
      ),
    ).toBe(true);
    const calls = page?.entries.filter((e) => e.kind === "agent") ?? [];
    expect(calls).toHaveLength(3);
    expect(calls.filter((e) => e.scopeId === null)).toHaveLength(1);
    expect(
      new Set(calls.filter((e) => e.scopeId !== null).map((e) => e.scopeId)),
    ).toEqual(new Set(scopes.map((e) => e.nodeId)));
    expect(
      page?.entries.filter(
        (e) => e.kind === "parallel" && e.failedBranches === 1,
      ),
    ).toHaveLength(2);
    const first = readWorkflowTrace(db, run.id, trace.id, -1, 2);
    expect(first?.entries).toHaveLength(2);
    const second = readWorkflowTrace(
      db,
      run.id,
      trace.id,
      first?.nextCursor ?? -1,
      2,
    );
    expect(second?.entries[0]?.index).toBeGreaterThan(
      first?.entries[1]?.index ?? 0,
    );
    expect(readWorkflowTrace(db, run.id, randomUUID(), -1, 20)).toBeNull();
    expect(readWorkflowTrace(db, "foreign", trace.id, -1, 20)).toBeNull();
  } finally {
    await harness.dispose();
  }
});
it("retains interrupted attempts and never binds an old trace to a replaced native call", async () => {
  const { db, run, harness } = createFixture();
  try {
    const old = createStoredWorkflowTrace(db, run.id);
    old.observe({
      op: "start",
      id: 1,
      scopeId: null,
      kind: "workflow",
      name: "old child",
      branchCount: null,
    });
    const linked = old.call(0, 1);
    const args = {
      runId: run.id,
      callIndex: 0,
      cacheKey: "original",
      prompt: "old",
      options: {
        selection: null,
        outputSchema: null,
        title: null,
        phase: null,
      },
      selection: {
        providerId: "qwen",
        model: "model",
        reasoningLevel: "none",
        permissionMode: "full",
      },
      replay: null,
    };
    linked.admitted(startCall(db, args));
    recoverInterruptedRuns(db);
    expect(
      readWorkflowTrace(db, run.id, old.id, -1, 20)?.entries.every(
        (e) => e.status === "interrupted",
      ),
    ).toBe(true);
    claimQueuedRun(db, 1);
    const next = createStoredWorkflowTrace(db, run.id);
    const replacement = startCall(db, { ...args, cacheKey: "replaced" });
    next.call(0, null).admitted(replacement);
    expect(
      readWorkflowTrace(db, run.id, old.id, -1, 20)?.entries.find(
        (e) => e.kind === "agent",
      )?.callId,
    ).toBeNull();
    expect(readWorkflowTrace(db, run.id, null, -1, 20)?.attempt?.sequence).toBe(
      2,
    );
    expect(
      readWorkflowTrace(db, run.id, next.id, -1, 20)?.entries[0]?.callId,
    ).toBe(replacement.id);
  } finally {
    await harness.dispose();
  }
});
it("bounds trace capture without changing evaluator results and marks omitted scopes as incomplete", async () => {
  const { db, run, harness } = createFixture();
  try {
    const trace = createStoredWorkflowTrace(db, run.id);
    const emitter = createTraceEmitter(trace.observe);
    const active = emitter.start(null, "workflow", "active");
    for (let n = 0; n < 1100; n++) {
      const id = emitter.start(null, "parallel", "empty", 0);
      emitter.end(id, "succeeded", null, 0);
    }
    const missing = emitter.start(null, "workflow", "omitted");
    trace.call(0, missing).finish("failed", "admission denied");
    trace.finish("succeeded");
    const page = readWorkflowTrace(db, run.id, null, -1, 100);
    expect(page?.attempt?.truncated).toBe(true);
    expect(page?.entries.find((e) => e.nodeId === active)?.status).toBe(
      "incomplete",
    );
    const events: unknown[] = [];
    const result = await runIsolatedWorkflow(
      {
        captureTrace: true,
        body: 'for(let n=0;n<1100;n++) await parallel([]); return "completed";',
        args: null,
        maxAgentCalls: 1,
        maxConcurrentAgents: 1,
        timeoutMs: 5000,
      },
      (e) => events.push(e),
      new AbortController().signal,
    );
    expect(result).toBe("completed");
    expect(
      events.filter(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          "type" in e &&
          e.type === "trace",
      ),
    ).toHaveLength(2049);
  } finally {
    await harness.dispose();
  }
});
it("rejects invented parents and completions while admitting a legacy run with no structure", async () => {
  const { db, run, harness } = createFixture();
  try {
    expect(readWorkflowTrace(db, run.id, null, -1, 20)).toMatchObject({
      attempt: null,
      entries: [],
    });
    const trace = createStoredWorkflowTrace(db, run.id);
    expect(() => trace.call(0, 42)).toThrow("scope");
    expect(() =>
      trace.observe({
        op: "end",
        id: 42,
        status: "succeeded",
        error: null,
        failedBranches: null,
      }),
    ).toThrow("Unknown");
    trace.observe({
      op: "start",
      id: 1,
      scopeId: null,
      kind: "parallel",
      name: "parallel",
      branchCount: 2,
    });
    expect(() =>
      trace.observe({
        op: "start",
        id: 2,
        scopeId: 1,
        kind: "workflow",
        name: "fake child",
        branchCount: null,
      }),
    ).toThrow("scope");
    expect(() =>
      trace.observe({
        op: "end",
        id: 1,
        status: "succeeded",
        error: null,
        failedBranches: 3,
      }),
    ).toThrow("completion");
  } finally {
    await harness.dispose();
  }
});

it("upgrades a phase-92 database without inventing history and cascades recorded structure with native retention", async () => {
  const { db, bb, run, harness } = createFixture(true);
  try {
    bb.storage.migrate(db, migrations);
    expect(readWorkflowTrace(db, run.id, null, -1, 20)?.attempt).toBeNull();
    const trace = createStoredWorkflowTrace(db, run.id);
    trace.observe({
      op: "start",
      id: 1,
      scopeId: null,
      kind: "parallel",
      name: "test",
      branchCount: 0,
    });
    trace.observe({
      op: "end",
      id: 1,
      status: "succeeded",
      error: null,
      failedBranches: 0,
    });
    trace.finish("succeeded");
    db.prepare("DELETE FROM workflow_runs WHERE id=?").run(run.id);
    expect(
      db.prepare("SELECT count(*) AS n FROM workflow_trace_attempts").get(),
    ).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT count(*) AS n FROM workflow_trace_entries").get(),
    ).toEqual({ n: 0 });
  } finally {
    await harness.dispose();
  }
});
