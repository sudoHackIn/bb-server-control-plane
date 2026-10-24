import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHostId, getLatestSessionForHost } from "@bb/db";
import { z } from "zod";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../types.js";
import { handleDaemonSocketClosed } from "../internal/session-owner-side-effects.js";
import type { ControlPlaneConfig } from "./config.js";
import { issueHostEnrollKey } from "../services/hosts/host-enrollment.js";
import { startControlPlaneQwenContextService } from "./qwen-context.js";

const hostIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/u);

async function persistentHostId(dataDir: string) {
  const path = join(dataDir, "host-id");
  try {
    await writeFile(path, createHostId() + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
  }
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("Managed host identity must be a private server file");
  return hostIdSchema.parse((await readFile(path, "utf8")).trim());
}

export async function startControlPlaneRuntime(
  deps: LoggedPendingInteractionWorkSessionDeps & Pick<AppDeps, "sharedPorts">,
  config: ControlPlaneConfig,
  dataDir: string,
) {
  const runtime = config.runtime;
  if (!runtime) throw new Error("Managed execution is not configured");
  const entry = await lstat(runtime.daemonEntrypoint);
  const cli = await lstat(runtime.cliDirectory);
  if (!entry.isFile() || !cli.isDirectory())
    throw new Error("Managed runtime artifacts are unavailable");
  const hostId = await persistentHostId(dataDir);
  const context = await startControlPlaneQwenContextService(deps.db, dataDir);
  let closing = false;
  let closePromise: Promise<void> | null = null;
  let restart: ReturnType<typeof setTimeout> | null = null;
  let launching: Promise<void> | null = null;
  let active: {
    child: ChildProcessWithoutNullStreams;
    stopped: Promise<void>;
  } | null = null;
  const scheduleRestart = () => {
    if (closing) return;
    restart = setTimeout(() => {
      restart = null;
      launching = launch().catch(() => {
        deps.logger.error({ hostId }, "Managed host daemon restart failed");
        scheduleRestart();
      });
    }, 1000);
    restart.unref();
  };
  const launch = async () => {
    const { enrollKey } = await issueHostEnrollKey(deps, {
      hostId,
      enrollSource: "loopback",
    });
    if (closing) return;
    const child = spawn(
      process.platform === "linux" ? "/usr/bin/setpriv" : process.execPath,
      process.platform === "linux"
        ? [
            "--pdeathsig",
            "KILL",
            "--",
            process.execPath,
            runtime.daemonEntrypoint,
          ]
        : [runtime.daemonEntrypoint],
      {
        stdio: "pipe",
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG,
          NODE_ENV: "production",
          NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
          BB_DATA_DIR: dataDir,
          BB_SERVER_URL: config.publicOrigin,
          BB_APP_URL: config.publicOrigin,
          BB_CLI_DIR: runtime.cliDirectory,
          QWEN_SERVER_CONTEXT_SOCKET: context.socketPath,
          QWEN_SERVER_BASE_URL: process.env.QWEN_SERVER_BASE_URL,
          NEURALDEAP_KEY: process.env.NEURALDEAP_KEY,
          BB_TELEMETRY: "0",
        },
      },
    );
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.stdin.on("error", () => {});
    const stopped = new Promise<void>((resolve) => {
      let finished = false;
      const complete = () => {
        if (finished) return;
        finished = true;
        if (active?.child === child) active = null;
        resolve();
        if (closing) return;
        deps.logger.warn({ hostId }, "Managed host daemon exited; restarting");
        scheduleRestart();
      };
      child.once("error", complete);
      child.once("exit", complete);
    });
    active = { child, stopped };
    child.stdin.write(
      JSON.stringify({
        hostId,
        enrollKey: enrollKey.key,
        parentPid: process.pid,
      }) + "\n",
    );
  };
  try {
    launching = launch();
    await launching;
  } catch (error) {
    closing = true;
    await context.close();
    throw error;
  }
  return {
    hostId,
    socketPath: context.socketPath,
    close() {
      closePromise ??= (async () => {
        closing = true;
        if (restart !== null) clearTimeout(restart);
        await launching;
        const current = active;
        if (current) {
          current.child.stdin.end();
          current.child.kill("SIGTERM");
          const deadline = setTimeout(
            () => current.child.kill("SIGKILL"),
            15000,
          );
          deadline.unref();
          try {
            await current.stopped;
          } finally {
            clearTimeout(deadline);
          }
        }
        const session = getLatestSessionForHost(deps.db, { hostId });
        if (session?.status === "active")
          handleDaemonSocketClosed(deps, { sessionId: session.id });
        await context.close();
      })();
      return closePromise;
    },
  };
}
