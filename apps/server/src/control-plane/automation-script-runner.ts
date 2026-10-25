import { assertExecutionAdmission } from "../services/system/execution-admission.js";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  controlPlaneUsers,
  getControlPlaneJobBinding,
  type DbConnection,
  type DbQueryConnection,
} from "@bb/db";
import { eq } from "drizzle-orm";
import { currentControlPlanePrincipal } from "./access.js";
import { withControlPlaneJobAuthority } from "./job-authority.js";

const exec = promisify(execFile);
const helper = "/opt/bb-control-plane/launcher/helper.py";
const outputLimit = 1048576;
const inputSchema = z
  .object({
    jobId: z.string().uuid(),
    source: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value) <= 262144),
    timeoutMs: z.number().int().min(1).max(900000),
  })
  .strict();
type Status =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "output_limit"
  | "authority_revoked"
  | "invalid_output";

export interface ControlPlaneScriptResult {
  jobId: string;
  status: Status;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  outputBytes: number;
  truncated: boolean;
}

export async function runControlPlaneAutomationScript(
  db: DbConnection,
  bindingId: string,
  input: z.input<typeof inputSchema>,
  signal: AbortSignal,
): Promise<ControlPlaneScriptResult> {
  assertExecutionAdmission(db);
  const parsed = inputSchema.parse(input);
  const authority = () =>
    withControlPlaneJobAuthority(db, bindingId, (context) => {
      const parent = context.binding.sourceBindingId
        ? getControlPlaneJobBinding(
            db,
            context.user.id,
            context.binding.sourceBindingId,
          )
        : null;
      if (
        context.profileVersion.definition.permissionMode !== "full" ||
        context.binding.kind !== "automation-run" ||
        parent?.kind !== "automation"
      )
        throw new Error("Script execution is not authorized");
      return context;
    });
  const context = authority();
  const identity = (value: typeof context) =>
    JSON.stringify({
      user: value.user.id,
      uid: value.user.uid,
      home: value.user.home,
      cwd: value.project.cwd,
      project: value.project.projectId,
      profile: value.profileVersion.id,
      source: value.binding.sourceBindingId,
      origin: value.binding.originThreadId,
    });
  const initial = identity(context);
  const recheck = () => {
    if (identity(authority()) !== initial)
      throw new Error("Script authority changed");
  };
  recheck();
  if (signal.aborted) throw new Error("Script cancelled before launch");
  const args = [context.user.id, String(context.user.uid), parsed.jobId];
  const child = spawn(
    "/usr/bin/sudo",
    ["-n", "--", helper, "launch-script", ...args, context.project.cwd],
    {
      cwd: "/tmp",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
      stdio: "pipe",
    },
  );
  let status: Status | null = null;
  let outputBytes = 0;
  let truncated = false;
  let stopping: Promise<void> | null = null;
  let spawnError: Error | null = null;
  let isClosed = false;
  let closeDeadline: ReturnType<typeof setTimeout> | null = null;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const decoders = [
    new TextDecoder("utf-8", { fatal: true }),
    new TextDecoder("utf-8", { fatal: true }),
  ] as const;
  let rejectCleanup: (error: Error) => void = () => {};
  const cleanupFailure = new Promise<never>((_, reject) => {
    rejectCleanup = reject;
  });
  const stop = (reason: Status) => {
    status ??= reason;
    if (!stopping) {
      stopping = exec("/usr/bin/sudo", ["-n", "--", helper, "stop", ...args], {
        cwd: "/tmp",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
        timeout: 12000,
        maxBuffer: 16384,
      }).then(() => {
        if (!isClosed)
          closeDeadline = setTimeout(() => {
            rejectCleanup(
              new Error(
                `Script transport did not close after cleanup for job ${parsed.jobId}`,
              ),
            );
          }, 5000);
      });
      void stopping.catch((cause: unknown) => {
        rejectCleanup(
          new Error(`Script cleanup is unconfirmed for job ${parsed.jobId}`, {
            cause,
          }),
        );
      });
    }
  };
  const collect = (target: string[], decoder: TextDecoder, chunk: Buffer) => {
    if (status) return;
    const remaining = outputLimit - outputBytes;
    const accepted = chunk.subarray(0, remaining);
    outputBytes += accepted.length;
    try {
      target.push(decoder.decode(accepted, { stream: true }));
    } catch {
      stop("invalid_output");
    }
    if (chunk.length > remaining) {
      truncated = true;
      stop("output_limit");
    }
  };
  child.stdout.on("data", (chunk: Buffer) =>
    collect(stdout, decoders[0], chunk),
  );
  child.stderr.on("data", (chunk: Buffer) =>
    collect(stderr, decoders[1], chunk),
  );
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      stop("failed");
    });
    child.once("close", (code, closedSignal) => {
      isClosed = true;
      resolve({ code, signal: closedSignal });
    });
  });
  child.stdin.on("error", () => stop("failed"));
  const abort = () => stop("cancelled");
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(() => stop("timed_out"), parsed.timeoutMs);
  const grants = setInterval(() => {
    try {
      recheck();
    } catch {
      stop("authority_revoked");
    }
  }, 250);
  child.stdin.end(parsed.source);
  try {
    const exit = await Promise.race([closed, cleanupFailure]);
    if (!status) {
      try {
        stdout.push(decoders[0].decode());
        stderr.push(decoders[1].decode());
      } catch {
        stop("invalid_output");
      }
    }
    try {
      recheck();
    } catch {
      status = "authority_revoked";
      stop("authority_revoked");
    }
    stop(status ?? (exit.code === 0 ? "succeeded" : "failed"));
    if (stopping) {
      try {
        await stopping;
      } catch (cause) {
        throw new Error(
          `Script cleanup is unconfirmed for job ${parsed.jobId}`,
          { cause },
        );
      }
    }
    try {
      recheck();
    } catch {
      status = "authority_revoked";
    }
    if (spawnError) throw spawnError;
    return {
      jobId: parsed.jobId,
      status: status ?? (exit.code === 0 ? "succeeded" : "failed"),
      exitCode: exit.code,
      signal: exit.signal,
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      outputBytes,
      truncated,
    };
  } finally {
    clearTimeout(timeout);
    if (closeDeadline) clearTimeout(closeDeadline);
    clearInterval(grants);
    signal.removeEventListener("abort", abort);
  }
}

