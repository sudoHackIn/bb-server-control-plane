import { z } from "zod";
import { StringDecoder } from "node:string_decoder";
import { toJsonValue } from "./json-value.js";
import { executeWorkflowScript } from "./runtime.js";
import type { JsonValue } from "./types.js";

const inputSchema = z
  .object({
    body: z.string().max(131072),
    args: z.unknown().transform((value) => toJsonValue(value, "Workflow args")),
    maxAgentCalls: z.number().int().min(1).max(1000),
    maxConcurrentAgents: z.number().int().min(1).max(64),
    timeoutMs: z.number().int().min(1).max(604800000),
  })
  .strict();

export async function runIsolatedWorkflow(
  input: unknown,
  emit: (event: { type: "log" | "phase"; value: string }) => void,
  signal: AbortSignal,
): Promise<JsonValue> {
  const parsed = inputSchema.parse(input);
  return executeWorkflowScript({
    body: parsed.body,
    args: parsed.args,
    signal,
    limits: {
      maxAgentCalls: parsed.maxAgentCalls,
      maxConcurrentAgents: parsed.maxConcurrentAgents,
    },
    capabilities: {
      async agent() {
        throw new Error(
          "Managed workflow agent dispatch requires scoped worker integration",
        );
      },
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
    },
  });
}

export async function readIsolatedWorkflowInput(
  chunks: AsyncIterable<Uint8Array>,
): Promise<unknown> {
  const decoder = new StringDecoder("utf8");
  let size = 0;
  let input = "";
  for await (const chunk of chunks) {
    size += chunk.byteLength;
    if (size > 2097152) throw new Error("Workflow input exceeds 2 MiB");
    input += decoder.write(Buffer.from(chunk));
  }
  input += decoder.end();
  const value: unknown = JSON.parse(input);
  return value;
}
