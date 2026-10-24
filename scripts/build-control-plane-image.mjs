import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNodeEsmEntry } from "./build-utils.mjs";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), "bb-control-plane-image-"));
try {
  for (const name of ["Dockerfile", "package.json", "package-lock.json"]) {
    await cp(join(repo, "deploy/control-plane", name), join(directory, name));
  }
  for (const [source, target] of [
    ["apps/server/dist", "server"],
    ["packages/bundled-plugins/dist", "server/builtin-plugins"],
    ["apps/app/dist", "app"],
    ["apps/cli/dist", "cli"],
    ["scripts/check-control-plane-deployment.mjs", "deployment-check.mjs"],
  ]) {
    await cp(join(repo, source), join(directory, target), { recursive: true });
  }
  await buildNodeEsmEntry({
    cleanDist: false,
    entryPoint: join(repo, "scripts/configure-control-plane.ts"),
    outfile: join(directory, "configure.mjs"),
    packageRoot: repo,
    sourcemap: false,
  });
  await new Promise((complete, reject) => {
    const child = spawn(
      "docker",
      ["build", "--tag", "bb-control-plane:local", directory],
      {
        stdio: "inherit",
        env: { ...process.env, BUILDX_CONFIG: join(directory, "buildx") },
      },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? complete()
        : reject(new Error(`Control-plane image build failed (${code})`)),
    );
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
