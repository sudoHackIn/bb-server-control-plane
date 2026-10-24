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
  await cp(
    join(repo, "deploy/control-plane/launcher"),
    join(directory, "launcher"),
    { recursive: true },
  );
  for (const [source, target] of [
    ["apps/server/dist", "server"],
    ["packages/bundled-plugins/dist", "server/builtin-plugins"],
    ["apps/app/dist", "app"],
    ["apps/cli/dist", "cli"],
    ["apps/host-daemon/dist", "host-daemon"],
    ["scripts/check-control-plane-deployment.mjs", "deployment-check.mjs"],
    [
      "scripts/check-control-plane-namespace-denial.mjs",
      "namespace-denial.mjs",
    ],
    [
      "scripts/check-control-plane-qwen-jobs.mjs",
      "check-control-plane-qwen-jobs.mjs",
    ],
    ["scripts/check-qwen-job-client.mjs", "qwen-job-client.mjs"],
    [
      "scripts/check-control-plane-approvals.mjs",
      "check-control-plane-approvals.mjs",
    ],
    [
      "apps/server/test/fixtures/control-plane-tool-plugin",
      "control-plane-tool-plugin",
    ],
    [
      "scripts/check-control-plane-managed-runtime.mjs",
      "check-control-plane-managed-runtime.mjs",
    ],
    [
      "scripts/check-control-plane-user-deployment.mjs",
      "check-control-plane-user-deployment.mjs",
    ],
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
  await buildNodeEsmEntry({
    cleanDist: false,
    entryPoint: join(repo, "plugins/provider-qwen-server/src/server-query.ts"),
    outfile: join(directory, "qwen-server-query.mjs"),
    packageRoot: repo,
    sourcemap: false,
  });
  await buildNodeEsmEntry({
    cleanDist: false,
    entryPoint: join(
      repo,
      "apps/server/test/fixtures/control-plane-runtime-fixture.ts",
    ),
    outfile: join(directory, "qwen-runtime-fixture.mjs"),
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
