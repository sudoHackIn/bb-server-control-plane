import { randomUUID } from "node:crypto";
import type { SDKMessage, QueryOptions } from "@qwen-code/sdk";
import {
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  type BridgeExecutionOptions,
} from "@get-bb/plugin-sdk/provider-bridge";
import { createQwenBridge, type QueryFactory } from "../src/bridge.js";
import { InputQueue } from "../src/input-queue.js";
import { z } from "zod";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
export const options: BridgeExecutionOptions = {
  permissionMode: "full",
  permissionScope: "full",
  permissionEscalation: null,
  approvalReviewer: null,
};
export function assistant(sessionId: string, text: string): SDKMessage {
  return {
    type: "assistant",
    uuid: randomUUID(),
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: randomUUID(),
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}
export function result(sessionId: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    uuid: randomUUID(),
    session_id: sessionId,
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: "",
    usage: { input_tokens: 1, output_tokens: 1 },
    permission_denials: [],
  };
}
export function fakeSdk() {
  const calls: QueryOptions[] = [];
  const factory: QueryFactory = ({ prompt, options }) => {
    calls.push(options);
    const output = new InputQueue<SDKMessage>();
    const id = options.resume ?? options.sessionId!;
    void (async () => {
      try {
        for await (const message of prompt) {
          if (message.message.content === "crash") {
            output.close();
            return;
          }
          output.push(assistant(id, "Hello"));
          if (message.message.content !== "wait") output.push(result(id));
        }
      } catch {
        output.close();
      }
    })();
    return {
      initialized: Promise.resolve(),
      getSessionId: () => id,
      getAvailableModels: async () => ({ models: [] }),
      close: async () => output.close(),
      interrupt: async () => output.close(),
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
    };
  };
  return { factory, calls };
}
export async function until<T>(
  read: () => T | undefined,
  timeoutMs = 2000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for bridge output");
}
export function harness(
  queryFactory: QueryFactory = fakeSdk().factory,
  timeoutMs = 2000,
) {
  const messages: unknown[] = [];
  const responseSchema = z.object({
    id: z.number(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number(),
        message: z.string(),
        data: z
          .object({ recovery: z.object({ kind: z.string() }).optional() })
          .optional(),
      })
      .optional(),
  });
  const notificationSchema = z.object({
    method: z.literal("thread/delta"),
    params: z.object({
      threadId: z.string(),
      deltas: z.array(threadDeltaSchema),
    }),
  });
  const bridge = createQwenBridge({
    queryFactory,
    write: (line) => messages.push(JSON.parse(line)),
  });
  let counter = 0;
  async function rpc(method: string, params: unknown) {
    const id = ++counter;
    bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return until(() => {
      for (const message of messages) {
        const parsed = responseSchema.safeParse(message);
        if (parsed.success && parsed.data.id === id) return parsed.data;
      }
      return undefined;
    }, timeoutMs);
  }
  const notifications = () =>
    messages.flatMap((message) => {
      const parsed = notificationSchema.safeParse(message);
      return parsed.success ? [parsed.data] : [];
    });
  const deltas = () =>
    notifications().flatMap((message) => message.params.deltas);
  const initialize = () =>
    rpc("initialize", {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      grammarVersions: [2, 3],
      client: { name: "test", version: "1" },
    });
  const start = async () =>
    z.object({ result: z.object({ providerThreadId: z.string() }) }).parse(
      await rpc("thread/start", {
        threadId: "bb-test",
        cwd: "/tmp",
        options,
        instructionMode: "append",
      }),
    );
  const turn = (providerThreadId: string, text: string, extra = {}) =>
    rpc("turn/start", {
      threadId: "bb-test",
      providerThreadId,
      input: [{ type: "text", text }],
      clientRequestId: "creq_abcdefghjk",
      options,
      ...extra,
    });
  return {
    bridge,
    messages,
    notifications,
    rpc,
    deltas,
    initialize,
    start,
    turn,
  };
}
