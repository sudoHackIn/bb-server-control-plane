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
    [
      "scripts/check-control-plane-message-sources.mjs",
      "check-control-plane-message-sources.mjs",
    ],
    [
      "scripts/check-control-plane-daemon-requests.mjs",
      "check-control-plane-daemon-requests.mjs",
    ],
    ["apps/server/dist", "server"],
    [
      "scripts/check-control-plane-script-automations.mjs",
      "check-control-plane-script-automations.mjs",
    ],
    [
      "scripts/check-control-plane-script-jobs.mjs",
      "check-control-plane-script-jobs.mjs",
    ],
    ["scripts/check-control-plane-script-client.mjs", "script-job-client.mjs"],
    [
      "apps/server/.control-plane-runtime/workflow-evaluator.mjs",
      "workflow-evaluator.mjs",
    ],
    ["packages/bundled-plugins/dist", "server/builtin-plugins"],
    ["apps/app/dist", "app"],
    ["apps/cli/dist", "cli"],
    ["apps/host-daemon/dist", "host-daemon"],
    ["apps/host-daemon/dist/workspace-worker.mjs", "workspace-worker.mjs"],
    ["scripts/check-control-plane-deployment.mjs", "deployment-check.mjs"],
    [
      "scripts/check-control-plane-project-mcp.mjs",
      "check-control-plane-project-mcp.mjs",
    ],
    [
      "scripts/check-control-plane-provider-lifecycle.mjs",
      "check-control-plane-provider-lifecycle.mjs",
    ],
    [
      "scripts/check-control-plane-workspace.mjs",
      "check-control-plane-workspace.mjs",
    ],
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
      "scripts/check-control-plane-browser-handshake.mjs",
      "check-control-plane-browser-handshake.mjs",
    ],
    [
      "scripts/check-control-plane-user-threads.mjs",
      "check-control-plane-user-threads.mjs",
    ],
    [
      "scripts/check-control-plane-automations.mjs",
      "check-control-plane-automations.mjs",
    ],
    [
      "scripts/check-control-plane-workflows.mjs",
      "check-control-plane-workflows.mjs",
    ],
    [
      "scripts/check-control-plane-workflow-definitions.mjs",
      "check-control-plane-workflow-definitions.mjs",
    ],
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
  await cp(
    join(repo, "scripts/check-control-plane-project-access.mjs"),
    join(directory, "check-control-plane-project-access.mjs"),
  );
  await cp(
    join(repo, "scripts/check-control-plane-native-maintenance.mjs"),
    join(directory, "check-control-plane-native-maintenance.mjs"),
  );
  await cp(
    join(repo, "scripts/check-control-plane-maintenance-queue.mjs"),
    join(directory, "check-control-plane-maintenance-queue.mjs"),
  );
  await cp(
    join(repo, "scripts/check-control-plane-project-maintenance.mjs"),
    join(directory, "check-control-plane-project-maintenance.mjs"),
  );
  await cp(
    join(repo, "scripts/check-control-plane-uid-leases.mjs"),
    join(directory, "check-control-plane-uid-leases.mjs"),
  );
  await buildNodeEsmEntry({
    cleanDist: false,
    entryPoint: join(
      repo,
      "apps/server/test/fixtures/control-plane-project-access-fixture.ts",
    ),
    outfile: join(directory, "server/project-access-check.mjs"),
    packageRoot: repo,
    sourcemap: false,
  });
  await buildNodeEsmEntry({
    cleanDist: false,
    entryPoint: join(
      repo,
      "apps/server/test/fixtures/control-plane-mcp-credential-fixture.ts",
    ),
    outfile: join(directory, "mcp-credential-check.mjs"),
    packageRoot: repo,
    sourcemap: false,
  });
  await buildNodeEsmEntry({
    cleanDist: false,
    entryPoint: join(
      repo,
      "apps/server/test/fixtures/control-plane-inherited-source-fixture.ts",
    ),
    outfile: join(directory, "inherited-source-check.mjs"),
    packageRoot: repo,
    sourcemap: false,
  });
  await buildNodeEsmEntry({
    cleanDist: false,
    entryPoint: join(
      repo,
      "apps/server/test/fixtures/control-plane-script-runner-fixture.ts",
    ),
    outfile: join(directory, "script-runner-check.mjs"),
    packageRoot: repo,
    sourcemap: false,
  });
  await buildNodeEsmEntry({
    cleanDist: false,
    entryPoint: join(
      repo,
      "apps/server/test/fixtures/control-plane-workflow-worker-fixture.ts",
    ),
    outfile: join(directory, "workflow-worker-check.mjs"),
    packageRoot: repo,
    sourcemap: false,
  });
  await buildNodeEsmEntry({
    cleanDist: false,
    entryPoint: join(
      repo,
      "apps/server/test/fixtures/control-plane-workflow-evaluator-fixture.ts",
    ),
    outfile: join(directory, "workflow-evaluator-check.mjs"),
    packageRoot: repo,
    sourcemap: false,
  });
  await buildNodeEsmEntry({
    cleanDist: false,
    entryPoint: join(
      repo,
      "apps/server/test/fixtures/control-plane-job-binding-fixture.ts",
    ),
    outfile: join(directory, "job-bindings-check.mjs"),
    packageRoot: repo,
    sourcemap: false,
  });
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
