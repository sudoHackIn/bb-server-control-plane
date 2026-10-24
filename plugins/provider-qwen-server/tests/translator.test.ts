import { test } from "vitest";
import assert from "node:assert/strict";
import {
  threadDeltaSchema,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_assembleCapturedThreadEvents } from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { SDKMessage } from "@qwen-code/sdk";
import { QwenDeltaTranslator } from "../src/translator.js";
import { assistant } from "./helpers.js";
import { z } from "zod";

const capturedItemSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  aggregatedOutput: z.string().optional(),
  status: z.string().optional(),
  exitCode: z.number().optional(),
  presentation: z
    .object({ title: z.string().optional(), detail: z.string().optional() })
    .optional(),
  path: z.string().optional(),
  mode: z.string().optional(),
  queries: z.array(z.string()).optional(),
  resultText: z.string().optional(),
  arguments: z.unknown().optional(),
  tool: z.string().optional(),
});
test("partials and final snapshots yield one assembled message", () => {
  const deltas: ThreadDelta[] = [{ kind: "turn.open", providerTurnId: "turn" }];
  const translator = new QwenDeltaTranslator((delta) =>
    deltas.push({ ...delta, providerTurnId: "turn" }),
  );
  const partial = (event: unknown) =>
    translator.accept({
      type: "stream_event",
      uuid: "partial",
      session_id: "native",
      parent_tool_use_id: null,
      event,
    } as SDKMessage);
  partial({
    type: "message_start",
    message: { id: "msg", role: "assistant", model: "test" },
  });
  partial({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  partial({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Hel" },
  });
  const final = assistant("native", "Hello");
  assert.equal(final.type, "assistant");
  if (final.type === "assistant") final.message.id = "msg";
  translator.accept(final);
  translator.finish("completed");
  deltas.push({
    kind: "turn.boundary",
    providerTurnId: "turn",
    status: "completed",
  });
  for (const delta of deltas) threadDeltaSchema.parse(delta);
  const events = experimental_assembleCapturedThreadEvents(
    [{ method: "thread/delta", params: { threadId: "bb", deltas } }],
    "qwen",
  );
  const completed = events.filter((event) => event.type === "item/completed");
  assert.equal(completed.length, 1);
  assert.equal(capturedItemSchema.parse(completed[0]?.item).text, "Hello");
});
test("unknown tools preserve exact names, args, results and errors", () => {
  const deltas: ThreadDelta[] = [];
  const translator = new QwenDeltaTranslator((delta) => deltas.push(delta));
  const toolUse = assistant("native", "");
  if (toolUse.type !== "assistant") throw new Error("Invalid fixture");
  const input = {
    command: "npm test",
    timeout: 12,
    description: "Check changes",
    nested: { value: [1, 2] },
  };
  toolUse.message.content = [
    { type: "tool_use", id: "call1", name: "custom_tool", input },
  ];
  translator.accept(toolUse);
  translator.accept(toolUse);
  translator.accept({
    type: "user",
    uuid: "result",
    session_id: "native",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call1",
          content: "exit 1",
          is_error: true,
        },
      ],
    },
  });
  translator.finish("completed");
  for (const delta of deltas) threadDeltaSchema.parse(delta);
  assert.equal(deltas.filter((d) => d.kind === "item.open").length, 1);
  const closed = deltas.find((d) => d.kind === "item.close");
  assert.equal(closed?.status, "failed");
  assert.deepEqual(closed?.item.type === "tool" && closed.item.args, input);
  assert.equal(closed?.item.type === "tool" && closed.item.result, "exit 1");
  assert.equal(closed?.item.type === "tool" && closed.item.tool, "custom_tool");
});
test("native tools assemble into BB command, file and search cards", () => {
  const deltas: ThreadDelta[] = [{ kind: "turn.open", providerTurnId: "turn" }];
  const translator = new QwenDeltaTranslator(
    (delta) => deltas.push({ ...delta, providerTurnId: "turn" }),
    "/workspace",
  );
  const calls = [
    [
      "shell",
      "run_shell_command",
      { command: "npm test", directory: "app", description: "Check changes" },
    ],
    ["read", "read_file", { file_path: "/workspace/README.md" }],
    ["grep", "grep_search", { pattern: "TODO", path: "/workspace/src" }],
    ["glob", "glob", { pattern: "**/*.ts" }],
    ["ls", "list_directory", { path: "/workspace" }],
    ["web", "web_search", { query: "Qwen SDK" }],
    [
      "edit",
      "edit",
      { file_path: "/workspace/a.ts", old_string: "a", new_string: "b" },
    ],
    ["mcp", "mcp__custom__read_file", { file_path: "remote" }],
    ["invalid", "read_file", { unknown: true }],
  ] as const;
  const message = assistant("native", "");
  if (message.type !== "assistant") throw new Error("Invalid fixture");
  message.message.content = calls.map(([id, name, input]) => ({
    type: "tool_use",
    id,
    name,
    input,
  }));
  translator.accept(message);
  translator.accept(message);
  translator.accept({
    type: "user",
    uuid: "results",
    session_id: "native",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: calls.map(([id]) => ({
        type: "tool_result",
        tool_use_id: id,
        content: [
          { type: "text", text: id === "shell" ? "test failed" : "result" },
        ],
        is_error: id === "shell",
      })),
    },
  });
  translator.finish("completed");
  deltas.push({
    kind: "turn.boundary",
    providerTurnId: "turn",
    status: "completed",
  });
  for (const delta of deltas) threadDeltaSchema.parse(delta);
  const events = experimental_assembleCapturedThreadEvents(
    [{ method: "thread/delta", params: { threadId: "bb", deltas } }],
    "qwen",
  );
  const items = events
    .filter((event) => event.type === "item/completed")
    .map((event) => capturedItemSchema.parse(event.item));
  assert.deepEqual(
    items.map((item) => item.type),
    [
      "commandExecution",
      "fileRead",
      "search",
      "search",
      "search",
      "webSearch",
      "toolCall",
      "toolCall",
      "toolCall",
    ],
  );
  assert.equal(items[0].command, "npm test");
  assert.equal(items[0].cwd, "/workspace/app");
  assert.equal(items[0].aggregatedOutput, "test failed");
  assert.equal(items[0].status, "failed");
  assert.equal(items[0].exitCode, undefined);
  assert.equal(items[0].presentation?.title, "Check changes");
  assert.equal(items[1].path, "/workspace/README.md");
  assert.deepEqual(
    items.slice(2, 5).map((item) => item.mode),
    ["content", "path", "list"],
  );
  assert.deepEqual(items[5].queries, ["Qwen SDK"]);
  assert.equal(items[5].resultText, "result");
  assert.equal(items[6].presentation?.detail, "/workspace/a.ts");
  assert.deepEqual(items[6].arguments, calls[6][2]);
  assert.equal(items[7].tool, "mcp__custom__read_file");
});
test("specialized command output is bounded and pending cards close on interruption", () => {
  const deltas: ThreadDelta[] = [];
  const translator = new QwenDeltaTranslator(
    (delta) => deltas.push(delta),
    "/workspace",
  );
  const message = assistant("native", "");
  if (message.type !== "assistant") throw new Error("Invalid fixture");
  message.message.content = [
    {
      type: "tool_use",
      id: "shell",
      name: "run_shell_command",
      input: { command: "echo output" },
    },
    {
      type: "tool_use",
      id: "pending",
      name: "read_file",
      input: { file_path: "a.ts" },
    },
  ];
  translator.accept(message);
  translator.accept({
    type: "user",
    uuid: "result",
    session_id: "native",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "shell",
          content: "x".repeat(150000),
        },
      ],
    },
  });
  translator.finish("interrupted");
  for (const delta of deltas) threadDeltaSchema.parse(delta);
  const closed = deltas.filter((delta) => delta.kind === "item.close");
  assert.equal(closed.length, 2);
  assert(
    closed[0].item.type === "command" &&
      closed[0].item.aggregatedOutput?.endsWith("[truncated]"),
  );
  assert.equal(closed[1].status, "interrupted");
  assert.equal(closed[1].item.type, "fileRead");
});
test("unfinished tools are settled on interruption and oversized output is marked", () => {
  const deltas: ThreadDelta[] = [];
  const translator = new QwenDeltaTranslator((d) => deltas.push(d));
  const tool = assistant("native", "");
  if (tool.type !== "assistant") throw new Error("Invalid fixture");
  tool.message.content = [
    {
      type: "tool_use",
      id: "big",
      name: "custom_tool",
      input: { value: "x".repeat(150000) },
    },
  ];
  translator.accept(tool);
  translator.finish("interrupted");
  const closed = deltas.find((d) => d.kind === "item.close");
  assert.equal(closed?.status, "interrupted");
  assert.equal(
    closed?.item.type === "tool" &&
      z.object({ truncated: z.boolean() }).parse(closed.item.args).truncated,
    true,
  );
});
test("Qwen reuses index zero after thinking and changes the final text message ID", () => {
  const deltas: ThreadDelta[] = [];
  const translator = new QwenDeltaTranslator((delta) => deltas.push(delta));
  const partial = (event: unknown) =>
    translator.accept({
      type: "stream_event",
      uuid: "partial",
      session_id: "native",
      parent_tool_use_id: null,
      event,
    } as SDKMessage);
  partial({
    type: "message_start",
    message: { id: "thinking-message", role: "assistant", model: "test" },
  });
  partial({
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "" },
  });
  partial({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "Plan" },
  });
  const thought = assistant("native", "");
  if (thought.type !== "assistant") throw new Error("Invalid fixture");
  thought.message.id = "thinking-message";
  thought.message.content = [
    { type: "thinking", thinking: "Plan", signature: "" },
  ];
  translator.accept(thought);
  partial({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  partial({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Answer" },
  });
  const answer = assistant("native", "Answer");
  if (answer.type !== "assistant") throw new Error("Invalid fixture");
  answer.message.id = "final-message";
  translator.accept(answer);
  translator.accept(answer);
  translator.finish("completed");
  for (const delta of deltas) threadDeltaSchema.parse(delta);
  const closed = deltas.filter((d) => d.kind === "item.close");
  assert.equal(closed.length, 2);
  assert.deepEqual(
    closed.map((d) => d.item.type),
    ["reasoning", "agentMessage"],
  );
  const message = closed.find((d) => d.item.type === "agentMessage");
  assert.equal(
    message?.item.type === "agentMessage" && message.item.text,
    "Answer",
  );
});
