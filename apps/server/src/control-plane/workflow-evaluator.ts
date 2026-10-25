import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { requireControlPlaneJobDispatch } from "@bb/db";
import type {
  InternalDoNotUseBackgroundJobs,
  JsonValue,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { jsonValueSchema } from "@bb/domain";

const exec = promisify(execFile);
const helper = "/opt/bb-control-plane/launcher/helper.py";
const inputSchema = z
  .object({
    body: z.string().max(131072),
    args: jsonValueSchema,
    maxAgentCalls: z.number().int().min(1).max(1000),
    maxConcurrentAgents: z.number().int().min(1).max(64),
    timeoutMs: z.number().int().min(1).max(604800000),
  })
  .strict();
const messageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("ready"),
      uid: z.number().int(),
      home: z.string(),
      cwd: z.string(),
      backendCredential: z.literal(false),
    })
    .strict(),
  z.object({ type: z.literal("log"), value: z.string().max(8192) }).strict(),
  z.object({ type: z.literal("phase"), value: z.string().max(1024) }).strict(),
  z
    .object({
      type: z.literal("agent"),
      id: z.number().int().positive(),
      prompt: z.string().min(1).max(131072),
      options: jsonValueSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("cancel"), id: z.number().int().positive() })
    .strict(),
  z.object({ type: z.literal("result"), value: jsonValueSchema }).strict(),
  z
    .object({ type: z.literal("error"), message: z.string().max(4096) })
    .strict(),
]);

