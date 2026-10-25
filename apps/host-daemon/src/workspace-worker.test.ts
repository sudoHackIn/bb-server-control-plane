import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { expect, it } from "vitest";
import { workspaceWorkerResponseSchema } from "@bb/host-daemon-contract";

const exec = promisify(execFile);
it("preserves a multibyte commit message across streamed IPC chunks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bb-workspace-unicode-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (args: string[]) =>
    exec("git", args, { cwd, env, maxBuffer: 1048576 });
  try {
    await git(["init", "--initial-branch=main"]);
    await git(["config", "user.name", "Workspace test"]);
    await git(["config", "user.email", "workspace@example.invalid"]);
    await git(["config", "commit.gpgsign", "false"]);
    await writeFile(join(cwd, "tracked.txt"), "content\n");
    const message = "Б".repeat(40000);
    const child = spawn(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("./workspace-worker.ts", import.meta.url)),
      ],
      { cwd, env, stdio: "pipe" },
    );
    const closed = once(child, "close");
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (part: string) => {
      stdout += part;
    });
    child.stderr.setEncoding("utf8").on("data", (part: string) => {
      stderr += part;
    });
    const body = Buffer.from(
      JSON.stringify({ op: "commit", options: { message, noVerify: true } }),
    );
    for (let offset = 0; offset < body.length; offset += 127) {
      child.stdin.write(body.subarray(offset, offset + 127));
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    child.stdin.end();
    const [code] = await closed;
    expect(code, stderr + stdout.slice(0, 500)).toBe(0);
    expect(workspaceWorkerResponseSchema.parse(JSON.parse(stdout)).ok).toBe(
      true,
    );
    expect((await git(["log", "-1", "--pretty=%s"])).stdout.trim()).toBe(
      message,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
