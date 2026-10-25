import { request } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  provisionWorkspace,
  WorkspaceError,
  type HostWorkspace,
  type ProvisionWorkspaceArgs,
} from "@bb/host-workspace";
import {
  workspaceStatusSchema,
  threadGitDiffResponseSchema,
  rawDiffFileStatSchema,
} from "@bb/domain";
import { runVcsProcess } from "@bb/process-utils";
import {
  workspaceExecutionResponseSchema,
  workspaceWorkerRequestSchema,
  workspaceWorkerResponseSchema,
  parseHostDaemonRpcResultForCommand,
  type WorkspaceExecutionIdentity,
  type WorkspaceWorkerRequest,
  type workspaceForwardCommandSchema,
  type HostDaemonRpcResultForCommand,
} from "@bb/host-daemon-contract";

const exec = promisify(execFile);
const helper = "/opt/bb-control-plane/launcher/helper.py";
const tails = new Map<string, Promise<unknown>>();
const blocked = new Set<string>();
const maxOutput = 16777216;

export function resolveWorkspaceExecution(socketPath: string, cwd: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<
    z.output<typeof workspaceExecutionResponseSchema>
  >((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: "/workspace/resolve",
        method: "POST",
        agent: false,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (part: string) => {
          text += part;
          if (Buffer.byteLength(text) > 8192)
            req.destroy(new Error("Invalid workspace authority response"));
        });
        res.once("error", reject);
        res.once("end", () => {
          try {
            if (res.statusCode !== 200)
              throw new WorkspaceError(
                "permission_denied",
                "Workspace execution is not authorized",
              );
            resolve(workspaceExecutionResponseSchema.parse(JSON.parse(text)));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    timeout = setTimeout(() => {
      const error = new Error("Workspace authority unavailable");
      req.destroy(error);
      reject(error);
    }, 2000);
    req.once("error", reject);
    req.end(JSON.stringify({ cwd }));
  });
  return pending.finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function invoke(
  socketPath: string,
  identity: WorkspaceExecutionIdentity,
  input: WorkspaceWorkerRequest,
  signal?: AbortSignal,
): Promise<unknown> {
  const serialized = JSON.stringify(workspaceWorkerRequestSchema.parse(input));
  if (Buffer.byteLength(serialized) > 131072)
    throw new WorkspaceError(
      "invalid_request",
      "Workspace input exceeds limit",
    );
  if (process.platform !== "linux")
    throw new WorkspaceError(
      "permission_denied",
      "Managed workspace execution requires Linux",
    );
  const previous = tails.get(identity.cwd) ?? Promise.resolve();
  const pending = previous
    .catch(() => undefined)
    .then(() =>
      runVcsProcess(
        "git",
        [input.op],
        async () => {
          if (blocked.has(identity.cwd))
            throw new WorkspaceError(
              "cleanup_unconfirmed",
              "Workspace cleanup is unconfirmed",
            );
          const recheck = async () => {
            const current = await resolveWorkspaceExecution(
              socketPath,
              identity.cwd,
            );
            if (
              current.kind !== "managed" ||
              JSON.stringify(current.identity) !== JSON.stringify(identity)
            )
              throw new WorkspaceError(
                "permission_denied",
                "Workspace authority changed",
              );
          };
          signal?.throwIfAborted();
          await recheck();
          const jobId = randomUUID();
          const child = spawn(
            "sudo",
            [
              "-n",
              helper,
              "launch-workspace",
              identity.userId,
              String(identity.uid),
              jobId,
              identity.cwd,
            ],
            { stdio: "pipe", env: { PATH: "/usr/local/bin:/usr/bin:/bin" } },
          );
          let bytes = 0;
          const stdout: Buffer[] = [];
          let failure: Error | null = null;
          let stopping: Promise<void> | null = null;
          let finished = false;
          let failStop!: (error: Error) => void;
          const stopFailure = new Promise<never>((_, reject) => {
            failStop = reject;
          });
          const stop = (reason: Error) => {
            failure ??= reason;
            stopping ??= exec(
              "sudo",
              [
                "-n",
                helper,
                "stop",
                identity.userId,
                String(identity.uid),
                jobId,
              ],
              {
                timeout: 12000,
                maxBuffer: 8192,
                env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
              },
            )
              .then(() => undefined)
              .catch(() => {
                blocked.add(identity.cwd);
                failStop(
                  new WorkspaceError(
                    "cleanup_unconfirmed",
                    "Workspace cleanup is unconfirmed",
                  ),
                );
              });
          };
          const closed = new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
          });
          child.stdout.on("data", (part: Buffer) => {
            bytes += part.length;
            if (bytes > maxOutput)
              stop(
                new WorkspaceError(
                  "output_limit",
                  "Workspace output exceeds limit",
                ),
              );
            else stdout.push(part);
          });
          child.stderr.on("data", (part: Buffer) => {
            bytes += part.length;
            if (bytes > maxOutput)
              stop(
                new WorkspaceError(
                  "output_limit",
                  "Workspace output exceeds limit",
                ),
              );
          });
          child.stdin.on("error", () => undefined);
          child.stdin.end(serialized);
          let checking: Promise<void> | null = null;
          const poll = setInterval(() => {
            if (checking || finished) return;
            checking = recheck()
              .catch(() => {
                if (!finished)
                  stop(
                    new WorkspaceError(
                      "permission_denied",
                      "Workspace authority revoked",
                    ),
                  );
              })
              .finally(() => {
                checking = null;
              });
          }, 250);
          poll.unref();
          const deadline = setTimeout(
            () =>
              stop(
                new WorkspaceError(
                  "workspace_timeout",
                  "Workspace operation timed out",
                ),
              ),
            30000,
          );
          deadline.unref();
          const abort = () =>
            stop(
              new WorkspaceError(
                "provision_cancelled",
                "Workspace operation cancelled",
              ),
            );
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
          try {
            const code = await Promise.race([closed, stopFailure]);
            if (stopping) await stopping;
            if (failure) throw failure;
            await recheck();
            const result = workspaceWorkerResponseSchema.parse(
              JSON.parse(Buffer.concat(stdout).toString("utf8")),
            );
            if (!result.ok)
              throw new WorkspaceError(result.code, result.message);
            if (code !== 0)
              throw new WorkspaceError(
                "workspace_failed",
                "Workspace worker failed",
              );
            return result.result;
          } finally {
            finished = true;
            clearInterval(poll);
            clearTimeout(deadline);
            signal?.removeEventListener("abort", abort);
            if (checking) await checking;
          }
        },
        { ...(signal ? { signal } : {}) },
      ),
    );
  tails.set(identity.cwd, pending);
  try {
    return await pending;
  } finally {
    if (tails.get(identity.cwd) === pending) tails.delete(identity.cwd);
  }
}

export function controlPlaneWorkspaceProvisioner(socketPath: string) {
  return async (options: ProvisionWorkspaceArgs): Promise<HostWorkspace> => {
    const authority = await resolveWorkspaceExecution(socketPath, options.path);
    if (authority.kind === "unmanaged") return provisionWorkspace(options);
    const call = (input: WorkspaceWorkerRequest) =>
      invoke(socketPath, authority.identity, input);
    const info = z
      .object({ isGitRepo: z.boolean(), isWorktree: z.boolean() })
      .strict()
      .parse(
        await invoke(
          socketPath,
          authority.identity,
          { op: "inspect" },
          options.signal,
        ),
      );
    return {
      path: options.path,
      ...info,
      getCurrentBranch: async () =>
        z
          .string()
          .nullable()
          .parse(await call({ op: "branch" })),
      getDefaultBranch: async () =>
        z
          .string()
          .nullable()
          .parse(await call({ op: "defaultBranch" })),
      getHeadSha: async () =>
        z
          .string()
          .nullable()
          .parse(await call({ op: "head" })),
      getLocalStateSnapshot: async () =>
        z
          .object({
            fingerprint: z.string(),
            branchName: z.string().nullable(),
          })
          .parse(await call({ op: "localState" })),
      getSharedGitRefsSnapshot: async () =>
        z
          .object({
            fingerprint: z.string(),
            defaultBranch: z.string().nullable(),
          })
          .parse(await call({ op: "sharedRefs" })),
      getAdditionalWorkspaceWriteRoots: async () =>
        z.array(z.string()).parse(await call({ op: "writeRoots" })),
      getStatus: async (options = {}) =>
        workspaceStatusSchema.parse(await call({ op: "status", options })),
      getDiff: async (options = {}) =>
        threadGitDiffResponseSchema.parse(await call({ op: "diff", options })),
      diffFiles: async (options) =>
        z
          .object({
            files: z.array(rawDiffFileStatSchema),
            shortstat: z.string(),
            truncated: z.boolean(),
            mergeBaseRef: z.string().nullable(),
          })
          .parse(await call({ op: "diffFiles", options })),
      diffPatch: async (options) =>
        z
          .array(
            z.object({
              path: z.string(),
              patch: z.string(),
              truncated: z.boolean(),
            }),
          )
          .parse(await call({ op: "diffPatch", options })),
      commit: async (options) =>
        z
          .object({ commitSha: z.string(), commitSubject: z.string() })
          .parse(await call({ op: "commit", options })),
    };
  };
}

export async function forwardControlPlaneWorkspaceCommand<
  T extends z.output<typeof workspaceForwardCommandSchema>,
>(
  command: T,
  signal?: AbortSignal,
): Promise<HostDaemonRpcResultForCommand<T> | null> {
  const socketPath = process.env.QWEN_SERVER_CONTEXT_SOCKET;
  if (!socketPath) return null;
  const cwd = "rootPath" in command ? command.rootPath : command.path;
  const authority = await resolveWorkspaceExecution(socketPath, cwd);
  if (authority.kind === "unmanaged") return null;
  return parseHostDaemonRpcResultForCommand(
    command,
    await invoke(
      socketPath,
      authority.identity,
      { op: "command", command },
      signal,
    ),
  );
}
