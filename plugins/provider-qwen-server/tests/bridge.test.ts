import { test } from "vitest";
import assert from "node:assert/strict";
import {
  experimental_runBridgeConformance,
  experimental_formatConformanceReport,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { createQwenBridge } from "../src/bridge.js";
import { fakeSdk, harness, options, until } from "./helpers.js";
test("published BB bridge conformance", async () => {
  const messages: unknown[] = [];
  const bridge = createQwenBridge({
    queryFactory: fakeSdk().factory,
    write: (line) => messages.push(JSON.parse(line)),
  });
  const report = await experimental_runBridgeConformance({
    providerId: "qwen",
    timeoutMs: 2000,
    transport: {
      send: (line) => bridge.handleLine(line),
      takeMessages: () => messages.splice(0),
      close: () => bridge.onClose?.(),
    },
    session: {
      cwd: "/tmp",
      promptInput: [{ type: "text", text: "hello", mentions: [] }],
      interruptiblePromptInput: [{ type: "text", text: "wait", mentions: [] }],
      zeroWorkPromptInput: [{ type: "text", text: "", mentions: [] }],
      options,
    },
  });
  assert.equal(
    report.passed,
    true,
    experimental_formatConformanceReport(report),
  );
});
test("multi-turn reuses SDK query, release/resume restores native identity", async () => {
  const sdk = fakeSdk();
  const h = harness(sdk.factory);
  try {
    await h.initialize();
    const {
      result: { providerThreadId },
    } = await h.start();
    for (let n = 1; n <= 2; n++) {
      await h.turn(providerThreadId, "hello");
      await until(
        () =>
          h.deltas().filter((d) => d.kind === "turn.boundary").length === n ||
          undefined,
      );
    }
    assert.equal(sdk.calls.length, 1);
    await h.rpc("thread/stop", {
      threadId: "bb-test",
      providerThreadId,
      intent: "release",
      activeTurnId: null,
    });
    await h.rpc("thread/resume", {
      threadId: "bb-test",
      providerThreadId,
      cwd: "/tmp",
      options,
      instructionMode: "append",
    });
    await h.turn(providerThreadId, "again");
    await until(
      () =>
        h.deltas().filter((d) => d.kind === "turn.boundary").length === 3 ||
        undefined,
    );
    assert.equal(sdk.calls[1].resume, providerThreadId);
    for (const delta of h.deltas()) threadDeltaSchema.parse(delta);
  } finally {
    await h.bridge.onClose?.();
  }
});
test("interrupt settles once and fences late events; the next turn resumes", async () => {
  const sdk = fakeSdk();
  const h = harness(sdk.factory);
  try {
    await h.initialize();
    const {
      result: { providerThreadId },
    } = await h.start();
    await h.turn(providerThreadId, "wait");
    await until(() => h.deltas().find((d) => d.kind === "item.textDelta"));
    await h.rpc("thread/stop", {
      threadId: "bb-test",
      providerThreadId,
      intent: "interrupt",
      activeTurnId: null,
    });
    assert.equal(
      h.deltas().filter((d) => d.kind === "turn.boundary").length,
      1,
    );
    assert.equal(
      h.deltas().find((d) => d.kind === "turn.boundary")?.status,
      "interrupted",
    );
    await h.turn(providerThreadId, "again");
    await until(
      () =>
        h.deltas().filter((d) => d.kind === "turn.boundary").length === 2 ||
        undefined,
    );
    assert.equal(sdk.calls[1].resume, providerThreadId);
  } finally {
    await h.bridge.onClose?.();
  }
});
test("unexpected EOF fails the active turn", async () => {
  const h = harness(fakeSdk().factory);
  try {
    await h.initialize();
    const {
      result: { providerThreadId },
    } = await h.start();
    await h.turn(providerThreadId, "crash");
    const boundary = await until(() =>
      h.deltas().find((d) => d.kind === "turn.boundary"),
    );
    assert.equal(boundary.status, "failed");
    assert.match(boundary.error?.message ?? "", /stream closed/);
  } finally {
    await h.bridge.onClose?.();
  }
});
test("stop waits for process cleanup before reporting interruption", async () => {
  const sdk = fakeSdk();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stopping = false;
  const h = harness((config) => {
    const query = sdk.factory(config);
    return {
      ...query,
      close: async () => {
        stopping = true;
        await gate;
        await query.close();
      },
    };
  });
  try {
    await h.initialize();
    const {
      result: { providerThreadId },
    } = await h.start();
    await h.turn(providerThreadId, "wait");
    await until(() =>
      h.deltas().find((event) => event.kind === "item.textDelta"),
    );
    const stopped = h.rpc("thread/stop", {
      threadId: "bb-test",
      providerThreadId,
      intent: "interrupt",
      activeTurnId: null,
    });
    await until(() => stopping || undefined);
    assert.equal(
      h.deltas().some((event) => event.kind === "turn.boundary"),
      false,
    );
    release();
    await stopped;
    assert.equal(
      h.deltas().find((event) => event.kind === "turn.boundary")?.status,
      "interrupted",
    );
  } finally {
    release();
    await h.bridge.onClose?.();
  }
});
test("rejects unsupported policy, attachments and malformed params without running SDK", async () => {
  const sdk = fakeSdk();
  const h = harness(sdk.factory);
  try {
    await h.initialize();
    assert.equal((await h.rpc("unknown", {})).error?.code, -32601);
    assert.equal((await h.rpc("thread/start", {})).error?.code, -32602);
    assert.equal(
      (
        await h.rpc("thread/start", {
          threadId: "bad",
          cwd: "/tmp",
          instructionMode: "append",
          options: {
            permissionMode: "accept-edits",
            permissionScope: "workspace",
            approvalReviewer: "user",
            permissionEscalation: "ask",
          },
        })
      ).error?.code,
      -32602,
    );
    const {
      result: { providerThreadId },
    } = await h.start();
    assert.equal(
      (
        await h.turn(providerThreadId, "", {
          input: [{ type: "localImage", path: "/tmp/image.png" }],
        })
      ).error?.code,
      -32602,
    );
    assert.equal(sdk.calls.length, 0);
  } finally {
    await h.bridge.onClose?.();
  }
});
