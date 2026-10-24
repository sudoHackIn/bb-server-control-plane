import { randomUUID } from "node:crypto";
import {
  type Query,
  type QueryOptions,
  type SDKUserMessage,
} from "@qwen-code/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createBridgeIo,
  createPendingToolCallTracker,
  decodeBridgeJsonRpcResponse,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  modelListParamsSchema,
  threadStartParamsSchema,
  threadResumeParamsSchema,
  threadStopParamsSchema,
  threadDiscardParamsSchema,
  turnStartParamsSchema,
  type BridgeExecutionOptions,
  type BridgeErrorData,
  type DynamicTool,
  type PromptInput,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { InputQueue } from "./input-queue.js";
import { modelsFromQwen, controlProbeInput } from "./models.js";
import { QwenDeltaTranslator } from "./translator.js";
import { isAuthType, backendOptionsForHost } from "./config.js";
import { validatePermissionMode } from "./permissions.js";
import { authNotice, initializationWait, AUTH_TIMEOUT_MS } from "./auth.js";
export type QwenQuery = AsyncIterable<import("@qwen-code/sdk").SDKMessage> &
  Pick<
    Query,
    | "initialized"
    | "close"
    | "interrupt"
    | "getSessionId"
    | "getAvailableModels"
  >;
export type QueryFactory = (config: {
  threadId?: string;
  prompt: AsyncIterable<SDKUserMessage>;
  options: QueryOptions;
}) => QwenQuery;
type ActiveTurn = {
  id: string;
  translator: QwenDeltaTranslator;
};
type Session = {
  threadId: string;
  providerThreadId: string;
  cwd: string;
  instructionMode: "append" | "replace";
  dynamicTools: DynamicTool[];
  disallowedTools: string[];
  resume: boolean;
  disconnecting?: Promise<void>;
  active?: ActiveTurn;
  live?: {
    query: QwenQuery;
    input: InputQueue<SDKUserMessage>;
    abort: AbortController;
    signature: string;
  };
};
class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: BridgeErrorData,
  ) {
    super(message);
  }
}
const failure = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function parse<T>(
  schema: {
    safeParse(value: unknown):
      | {
          success: true;
          data: T;
        }
      | {
          success: false;
        };
  },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RpcError(-32602, "Invalid params");
  return result.data;
}
function validateOptions(options: BridgeExecutionOptions) {
  try {
    validatePermissionMode(options);
  } catch (error) {
    throw new RpcError(-32602, failure(error));
  }
  if (options.promptMode)
    throw new RpcError(-32602, "Plan mode is not implemented");
  const authType = options.providerOptions?.authType;
  if (
    authType !== undefined &&
    authType !== "configured" &&
    !isAuthType(authType)
  ) {
    throw new RpcError(-32602, "Unsupported Qwen authentication type");
  }
}
export function promptText(input: PromptInput[]): string {
  if (input.some((part) => part.type !== "text")) {
    throw new RpcError(
      -32602,
      "Qwen MVP accepts text input only; attachments are not implemented",
    );
  }
  return input
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n\n");
}
export function createQwenBridge({
  write,
  queryFactory,
}: {
  write?: (line: string) => void;
  queryFactory: QueryFactory;
}) {
  const io = createBridgeIo({ write });
  const sessions = new Map<string, Session>();
  const probes = new Set<{
    query: QwenQuery;
    abort: AbortController;
  }>();
  const tracker = createPendingToolCallTracker({
    sendToolCall: (request) => io.send(request),
  });
  let initialized = false;
  let closed = false;
  let closing: Promise<void> | null = null;
  function delta(session: Session, ...deltas: ThreadDelta[]) {
    io.send({
      jsonrpc: "2.0",
      method: "thread/delta",
      params: { threadId: session.threadId, deltas },
    });
  }
  function finish(
    session: Session,
    status: "completed" | "failed" | "interrupted",
    error?: string,
  ) {
    const active = session.active;
    if (!active) return;
    session.active = undefined;
    tracker.resolvePendingToolCalls(session, error ?? "Qwen turn ended");
    active.translator.finish(status);
    delta(session, {
      kind: "turn.boundary",
      providerTurnId: active.id,
      status,
      ...(error ? { error: { message: error } } : {}),
    });
  }
  async function disconnect(session: Session) {
    if (session.disconnecting) return session.disconnecting;
    const live = session.live;
    session.live = undefined;
    if (!live) return;
    tracker.resolvePendingToolCalls(session, "Qwen session closed");
    live.input.close();
    live.abort.abort();
    const stopping = live.query.close();
    session.disconnecting = stopping;
    try {
      await stopping;
    } finally {
      if (session.disconnecting === stopping) session.disconnecting = undefined;
    }
  }
  function mcpServer(session: Session) {
    const server = new McpServer(
      { name: "bb", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    const tools = session.dynamicTools.filter(
      (tool) => !session.disallowedTools.includes(tool.name),
    );
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }));
    server.server.setRequestHandler(
      CallToolRequestSchema,
      async ({ params }) => {
        if (
          !session.active ||
          !tools.some((tool) => tool.name === params.name)
        ) {
          return {
            content: [
              { type: "text", text: "Unknown tool or inactive Qwen turn" },
            ],
            isError: true,
          };
        }
        const result = await tracker.forwardToolCall({
          scope: session,
          threadId: session.threadId,
          providerThreadId: session.providerThreadId,
          toolName: params.name,
          arguments: params.arguments ?? {},
        });
        return {
          content: result.contentBlocks ?? [
            { type: "text", text: result.content },
          ],
          isError: result.isError === true,
        };
      },
    );
    return { type: "sdk" as const, name: "bb", instance: server };
  }
  async function ensureQuery(
    session: Session,
    options: BridgeExecutionOptions,
  ) {
    const active = session.active;
    const signature = JSON.stringify(options);
    if (session.live?.signature === signature) return session.live;
    await disconnect(session);
    if (
      closed ||
      sessions.get(session.threadId) !== session ||
      !active ||
      session.active !== active
    )
      return;
    const input = new InputQueue<SDKUserMessage>();
    const abort = new AbortController();
    const executable =
      typeof options.providerOptions?.executable === "string" &&
      options.providerOptions.executable.trim()
        ? options.providerOptions.executable.trim()
        : "qwen";
    const backend = await backendOptionsForHost(options);
    const permissions: QueryOptions = { permissionMode: "yolo" };
    if (
      closed ||
      sessions.get(session.threadId) !== session ||
      session.active !== active
    )
      return;
    const qwen = queryFactory({
      threadId: session.threadId,
      prompt: input,
      options: {
        cwd: session.cwd,
        ...backend,
        pathToQwenExecutable: executable,
        ...permissions,
        ...(session.resume
          ? { resume: session.providerThreadId }
          : { sessionId: session.providerThreadId }),
        ...(isAuthType(options.providerOptions?.authType)
          ? { authType: options.providerOptions.authType }
          : {}),
        ...(options.instructions?.trim()
          ? {
              systemPrompt:
                session.instructionMode === "replace"
                  ? options.instructions
                  : {
                      type: "preset" as const,
                      preset: "qwen_code" as const,
                      append: options.instructions,
                    },
            }
          : {}),
        excludeTools: session.disallowedTools,
        includePartialMessages: true,
        abortController: abort,
        timeout: { controlRequest: AUTH_TIMEOUT_MS },
        ...(session.dynamicTools.length
          ? { mcpServers: { bb: mcpServer(session) } }
          : {}),
      },
    });
    const live = { query: qwen, input, abort, signature };
    session.live = live;
    const startup = initializationWait(qwen.initialized, abort.signal);
    const authNotices = new Set<string>();
    void (async () => {
      try {
        for await (const message of qwen) {
          if (session.live !== live) break;
          if (
            message.session_id &&
            message.session_id !== session.providerThreadId
          ) {
            throw new Error("Qwen returned an unexpected session ID");
          }
          const notice = authNotice(message);
          if (notice) {
            startup.authRequired();
            const active = session.active;
            if (
              active &&
              !authNotices.has(notice.key) &&
              authNotices.size < 5
            ) {
              authNotices.add(notice.key);
              const key = { providerItemId: `qwen-auth:${randomUUID()}` };
              const item = { type: "agentMessage" as const, text: notice.text };
              delta(
                session,
                { kind: "item.open", key, item, providerTurnId: active.id },
                {
                  kind: "item.close",
                  key,
                  item,
                  status: "completed",
                  providerTurnId: active.id,
                },
              );
            }
            continue;
          }
          session.active?.translator.accept(message);
          if (message.type === "result") {
            session.resume = true;
            finish(
              session,
              message.is_error ? "failed" : "completed",
              message.is_error
                ? (message.error?.message ?? message.subtype)
                : undefined,
            );
          }
        }
        if (session.live === live) {
          finish(session, "failed", "Qwen stream closed before a result");
          await disconnect(session);
        }
      } catch (error) {
        if (session.live === live) {
          finish(session, "failed", failure(error));
          await disconnect(session);
        }
      }
    })();
    await startup.wait;
    return session.live === live ? live : undefined;
  }
  async function request(method: string, params: unknown): Promise<unknown> {
    if (method === "initialize") {
      const value = parse(initializeParamsSchema, params);
      if (
        value.protocolVersion !== PROVIDER_BRIDGE_PROTOCOL_VERSION ||
        value.grammarVersions[0] > 3 ||
        value.grammarVersions[1] < 3
      ) {
        throw new RpcError(
          -32602,
          "Qwen provider requires bridge protocol 2 and grammar version 3",
        );
      }
      initialized = true;
      return {
        protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        capabilities: {
          grammarVersions: [3, 3],
          sessionRestore: true,
          fork: "none",
          approvalEnforcedBy: "provider",
          steerMode: "queue",
          skills: { configure: false },
        },
      };
    }
    const schemas = new Map<
      string,
      {
        safeParse(value: unknown): {
          success: boolean;
        };
      }
    >([
      ["model/list", modelListParamsSchema],
      ["thread/start", threadStartParamsSchema],
      ["thread/resume", threadResumeParamsSchema],
      ["turn/start", turnStartParamsSchema],
      ["thread/stop", threadStopParamsSchema],
      ["thread/discard", threadDiscardParamsSchema],
    ]);
    const schema = schemas.get(method);
    if (!schema) throw new RpcError(-32601, `Method not supported: ${method}`);
    if (!schema.safeParse(params).success)
      throw new RpcError(-32602, "Invalid params");
    if (!initialized)
      throw new RpcError(-32000, "Initialize the Qwen provider first");
    if (method === "model/list") {
      const value = parse(modelListParamsSchema, params);
      const providerOptions =
        value.providerOptions &&
        typeof value.providerOptions === "object" &&
        !Array.isArray(value.providerOptions)
          ? (value.providerOptions as Record<string, unknown>)
          : {};
      const options: BridgeExecutionOptions = {
        permissionMode: "auto",
        permissionScope: "workspace",
        approvalReviewer: "automatic",
        permissionEscalation: "deny",
        providerOptions,
      };
      const backend = await backendOptionsForHost(options);
      const executable =
        typeof providerOptions.executable === "string" &&
        providerOptions.executable
          ? providerOptions.executable
          : "qwen";
      const abort = new AbortController();
      const probe = queryFactory({
        prompt: controlProbeInput(abort.signal),
        options: {
          ...backend,
          cwd: value.cwd,
          pathToQwenExecutable: executable,
          abortController: abort,
          ...(isAuthType(providerOptions.authType)
            ? { authType: providerOptions.authType }
            : {}),
          permissionMode: "plan",
          safeMode: true,
          canUseTool: async () => ({
            behavior: "deny",
            message: "Model discovery cannot execute tools",
          }),
        },
      });
      const pending = { query: probe, abort };
      probes.add(pending);
      const reader = (async () => {
        for await (const message of probe) {
          const notice = authNotice(message);
          if (notice)
            throw new RpcError(-32000, notice.text, {
              recovery: {
                kind: "authRequired",
                message: notice.text,
                retryable: true,
              },
            });
        }
      })();
      void reader.catch(() => {});
      const timeout = setTimeout(() => abort.abort(), 15000);
      try {
        await Promise.race([probe.initialized, reader]);
        const catalog = await Promise.race([
          probe.getAvailableModels(),
          reader,
        ]);
        return {
          models: modelsFromQwen(catalog ?? null, backend.model),
          selectedOnlyModels: [],
        };
      } finally {
        probes.delete(pending);
        clearTimeout(timeout);
        abort.abort();
        await probe.close().catch(() => {});
      }
    }
    if (method === "thread/start" || method === "thread/resume") {
      const value =
        method === "thread/start"
          ? parse(threadStartParamsSchema, params)
          : parse(threadResumeParamsSchema, params);
      validateOptions(value.options);
      if (sessions.has(value.threadId))
        throw new RpcError(-32000, "Thread already has a Qwen session");
      const session: Session = {
        threadId: value.threadId,
        providerThreadId:
          method === "thread/resume" &&
          typeof value.providerThreadId === "string"
            ? value.providerThreadId
            : randomUUID(),
        cwd: value.cwd,
        instructionMode: value.instructionMode,
        dynamicTools: [],
        disallowedTools: value.disallowedTools ?? [],
        resume: method === "thread/resume",
      };
      sessions.set(session.threadId, session);
      delta(
        session,
        { kind: "session.reset" },
        { kind: "thread.identity", providerThreadId: session.providerThreadId },
      );
      return {
        providerThreadId: session.providerThreadId,
        sessionRestorable: true,
      };
    }
    if (method === "turn/start") {
      const value = parse(turnStartParamsSchema, params);
      validateOptions(value.options);
      const text = promptText(value.input);
      const session = findSession(value);
      if (session.active)
        throw new RpcError(
          -32000,
          "Qwen turn is already running; queue the message",
        );
      const id = randomUUID();
      const translator = new QwenDeltaTranslator(
        (event) => delta(session, { ...event, providerTurnId: id }),
        session.cwd,
      );
      session.active = { id, translator };
      delta(
        session,
        { kind: "turn.open", providerTurnId: id },
        {
          kind: "input.accepted",
          clientRequestId: value.clientRequestId,
          providerTurnId: id,
        },
      );
      void ensureQuery(session, value.options)
        .then((live) => {
          if (live && session.active?.id === id) {
            live.input.push({
              type: "user",
              session_id: session.providerThreadId,
              uuid: randomUUID(),
              parent_tool_use_id: null,
              message: { role: "user", content: text },
            });
            session.resume = true;
          }
        })
        .catch(async (error: unknown) => {
          if (session.active?.id === id) {
            finish(session, "failed", failure(error));
            await disconnect(session);
          }
        });
      return {};
    }
    if (method === "thread/stop") {
      const value = parse(threadStopParamsSchema, params);
      const session = findSession(value);
      await disconnect(session);
      finish(session, "interrupted");
      if (value.intent === "release") sessions.delete(session.threadId);
      return {};
    }
    if (method === "thread/discard") {
      const session = findSession(parse(threadDiscardParamsSchema, params));
      await disconnect(session);
      finish(session, "interrupted");
      sessions.delete(session.threadId);
      return {};
    }
    throw new RpcError(-32601, `Method not supported: ${method}`);
  }
  function findSession(value: { threadId: string; providerThreadId: string }) {
    const session = sessions.get(value.threadId);
    if (!session || session.providerThreadId !== value.providerThreadId)
      throw new RpcError(-32000, "Unknown Qwen session");
    return session;
  }
  function handleLine(line: string) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (!value || typeof value !== "object") return;
    const message = value as Record<string, unknown>;
    if (message.jsonrpc !== "2.0") return;
    if (typeof message.method !== "string") {
      const response = decodeBridgeJsonRpcResponse(value);
      if (response) tracker.handleToolCallResponse(response);
      return;
    }
    if (typeof message.id !== "number" && typeof message.id !== "string")
      return;
    const id = message.id;
    if (closed) {
      io.sendError(id, -32000, "Qwen bridge is closed");
      return;
    }
    void request(message.method, message.params).then(
      (result) => io.sendResult(id, result),
      (error: unknown) =>
        io.sendError(
          id,
          error instanceof RpcError ? error.code : -32000,
          failure(error),
          error instanceof RpcError ? error.data : undefined,
        ),
    );
  }
  function close() {
    closing ??= (async () => {
      closed = true;
      const stops: Promise<void>[] = [];
      for (const probe of probes) {
        probe.abort.abort();
        stops.push(probe.query.close());
      }
      probes.clear();
      for (const session of sessions.values())
        stops.push(
          disconnect(session).then(() => {
            finish(session, "interrupted");
          }),
        );
      const results = await Promise.allSettled(stops);
      sessions.clear();
      if (results.some((result) => result.status === "rejected"))
        throw new Error(
          "Qwen shutdown could not confirm every session stopped",
        );
    })();
    return closing;
  }
  return experimental_defineProviderBridge({
    handleLine,
    onClose: close,
    onSigterm: close,
    onSigint: close,
  });
}
