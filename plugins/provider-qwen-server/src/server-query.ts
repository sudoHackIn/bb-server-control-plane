import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import {
  Query,
  type QueryOptions,
  type SDKUserMessage,
  type Transport,
  type EffortTier,
} from "@qwen-code/sdk";
import {
  resolveServiceContext,
  type ServiceContext,
} from "./service-context.js";
import {
  delegatedMcpServer,
  selectDelegatedTools,
  type DelegatedTools,
} from "./delegated-mcp.js";
import { profilePolicy } from "./profile-policy.js";
import type { QwenQuery } from "./bridge.js";
const exec = promisify(execFile);
const helper = "/opt/bb-control-plane/launcher/helper.py";
class ProcessTransport implements Transport {
  private readonly jobId = randomUUID();
  private stop: Promise<void> | null = null;
  readonly child;
  readonly lines;
  private readonly exited: Promise<void>;
  private finished = false;
  private closing = false;
  exitError: Error | null = null;
  get isReady() {
    return !this.finished && !this.closing;
  }
  constructor(
    options: QueryOptions,
    readonly context: ServiceContext,
    delegatedNames: string[],
  ) {
    if (!options.cwd) throw new Error("A registered workspace is required");
    const registry = {
      baseUrl: process.env.QWEN_SERVER_BASE_URL,
      apiKeyEnv: "NEURALDEAP_KEY",
    };
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--channel=SDK",
      "--include-partial-messages",
      ...(options.resume
        ? ["--resume", options.resume]
        : options.sessionId
          ? ["--session-id", options.sessionId]
          : []),
      ...(registry.baseUrl ? ["--auth-type", "openai"] : []),
    ];
    const policy = profilePolicy(context, options, delegatedNames);
    const bootstrap = Buffer.from(
      JSON.stringify({ ...policy, arguments: [...args, ...policy.arguments] }),
    );
    if (bootstrap.length > 1048576)
      throw new Error("Execution policy is too large");
    const key = registry.apiKeyEnv
      ? process.env[registry.apiKeyEnv]
      : undefined;
    if (registry.baseUrl && !key)
      throw new Error("Server backend credential is unavailable");
    this.child = spawn(
      "/usr/bin/sudo",
      [
        "-n",
        "--",
        helper,
        "launch-policy",
        context.id,
        String(context.uid),
        this.jobId,
        context.cwd,
      ],
      {
        cwd: "/tmp",
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          LANG: "C.UTF-8",
          ...(key ? { OPENAI_API_KEY: key } : {}),
          ...(registry.baseUrl ? { OPENAI_BASE_URL: registry.baseUrl } : {}),
        },
        stdio: "pipe",
      },
    );
    this.lines = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    this.child.stderr.resume();
    this.child.stdin.on("error", (error) => {
      if (!this.closing) this.exitError = error;
    });
    this.child.stdin.write(`BB_AGENT_POLICY ${bootstrap.length}\n`);
    this.child.stdin.write(bootstrap);
    this.exited = new Promise((resolve) => {
      this.child.once("error", (error) => {
        this.exitError = error;
        this.finished = true;
        this.lines.close();
        resolve();
      });
      this.child.once("close", (code, signal) => {
        if (!this.closing && (code !== 0 || signal))
          this.exitError ??= new Error(
            `Server Qwen exited: code=${code}, signal=${signal}`,
          );
        this.finished = true;
        resolve();
      });
    });
  }
  write(message: string) {
    if (!this.isReady)
      throw this.exitError ?? new Error("Qwen transport is closed");
    this.child.stdin.write(message.endsWith("\n") ? message : `${message}\n`);
  }
  async *readMessages(): AsyncGenerator<unknown> {
    for await (const line of this.lines) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error("Invalid Qwen protocol stdout (payload omitted)");
      }
      yield value;
    }
    await this.waitForExit();
  }
  endInput() {
    this.child.stdin?.end();
  }
  async waitForExit() {
    await this.exited;
    if (this.exitError) throw this.exitError;
  }
  async close() {
    if (this.stop) return this.stop;
    if (this.finished) return;
    this.closing = true;
    this.endInput();
    this.stop = (async () => {
      await exec(
        "/usr/bin/sudo",
        [
          "-n",
          "--",
          helper,
          "stop",
          this.context.id,
          String(this.context.uid),
          this.jobId,
        ],
        {
          env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
          timeout: 12000,
          maxBuffer: 16384,
        },
      );
      await this.exited;
    })();
    return this.stop;
  }
}
export function serverQuery({
  prompt,
  options,
  threadId,
  delegatedTools,
}: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: QueryOptions;
  threadId?: string;
  delegatedTools?: DelegatedTools;
}): QwenQuery {
  if (!threadId)
    throw new Error("A server-owned BB thread is required to launch Qwen");
  let transport: ProcessTransport | undefined;
  let query: Query | undefined;
  let closing = false;
  let stopped: Promise<void> | undefined;
  const ready = (async () => {
    if (!options.cwd) throw new Error("Registered cwd required");
    const socket = process.env.QWEN_SERVER_CONTEXT_SOCKET;
    if (!socket) throw new Error("Context service socket required");
    const context = await resolveServiceContext(
      socket,
      options.cwd,
      options.resume ?? options.sessionId ?? "",
      threadId,
    );
    const tools = selectDelegatedTools(
      context,
      delegatedTools?.tools ?? [],
      options.excludeTools ?? [],
    );
    const delegatedNames = tools.map((tool) => tool.name);
    profilePolicy(context, options, delegatedNames);
    if (closing) throw new Error("Transport closed before launch");
    transport = new ProcessTransport(options, context, delegatedNames);
    const level = context.profile.definition.reasoningLevel;
    const effort: EffortTier | undefined =
      level === "low" ||
      level === "medium" ||
      level === "high" ||
      level === "xhigh" ||
      level === "max"
        ? level
        : undefined;
    query = new Query(transport, {
      ...options,
      ...(tools.length && delegatedTools
        ? {
            mcpServers: {
              bb: delegatedMcpServer({
                context,
                adapter: delegatedTools,
                tools,
                excluded: options.excludeTools ?? [],
                authorize: () =>
                  resolveServiceContext(
                    socket,
                    context.cwd,
                    context.sessionId,
                    context.threadId,
                  ),
              }),
            },
          }
        : {}),
      model: context.profile.definition.model,
      effort: effort ?? "low",
      timeout: {
        ...options.timeout,
        streamClose: options.timeout?.streamClose ?? 1000,
      },
    });
    await query.initialized;
    if (closing) throw new Error("Transport closed before initialization");
    const status = query.getInitialEffortStatus();
    if (
      !status ||
      status.override ||
      (effort
        ? !status.applied
        : status.applied || status.reason !== "thinking may be disabled")
    )
      throw new Error("Selected profile reasoning was not applied");
    const active = query;
    void active.streamInput(prompt).catch(() => {
      void close().catch(() => undefined);
    });
    return active;
  })();
  async function close() {
    closing = true;
    stopped ??= (async () => {
      await transport?.close();
      await ready.catch(() => undefined);
      await query?.close();
    })();
    return stopped;
  }
  void ready.catch(() => {
    void close().catch(() => undefined);
  });
  const initialized = ready.then(() => undefined);
  void initialized.catch(() => undefined);
  return {
    initialized,
    close,
    async interrupt() {
      return (await ready).interrupt();
    },
    async getAvailableModels() {
      return (await ready).getAvailableModels();
    },
    getSessionId() {
      return query?.getSessionId() ?? options.resume ?? options.sessionId ?? "";
    },
    async *[Symbol.asyncIterator]() {
      yield* await ready;
    },
  };
}
