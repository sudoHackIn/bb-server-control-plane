import { z } from "zod";
import {
  runIsolatedWorkflow,
  readWorkflowFrames,
} from "./isolated-evaluator.js";
import { toJsonValue } from "./json-value.js";
import type { JsonValue } from "./types.js";

function write(value: unknown) {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 1048576)
    throw new Error("Workflow response exceeds 1 MiB");
  process.stdout.write(`${encoded}\n`);
}
const replySchema = z
  .object({
    type: z.literal("reply"),
    id: z.number().int().positive(),
    value: z.unknown().transform((value) => toJsonValue(value, "Agent reply")),
    error: z.string().max(4096).nullable(),
  })
  .strict();
const controller = new AbortController();
const pending = new Map<
  number,
  { resolve: (value: JsonValue) => void; reject: (error: Error) => void }
>();
let sequence = 0;
let finished = false;
let ended = false;
const keepAlive = setInterval(() => {}, 1000);
try {
  const frames = readWorkflowFrames(process.stdin);
  const first = await frames.next();
  if (first.done) throw new Error("Missing workflow initialization");
  write({
    type: "ready",
    uid: process.getuid?.(),
    home: process.env.HOME,
    cwd: process.cwd(),
    backendCredential: Boolean(
      process.env.OPENAI_API_KEY || process.env.NEURALDEAP_KEY,
    ),
  });
  void (async () => {
    for await (const value of frames) {
      const reply = replySchema.parse(value);
      const call = pending.get(reply.id);
      if (!call) throw new Error("Unknown workflow agent reply");
      pending.delete(reply.id);
      if (reply.error !== null) call.reject(new Error(reply.error));
      else call.resolve(reply.value);
    }
    ended = true;
    for (const call of pending.values())
      call.reject(new Error("Workflow agent transport ended"));
  })().catch((error) => {
    if (finished) return;
    for (const call of pending.values())
      call.reject(
        error instanceof Error
          ? error
          : new Error("Invalid workflow agent reply"),
      );
    controller.abort();
  });
  const value = await runIsolatedWorkflow(
    first.value,
    write,
    controller.signal,
    async (prompt, options, signal) => {
      if (ended || signal.aborted)
        throw new Error("Workflow agent transport unavailable");
      const id = ++sequence;
      const result = new Promise<JsonValue>((resolve, reject) =>
        pending.set(id, { resolve, reject }),
      );
      const cancel = () => {
        write({ type: "cancel", id });
        pending.get(id)?.reject(new Error("Workflow agent cancelled"));
      };
      signal.addEventListener("abort", cancel, { once: true });
      write({ type: "agent", id, prompt, options });
      try {
        return await result;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
  );
  write({ type: "result", value });
} catch (error) {
  write({
    type: "error",
    message:
      error instanceof Error
        ? error.message.slice(0, 4096)
        : "Workflow evaluator failed",
  });
  process.exitCode = 1;
} finally {
  finished = true;
  controller.abort();
  process.stdin.destroy();
  clearInterval(keepAlive);
}
