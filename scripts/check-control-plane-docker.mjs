import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), "bb-access-linux-"));
try {
  const outfile = join(directory, "smoke.mjs");
  await build({
    entryPoints: [join(repo, "apps/server/scripts/control-plane-smoke.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: {
      js: 'import { createRequire as smokeRequire } from "node:module";const require=smokeRequire(import.meta.url);',
    },
    logLevel: "silent",
  });
  await new Promise((complete, reject) => {
    const child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "0:0",
        "--entrypoint",
        "node",
        "--mount",
        `type=bind,src=${outfile},dst=/opt/control-plane-smoke.mjs,readonly`,
        "node:22-bookworm-slim",
        "/opt/control-plane-smoke.mjs",
      ],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? complete()
        : reject(new Error(`Docker access check failed (${code})`)),
    );
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