export async function evaluateControlPlaneWorkflow(
  context: ReturnType<typeof requireControlPlaneJobDispatch>,
  input: Parameters<InternalDoNotUseBackgroundJobs["evaluateWorkflow"]>[1],
  signal: AbortSignal,
  onEvent: Parameters<InternalDoNotUseBackgroundJobs["evaluateWorkflow"]>[3],
  recheck: () => void,
  onAgent?: Parameters<InternalDoNotUseBackgroundJobs["evaluateWorkflow"]>[4],
): Promise<JsonValue> {
  const parsed = inputSchema.parse(input);
  const encoded = JSON.stringify(parsed);
  if (Buffer.byteLength(encoded) > 2097152)
    throw new Error("Workflow input exceeds 2 MiB");
  recheck();
  if (signal.aborted)
    throw new Error("Workflow cancelled before evaluator launch");
  const jobId = randomUUID();
  const args = [context.user.id, String(context.user.uid), jobId];
  const child = spawn(
    "/usr/bin/sudo",
    ["-n", "--", helper, "launch-workflow", ...args, context.project.cwd],
    {
      cwd: "/tmp",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
      stdio: "pipe",
    },
  );
  child.stderr.resume();
  let failure: Error | null = null;
  let stopping: Promise<void> | null = null;
  let ready = false;
  let resultSeen = false;
  let result: JsonValue = null;
  let buffer = "";
  let total = 0;
  let events = 0;
  let requestId = 0;
  const requests = new Map<number, AbortController>();
  const tasks = new Set<Promise<void>>();
  const abortRequests = () => {
    for (const controller of requests.values()) controller.abort();
  };
  const reply = (id: number, value: JsonValue | null, error: string | null) => {
    if (failure || resultSeen || child.stdin.destroyed) return;
    const encoded = JSON.stringify({ type: "reply", id, value, error });
    if (Buffer.byteLength(encoded) > 1048576)
      throw new Error("Workflow agent result exceeds 1 MiB");
    child.stdin.write(encoded + "\n");
  };
  const stop = (error: Error) => {
    failure ??= error;
    abortRequests();
    stopping ??= exec("/usr/bin/sudo", ["-n", "--", helper, "stop", ...args], {
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      timeout: 12000,
      maxBuffer: 16384,
    }).then(() => undefined);
    void stopping.catch(() => {});
  };
  const cancelled = () => stop(new Error("Workflow evaluator cancelled"));
  signal.addEventListener("abort", cancelled, { once: true });
  const timeout = setTimeout(
    () => stop(new Error("Workflow evaluator deadline exceeded")),
    parsed.timeoutMs,
  );
  const readyTimeout = setTimeout(
    () =>
      stop(
        new Error(
          "Workflow evaluator handshake timed out; check the installed runtime artifact",
        ),
      ),
    Math.min(15000, parsed.timeoutMs),
  );
  const authorityTimer = setInterval(() => {
    try {
      recheck();
    } catch {
      stop(new Error("Workflow execution authority revoked"));
    }
  }, 500);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (failure) return;
    try {
      total += Buffer.byteLength(chunk);
      buffer += chunk;
      if (total > 16777216 || Buffer.byteLength(buffer) > 2097152)
        throw new Error("Workflow protocol output limit exceeded");
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (Buffer.byteLength(line) > 1048576)
          throw new Error("Workflow protocol frame limit exceeded");
        const message = messageSchema.parse(JSON.parse(line));
        recheck();
        if (message.type === "ready") {
          if (
            ready ||
            message.uid !== context.user.uid ||
            message.home !== context.user.home ||
            message.cwd !== context.project.cwd
          )
            throw new Error("Workflow evaluator identity mismatch");
          ready = true;
          clearTimeout(readyTimeout);
        } else {
          if (!ready || resultSeen)
            throw new Error("Unexpected workflow protocol order");
          if (message.type === "result") {
            result = message.value;
            resultSeen = true;
            abortRequests();
            child.stdin.end();
          } else if (message.type === "agent") {
            if (
              message.id !== requestId + 1 ||
              message.id > parsed.maxAgentCalls ||
              requests.size >= parsed.maxConcurrentAgents
            )
              throw new Error(
                "Invalid workflow agent request identity or budget",
              );
            requestId = message.id;
            const controller = new AbortController();
            requests.set(message.id, controller);
            const task = Promise.resolve()
              .then(async () => {
                try {
                  if (!onAgent)
                    throw new Error(
                      "Managed workflow agent dispatch requires scoped worker integration",
                    );
                  recheck();
                  const value = await onAgent(
                    message.prompt,
                    message.options,
                    controller.signal,
                  );
                  recheck();
                  reply(message.id, value, null);
                } catch (error) {
                  reply(
                    message.id,
                    null,
                    error instanceof Error
                      ? error.message.slice(0, 4096)
                      : "Workflow agent failed",
                  );
                }
              })
              .catch((error) =>
                stop(
                  error instanceof Error
                    ? error
                    : new Error("Workflow agent reply failed"),
                ),
              )
              .finally(() => {
                requests.delete(message.id);
                tasks.delete(task);
              });
            tasks.add(task);
          } else if (message.type === "cancel") {
            if (message.id > requestId)
              throw new Error("Unknown workflow agent cancellation");
            requests.get(message.id)?.abort();
          } else if (message.type === "error") throw new Error(message.message);
          else {
            if (++events > 4096)
              throw new Error("Workflow event limit exceeded");
            onEvent(message);
          }
        }
      }
    } catch (error) {
      stop(
        error instanceof Error ? error : new Error("Invalid workflow protocol"),
      );
    }
  });
  child.stdin.on("error", () => {
    if (!resultSeen) stop(new Error("Workflow evaluator input closed"));
  });
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      failure ??= error;
      reject(error);
    });
    child.once("close", async (code) => {
      try {
        abortRequests();
        await Promise.allSettled(tasks);
        await stopping;
        recheck();
        if (failure) throw failure;
        if (code !== 0 || !ready || !resultSeen || buffer !== "")
          throw new Error(
            "Workflow evaluator exited without a complete result",
          );
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  child.stdin.write(encoded + "\n");
  if (signal.aborted) cancelled();
  try {
    await completion;
    return result;
  } finally {
    clearTimeout(timeout);
    clearTimeout(readyTimeout);
    clearInterval(authorityTimer);
    signal.removeEventListener("abort", cancelled);
  }
}
