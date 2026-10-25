import { expect, it, vi } from "vitest";
import {
  runIsolatedWorkflow,
  readIsolatedWorkflowInput,
} from "./isolated-evaluator.js";

const input = {
  body: 'phase("compute"); log("started"); return {sum: args.values.reduce((a,b) => a+b, 0), process: typeof process, require: typeof require};',
  args: { values: [2, 3, 5] },
  maxAgentCalls: 10,
  maxConcurrentAgents: 2,
  timeoutMs: 5000,
};

it("evaluates deterministic workflow capabilities without exposing Node or silently spawning workers", async () => {
  const emit = vi.fn();
  const signal = new AbortController().signal;
  expect(await runIsolatedWorkflow(input, emit, signal)).toEqual({
    sum: 10,
    process: "undefined",
    require: "undefined",
  });
  expect(emit.mock.calls.map(([event]) => event)).toEqual([
    { type: "phase", value: "compute" },
    { type: "log", value: "started" },
  ]);
  await expect(
    runIsolatedWorkflow(
      { ...input, body: 'return await agent("work");' },
      emit,
      signal,
    ),
  ).rejects.toThrow("scoped worker integration");
  await expect(
    runIsolatedWorkflow(
      { ...input, body: 'return await workflow("nested");' },
      emit,
      signal,
    ),
  ).rejects.toThrow();
});

it("rejects command overrides, oversized input and output events, and pre-cancelled work", async () => {
  const signal = new AbortController().signal;
  await expect(
    runIsolatedWorkflow({ ...input, command: "node" }, () => {}, signal),
  ).rejects.toThrow();
  await expect(
    runIsolatedWorkflow(
      { ...input, body: "x".repeat(131073) },
      () => {},
      signal,
    ),
  ).rejects.toThrow();
  await expect(
    runIsolatedWorkflow(
      { ...input, body: 'log("x".repeat(8193)); return null;' },
      () => {},
      signal,
    ),
  ).rejects.toThrow("8192 bytes");
  await expect(
    runIsolatedWorkflow(
      { ...input, body: 'phase("x".repeat(1025)); return null;' },
      () => {},
      signal,
    ),
  ).rejects.toThrow("1024 bytes");
  const controller = new AbortController();
  controller.abort();
  await expect(
    runIsolatedWorkflow(input, () => {}, controller.signal),
  ).rejects.toThrow("cancelled");
});

it("decodes Unicode across arbitrary pipe chunks and bounds raw input bytes", async () => {
  const value = { ...input, args: { text: "Привет🙂界" } };
  const encoded = Buffer.from(JSON.stringify(value));
  async function* bytes() {
    for (const byte of encoded) yield Buffer.from([byte]);
  }
  expect(await readIsolatedWorkflowInput(bytes())).toEqual(value);
  async function* oversized() {
    yield Buffer.alloc(2097153);
  }
  await expect(readIsolatedWorkflowInput(oversized())).rejects.toThrow("2 MiB");
});
