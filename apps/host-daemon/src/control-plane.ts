import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHostDaemonEntrypointConfig } from "@bb/config/host-daemon-entrypoint";
import { z } from "zod";
import type { HostDaemon } from "./daemon.js";

const bootstrapSchema = z
  .object({
    parentPid: z.number().int().positive(),
    hostId: z.string().min(1).max(200),
    enrollKey: z.string().min(1).max(4096),
  })
  .strict();

async function main() {
  let daemon: HostDaemon | null = null;
  let parentGone = false;
  const parentExited = () => {
    if (parentGone) return;
    parentGone = true;
    void daemon
      ?.shutdown("managed-parent-exited", 0)
      .catch(() => process.exit(1));
  };
  process.stdin.once("end", parentExited);
  const body = await new Promise<unknown>((resolve, reject) => {
    let text = "";
    const data = (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (Buffer.byteLength(text) > 8192) {
        process.stdin.off("data", data);
        reject(new Error("Invalid managed daemon bootstrap"));
        return;
      }
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      process.stdin.off("data", data);
      process.stdin.resume();
      try {
        const value: unknown = JSON.parse(text.slice(0, newline));
        resolve(value);
      } catch (error) {
        reject(error);
      }
    };
    process.stdin.on("data", data);
    process.stdin.once("error", reject);
    process.stdin.once("end", () =>
      reject(new Error("Managed bootstrap channel closed")),
    );
  });
  const bootstrap = bootstrapSchema.parse(body);
  if (!process.env.QWEN_SERVER_CONTEXT_SOCKET)
    throw new Error("Managed workspace authority socket required");
  if (process.ppid !== bootstrap.parentPid)
    throw new Error("Managed parent exited before startup");
  const config = loadHostDaemonEntrypointConfig();
  const { startHostDaemon } = await import("./start-host-daemon.js");
  daemon = await startHostDaemon({
    enrollKey: bootstrap.enrollKey,
    hostId: bootstrap.hostId,
    localApi: false,
    autoUpdate: false,
    supervised: true,
    bbExecutableDirectory: config.BB_CLI_DIR,
    bridgeBundleDir: dirname(fileURLToPath(import.meta.url)),
  });
  if (parentGone) await daemon.shutdown("managed-parent-exited", 0);
  await daemon.waitUntilStopped();
}

void main().catch(() => {
  process.stderr.write(
    "Managed host daemon startup failed; inspect private host logs\n",
    () => process.exit(1),
  );
});
