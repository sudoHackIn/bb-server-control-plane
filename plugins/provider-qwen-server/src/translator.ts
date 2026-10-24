import type { SDKMessage, ContentBlock } from "@qwen-code/sdk";
import type {
  ThreadDelta,
  DeltaItemKey,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  toolDisplay,
  completeTool,
  outputText,
  type ToolDisplay,
} from "./tool-items.js";
type ItemDelta = Extract<
  ThreadDelta,
  {
    kind: "item.open" | "item.close" | "item.textDelta" | "item.textClose";
  }
>;
export class QwenDeltaTranslator {
  private messageIds = new Map<string, string>();
  private blockSerial = 0;
  private streamBlocks = new Map<
    string,
    Map<
      number,
      {
        id: string;
        thinking: boolean;
        claimed: boolean;
      }
    >
  >();
  private snapshotAliases = new Map<string, string>();
  private texts = new Map<
    string,
    {
      key: DeltaItemKey;
      text: string;
      thinking: boolean;
    }
  >();
  private tools = new Map<
    string,
    ToolDisplay & {
      key: DeltaItemKey;
      started: number;
    }
  >();
  private seen = new Set<string>();
  constructor(
    private emit: (delta: ItemDelta) => void,
    private cwd = ".",
  ) {}
  private key(id: string, parent?: string | null): DeltaItemKey {
    return { providerItemId: id, ...(parent ? { parentRef: parent } : {}) };
  }
  private append(
    id: string,
    text: string,
    thinking: boolean,
    parent?: string | null,
  ) {
    let entry = this.texts.get(id);
    if (!entry) {
      entry = { key: this.key(id, parent), text: "", thinking };
      this.texts.set(id, entry);
      this.emit({
        kind: "item.open",
        key: entry.key,
        item: thinking
          ? { type: "reasoning", summary: [], content: [] }
          : { type: "agentMessage", text: "" },
      });
    }
    entry.text += text;
    if (text)
      this.emit({
        kind: "item.textDelta",
        key: entry.key,
        channel: thinking ? "reasoningText" : "agentMessage",
        text,
      });
  }
  private snapshot(id: string, block: ContentBlock, parent?: string | null) {
    if (block.type === "text" || block.type === "thinking") {
      const text = block.type === "text" ? block.text : block.thinking;
      const previous = this.texts.get(id)?.text ?? "";
      if (!this.texts.has(id) || text.startsWith(previous)) {
        this.append(
          id,
          text.slice(previous.length),
          block.type === "thinking",
          parent,
        );
      }
    } else if (block.type === "tool_use" && !this.seen.has(block.id)) {
      this.seen.add(block.id);
      const key = this.key(block.id, parent);
      const display = toolDisplay(block.name, block.input, this.cwd);
      this.tools.set(block.id, { key, ...display, started: Date.now() });
      this.emit({ kind: "item.open", key, ...display });
    } else if (block.type === "tool_result") {
      const tool = this.tools.get(block.tool_use_id);
      if (!tool) return;
      this.emit({
        kind: "item.close",
        key: tool.key,
        status: block.is_error ? "failed" : "completed",
        presentation: tool.presentation,
        resultText: outputText(block.content ?? ""),
        item: completeTool(
          tool.item,
          block.content ?? "",
          !!block.is_error,
          Date.now() - tool.started,
        ),
      });
      this.tools.delete(block.tool_use_id);
    }
  }
  accept(message: SDKMessage) {
    if (message.type === "stream_event") {
      const event = message.event;
      const parent = message.parent_tool_use_id ?? "";
      if (event.type === "message_start") {
        this.messageIds.set(parent, event.message.id);
        this.streamBlocks.set(parent, new Map());
      }
      const messageId = this.messageIds.get(parent);
      if (event.type === "content_block_start" && messageId) {
        if (
          event.content_block.type === "text" ||
          event.content_block.type === "thinking"
        ) {
          const id = `${messageId}:stream:${this.blockSerial++}`;
          const blocks = this.streamBlocks.get(parent) ?? new Map();
          blocks.set(event.index, {
            id,
            thinking: event.content_block.type === "thinking",
            claimed: false,
          });
          this.streamBlocks.set(parent, blocks);
          this.snapshot(id, event.content_block, message.parent_tool_use_id);
        }
      }
      if (event.type === "content_block_delta" && messageId) {
        const delta = event.delta;
        if (delta.type === "text_delta" || delta.type === "thinking_delta") {
          const blocks = this.streamBlocks.get(parent) ?? new Map();
          let block = blocks.get(event.index);
          if (!block || block.thinking !== (delta.type === "thinking_delta")) {
            block = {
              id: `${messageId}:stream:${this.blockSerial++}`,
              thinking: delta.type === "thinking_delta",
              claimed: false,
            };
            blocks.set(event.index, block);
            this.streamBlocks.set(parent, blocks);
          }
          this.append(
            block.id,
            delta.type === "text_delta" ? delta.text : delta.thinking,
            delta.type === "thinking_delta",
            message.parent_tool_use_id,
          );
        }
      }
    } else if (message.type === "assistant") {
      message.message.content.forEach((block, index) => {
        const snapshotId = `${message.message.id}:${index}:${block.type}`;
        let id = this.snapshotAliases.get(snapshotId);
        if (!id && (block.type === "text" || block.type === "thinking")) {
          const streamed = this.streamBlocks
            .get(message.parent_tool_use_id ?? "")
            ?.get(index);
          const text = block.type === "text" ? block.text : block.thinking;
          if (
            streamed &&
            !streamed.claimed &&
            streamed.thinking === (block.type === "thinking") &&
            text.startsWith(this.texts.get(streamed.id)?.text ?? "")
          ) {
            id = streamed.id;
            streamed.claimed = true;
          }
        }
        id ??= snapshotId;
        this.snapshotAliases.set(snapshotId, id);
        this.snapshot(id, block, message.parent_tool_use_id);
      });
    } else if (
      message.type === "user" &&
      Array.isArray(message.message.content)
    ) {
      message.message.content.forEach((block, index) =>
        this.snapshot(
          `${message.uuid}:${index}`,
          block,
          message.parent_tool_use_id,
        ),
      );
    } else if (
      message.type === "result" &&
      !message.is_error &&
      message.result &&
      ![...this.texts.values()].some((entry) => !entry.thinking)
    ) {
      this.append(`${message.uuid}:result`, message.result, false);
    }
  }
  finish(status: "completed" | "failed" | "interrupted") {
    for (const entry of this.texts.values()) {
      this.emit({
        kind: "item.textClose",
        key: entry.key,
        channel: entry.thinking ? "reasoningText" : "agentMessage",
        text: entry.text,
      });
      this.emit({
        kind: "item.close",
        key: entry.key,
        status,
        item: entry.thinking
          ? { type: "reasoning", summary: [], content: [entry.text] }
          : { type: "agentMessage", text: entry.text },
      });
    }
    for (const tool of this.tools.values()) {
      this.emit({
        kind: "item.close",
        key: tool.key,
        status: status === "completed" ? "failed" : status,
        presentation: tool.presentation,
        item:
          tool.item.type === "tool"
            ? { ...tool.item, error: "Tool ended without a result" }
            : tool.item,
      });
    }
    this.texts.clear();
    this.tools.clear();
  }
}
