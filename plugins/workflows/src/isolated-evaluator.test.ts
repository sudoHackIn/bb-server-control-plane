import { expect, it, vi } from "vitest";
import {
  runIsolatedWorkflow,
  readWorkflowFrames,
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
  const frames: unknown[] = [];
  for await (const frame of readWorkflowFrames(bytes())) frames.push(frame);
  expect(frames).toEqual([value]);
  async function* oversized() {
    yield Buffer.alloc(2097153);
  }
  await expect(readWorkflowFrames(oversized()).next()).rejects.toThrow("2 MiB");
});

it("runs normalized agent calls through the injected capability and frames Unicode replies", async () => {
  const call = vi.fn(async (prompt: string) => ({ response: prompt }));
  const result = await runIsolatedWorkflow(
    {
      ...input,
      body: 'return await parallel([() => agent("Привет🙂"), () => agent("second")]);',
    },
    () => {},
    new AbortController().signal,
    call,
  );
  expect(result).toEqual([{ response: "Привет🙂" }, { response: "second" }]);
  expect(call).toHaveBeenCalledTimes(2);
  const data = Buffer.from(
    JSON.stringify({ text: "Привет🙂" }) +
      "\n" +
      JSON.stringify({ text: "界" }) +
      "\n",
  );
  async function* bytes() {
    for (const byte of data) yield Buffer.from([byte]);
  }
  const decoded: unknown[] = [];
  for await (const frame of readWorkflowFrames(bytes())) decoded.push(frame);
  expect(decoded).toEqual([{ text: "Привет🙂" }, { text: "界" }]);
});
