import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import {
  Query,
  type QueryOptions,
  type SDKUserMessage,
  type Transport,
} from "@qwen-code/sdk";
import {
  resolveServiceContext,
  type ServiceContext,
} from "./service-context.js";
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
  ) {
    if (!options.cwd) throw new Error("A registered workspace is required");
    const registry = {
      model: process.env.QWEN_SERVER_MODEL,
      baseUrl: process.env.QWEN_SERVER_BASE_URL,
      apiKeyEnv: "NEURALDEAP_KEY",
    };
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--channel=SDK",
      "--approval-mode",
      options.permissionMode ?? "plan",
      "--include-partial-messages",
      ...(options.resume
        ? ["--resume", options.resume]
        : options.sessionId
          ? ["--session-id", options.sessionId]
          : []),
      ...(options.model || registry.model
        ? ["--model", options.model ?? registry.model!]
        : []),
      ...(registry.baseUrl ? ["--auth-type", "openai"] : []),
      ...(options.excludeTools?.length
        ? ["--exclude-tools", options.excludeTools.join(",")]
        : []),
      ...(typeof options.systemPrompt === "string"
        ? ["--system-prompt", options.systemPrompt]
        : options.systemPrompt?.append
          ? ["--append-system-prompt", options.systemPrompt.append]
          : []),
      ...(options.safeMode ? ["--safe-mode"] : []),
    ];
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
        "launch",
        context.id,
        String(context.uid),
        this.jobId,
        context.cwd,
        "--",
        ...args,
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
class ServerTransport implements Transport {
  private readonly pending: Promise<ProcessTransport>;
  private process?: ProcessTransport;
  private closing = false;
  exitError: Error | null = null;
  get isReady() {
    return !this.closing && (this.process?.isReady ?? true);
  }
  constructor(options: QueryOptions, threadId: string) {
    this.pending = (async () => {
      if (!options.cwd) throw new Error("Registered cwd required");
      const socket = process.env.QWEN_SERVER_CONTEXT_SOCKET;
      if (!socket) throw new Error("Context service socket required");
      const context = await resolveServiceContext(
        socket,
        options.cwd,
        options.resume ?? options.sessionId ?? "",
        threadId,
      );
      if (this.closing) throw new Error("Transport closed before launch");
      this.process = new ProcessTransport(options, context);
      return this.process;
    })();
    void this.pending.catch((error) => {
      this.exitError =
        error instanceof Error ? error : new Error("Context resolution failed");
    });
  }
  async write(message: string) {
    (await this.pending).write(message);
  }
  async *readMessages(): AsyncGenerator<unknown> {
    yield* (await this.pending).readMessages();
  }
  async endInput() {
    (await this.pending).endInput();
  }
  async waitForExit() {
    await (await this.pending).waitForExit();
  }
  async close() {
    this.closing = true;
    const transport = await this.pending.catch(() => undefined);
    if (transport) await transport.close();
  }
}
export function serverQuery({
  prompt,
  options,
  threadId,
}: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: QueryOptions;
  threadId?: string;
}) {
  if (!threadId)
    throw new Error("A server-owned BB thread is required to launch Qwen");
  const transport = new ServerTransport(options, threadId);
  const query = new Query(transport, {
    ...options,
    timeout: {
      ...options.timeout,
      streamClose: options.timeout?.streamClose ?? 1000,
    },
  });
  const closeQuery = query.close.bind(query);
  let closing: Promise<void> | null = null;
  query.close = () => {
    closing ??= (async () => {
      await transport.close();
      await closeQuery();
    })();
    return closing;
  };
  void query.streamInput(prompt).catch(() => {
    void query.close();
  });
  return query;
}
