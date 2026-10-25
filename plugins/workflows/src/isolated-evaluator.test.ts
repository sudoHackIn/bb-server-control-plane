import { expect, it, vi } from "vitest";
import type { WorkflowAgentOptions } from "./types.js";
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

it("runs child VMs with shared agent accounting, schemas and no Node globals", async () => {
  const child =
    'export const meta = {name:"child", description:"Child", inputSchema:{type:"number"}, outputSchema:{type:"object"}}; phase("child"); return {reply:await agent("child"), value:args};';
  const calls = vi.fn(async (prompt: string) => prompt);
  const body = `const parent = await agent("parent"); const child = await workflow({script:${JSON.stringify(child)}}, 42); let limited=false; try {await agent("excess");} catch {limited=true;} return {parent,child,limited};`;
  expect(
    await runIsolatedWorkflow(
      { ...input, body, maxAgentCalls: 2 },
      () => {},
      new AbortController().signal,
      calls,
    ),
  ).toEqual({
    parent: "parent",
    child: { reply: "child", value: 42 },
    limited: true,
  });
  expect(calls.mock.calls).toEqual([
    ["parent", expect.anything(), expect.anything()],
    ["child", expect.anything(), expect.anything()],
  ]);
});

it("validates nested schemas and enforces a single child level", async () => {
  for (const [child, args, error] of [
    [
      'export const meta = {name:"child", description:"Child", inputSchema:{type:"number"}}; return args;',
      '"wrong"',
      "args are invalid",
    ],
    [
      'export const meta = {name:"child", description:"Child", outputSchema:{type:"number"}}; return "wrong";',
      "null",
      "result is invalid",
    ],
    [
      'export const meta = {name:"child", description:"Child"}; return await workflow("grandchild");',
      "null",
      "depth limit exceeded",
    ],
  ]) {
    await expect(
      runIsolatedWorkflow(
        {
          ...input,
          body: `return await workflow({script:${JSON.stringify(child)}}, ${args});`,
        },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(error);
  }
});

it("bounds concurrent child VMs and total nested invocations independently of agent calls", async () => {
  let active = 0,
    peak = 0;
  const loader = vi.fn(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return 'export const meta = {name:"child", description:"Child"}; return budget().agentCalls;';
  });
  const signal = new AbortController().signal;
  expect(
    await runIsolatedWorkflow(
      {
        ...input,
        body: 'return await parallel([() => workflow("one"), () => workflow("two"), () => workflow("three"), () => workflow("four")]);',
      },
      () => {},
      signal,
      undefined,
      loader,
    ),
  ).toEqual([0, 0, 0, 0]);
  expect(peak).toBe(2);
  await expect(
    runIsolatedWorkflow(
      {
        ...input,
        maxAgentCalls: 1,
        body: 'await workflow("one"); return await workflow("two");',
      },
      () => {},
      signal,
      undefined,
      loader,
    ),
  ).rejects.toThrow("invocation budget exceeded");
});

it("propagates parent cancellation through a nested VM to its agent", async () => {
  const controller = new AbortController();
  const agent = vi.fn(
    (_prompt: string, _options: WorkflowAgentOptions, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new Error("Cancelled agent")),
          { once: true },
        ),
      ),
  );
  const child =
    'export const meta = {name:"child",description:"Cancellation"}; return await agent("pending");';
  const loader = vi.fn(async () => child);
  const run = runIsolatedWorkflow(
    {
      ...input,
      maxConcurrentAgents: 1,
      body: 'return await parallel([() => workflow("one"), () => workflow("two"), () => workflow("three")]);',
    },
    () => {},
    controller.signal,
    agent,
    loader,
  );
  const outcome = expect(run).rejects.toThrow(/cancelled/iu);
  await vi.waitFor(() => expect(agent).toHaveBeenCalledTimes(1));
  controller.abort();
  await outcome;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(loader).toHaveBeenCalledTimes(1);
});