export async function stopControlPlaneAutomationScript(
  db: DbQueryConnection,
  bindingId: string,
): Promise<void> {
  const binding = getControlPlaneJobBinding(
    db,
    null,
    z.string().uuid().parse(bindingId),
  );
  const principal = currentControlPlanePrincipal();
  if (
    !binding ||
    binding.kind !== "automation-run" ||
    (principal?.kind === "user" && binding.ownerUserId !== principal.userId)
  )
    throw new Error("Script cleanup is not authorized");
  const parent = binding.sourceBindingId
    ? getControlPlaneJobBinding(db, null, binding.sourceBindingId)
    : null;
  const user = db
    .select()
    .from(controlPlaneUsers)
    .where(eq(controlPlaneUsers.id, binding.ownerUserId))
    .get();
  if (
    !user ||
    parent?.kind !== "automation" ||
    parent.ownerUserId !== binding.ownerUserId ||
    parent.projectId !== binding.projectId
  )
    throw new Error("Script cleanup is not authorized");
  try {
    await exec(
      "/usr/bin/sudo",
      ["-n", "--", helper, "stop", user.id, String(user.uid), binding.id],
      {
        cwd: "/tmp",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
        timeout: 12000,
        maxBuffer: 16384,
      },
    );
  } catch (cause) {
    throw new Error(`Script cleanup is unconfirmed for job ${binding.id}`, {
      cause,
    });
  }
}
