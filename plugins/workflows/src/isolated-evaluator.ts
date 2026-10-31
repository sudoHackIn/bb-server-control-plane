import {
  createTraceEmitter,
  type WorkflowEvaluatorEvent,
} from "./execution-trace.js";
import { z } from "zod";
import { StringDecoder } from "node:string_decoder";
import { toJsonValue } from "./json-value.js";
import { parseWorkflowSource } from "./parser.js";
import { validateValue } from "./schema.js";
import { executeWorkflowScript } from "./runtime.js";
import type {
  JsonValue,
  WorkflowCapabilities,
  WorkflowReference,
} from "./types.js";

const inputSchema = z
  .object({
    captureTrace: z.boolean().default(false),
    body: z.string().max(131072),
    args: z.unknown().transform((value) => toJsonValue(value, "Workflow args")),
    maxAgentCalls: z.number().int().min(1).max(1000),
    maxConcurrentAgents: z.number().int().min(1).max(64),
    timeoutMs: z.number().int().min(1).max(604800000),
  })
  .strict();

export async function runIsolatedWorkflow(
  input: unknown,
  emit: (event: WorkflowEvaluatorEvent) => void,
  signal: AbortSignal,
  agent?: (
    prompt: string,
    options: Parameters<WorkflowCapabilities["agent"]>[1],
    signal: AbortSignal,
    scopeId: number | null,
  ) => Promise<JsonValue>,
  loadWorkflow?: (reference: WorkflowReference) => Promise<string>,
): Promise<JsonValue> {
  const parsed = inputSchema.parse(input);
  const trace = parsed.captureTrace
    ? createTraceEmitter((value) => emit({ type: "trace", value }))
    : null;
  let nestedCalls = 0;
  const nested = new Set<Promise<void>>();
  const capabilities: WorkflowCapabilities = {
    async workflow(reference, args, context) {
      const traceId = trace?.start(null, "workflow", "Nested workflow") ?? null;
      try {
        if (++nestedCalls > parsed.maxAgentCalls)
          throw new Error("Nested workflow invocation budget exceeded");
        while (nested.size >= parsed.maxConcurrentAgents)
          await Promise.race(nested);
        if (context.signal.aborted)
          throw new Error("Nested workflow cancelled");
        const task = (async () => {
          const source = loadWorkflow
            ? await loadWorkflow(reference)
            : typeof reference !== "string" && "script" in reference
              ? reference.script
              : (() => {
                  throw new Error(
                    "Managed workflow file resolution is unavailable",
                  );
                })();
          if (context.signal.aborted)
            throw new Error("Nested workflow cancelled");
          const child = parseWorkflowSource(source);
          if (traceId !== null)
            trace?.source(traceId, child.metadata.name, source);
          if (child.metadata.inputSchema !== null) {
            const validation = validateValue(child.metadata.inputSchema, args);
            if (!validation.valid)
              throw new Error(
                `Nested workflow args are invalid: ${validation.error}`,
              );
          }
          const result = await executeWorkflowScript({
            args,
            body: child.body,
            capabilities: scopedCapabilities(traceId),
            signal: context.signal,
            scheduler: context.scheduler,
            depth: context.depth,
          });
          if (child.metadata.outputSchema !== null) {
            const validation = validateValue(
              child.metadata.outputSchema,
              result,
            );
            if (!validation.valid)
              throw new Error(
                `Nested workflow result is invalid: ${validation.error}`,
              );
          }
          return result;
        })();
        const settled = task
          .then(
            () => undefined,
            () => undefined,
          )
          .finally(() => nested.delete(settled));
        nested.add(settled);
        const result = await task;
        if (traceId !== null) trace?.end(traceId, "succeeded");
        return result;
      } catch (error) {
        if (traceId !== null)
          trace?.end(
            traceId,
            context.signal.aborted ? "cancelled" : "failed",
            error instanceof Error ? error.message : "Nested workflow failed",
          );
        throw error;
      }
    },

    agent: (prompt, options, callSignal) =>
      dispatchAgent(prompt, options, callSignal, null),
    log(value) {
      if (Buffer.byteLength(value) > 8192)
        throw new Error("Workflow log exceeds 8192 bytes");
      emit({ type: "log", value });
    },
    phase(value) {
      if (Buffer.byteLength(value) > 1024)
        throw new Error("Workflow phase exceeds 1024 bytes");
      emit({ type: "phase", value });
    },
  };
  function dispatchAgent(
    prompt: string,
    options: Parameters<WorkflowCapabilities["agent"]>[1],
    callSignal: AbortSignal,
    scopeId: number | null,
  ) {
    if (!agent)
      throw new Error(
        "Managed workflow agent dispatch requires scoped worker integration",
      );
    return agent(prompt, options, callSignal, scopeId);
  }
  function scopedCapabilities(scopeId: number | null): WorkflowCapabilities {
    return {
      ...capabilities,
      agent: (prompt, options, callSignal) =>
        dispatchAgent(prompt, options, callSignal, scopeId),
      ...(trace ? { parallelTrace: trace.parallel(scopeId) } : {}),
    };
  }
  try {
    const result = await executeWorkflowScript({
      body: parsed.body,
      args: parsed.args,
      signal,
      capabilities: scopedCapabilities(null),
      limits: {
        maxAgentCalls: parsed.maxAgentCalls,
        maxConcurrentAgents: parsed.maxConcurrentAgents,
      },
    });
    if (signal.aborted) throw new Error("Workflow cancelled");
    return result;
  } finally {
    await Promise.allSettled(nested);
  }
}

export async function* readWorkflowFrames(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<unknown> {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let count = 0;
  for await (const chunk of chunks) {
    buffer += decoder.write(Buffer.from(chunk));
    if (Buffer.byteLength(buffer) > 2097152)
      throw new Error("Workflow input frame exceeds 2 MiB");
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      if (++count > 1001)
        throw new Error("Workflow input frame count exceeded");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const value: unknown = JSON.parse(line);
      yield value;
    }
  }
  buffer += decoder.end();
  if (buffer) {
    const value: unknown = JSON.parse(buffer);
    yield value;
  }
}
