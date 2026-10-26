import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeControlPlaneSeccomp } from "./control-plane-seccomp.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((arg) => arg !== "--browser"))
  throw new Error("Usage: test-control-plane-deployment.mjs [--browser]");
const browserMode = args.includes("--browser");
let browserTask;
let browserError;
const name = `bb-control-plane-check-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), "bb-control-plane-security-"));
const seccomp = join(directory, "seccomp.json");
await writeControlPlaneSeccomp(seccomp);
function docker(args) {
  return new Promise((complete, reject) => {
    const watchBrowser = browserMode && args.includes("deployment-check.mjs");
    const child = spawn("docker", args, {
      stdio: watchBrowser ? ["inherit", "pipe", "inherit"] : "inherit",
    });
    if (watchBrowser) {
      let pending = "";
      child.stdout.on("data", (chunk) => {
        process.stdout.write(chunk);
        pending += chunk.toString();
        let end;
        while ((end = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (line.startsWith("BB_BROWSER_READY ") && !browserTask) {
            browserTask = (async () => {
              let result;
              try {
                const { verifyControlPlaneBrowser } =
                  await import("./verify-control-plane-browser.mjs");
                const verification = await verifyControlPlaneBrowser({
                  name,
                  ready: JSON.parse(line.slice("BB_BROWSER_READY ".length)),
                });
                result = { ok: true, verification };
              } catch (error) {
                browserError = error;
                result = { ok: false };
              }
              await promisify(execFile)("docker", [
                "exec",
                name,
                "node",
                "-e",
                "const fs=require('node:fs');fs.writeFileSync('/tmp/bb-browser-result.pending',process.argv[1],{mode:0o600});fs.renameSync('/tmp/bb-browser-result.pending','/tmp/bb-browser-result.json')",
                JSON.stringify(result),
              ]);
            })().catch((error) => {
              browserError ??= error;
            });
          }
        }
      });
    }
    child.once("error", reject);
    child.once("exit", (code) => complete(code));
  });
}

try {
  const denied = await docker([
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "none",
    "--user",
    "0:0",
    "--read-only",
    "--mount",
    "type=volume,dst=/srv/agent-users",
    "--mount",
    "type=volume,dst=/var/lib/bb-agent-launcher",
    "--entrypoint",
    "node",
    "bb-control-plane:local",
    "namespace-denial.mjs",
  ]);
  if (denied !== 0)
    throw new Error(`Namespace denial check failed (${denied})`);
  for (const nativeMaintenanceOnly of [true, false]) {
    const startedAt = Date.now();
    const deadline = setTimeout(
      () => {
        void docker(["rm", "--force", name]);
      },
      nativeMaintenanceOnly ? 180000 : browserMode ? 690000 : 570000,
    );
    try {
      const code = await docker([
        "run",
        "--rm",
        "--name",
        name,
        ...(nativeMaintenanceOnly
          ? [
              "--network",
              "none",
              "--env",
              "BB_CONTROL_PLANE_NATIVE_MAINTENANCE_TEST=1",
            ]
          : browserMode
            ? [
                "--publish",
                "127.0.0.1:8080:8080",
                "--env",
                "BB_CONTROL_PLANE_BROWSER_TEST=1",
              ]
            : ["--network", "none"]),
        "--user",
        "0:0",
        "--read-only",
        "--security-opt",
        `seccomp=${seccomp}`,
        "--security-opt",
        "systempaths=unconfined",
        "--tmpfs",
        "/srv/bb:uid=1000,gid=1000,mode=0700",
        "--tmpfs",
        "/tmp:mode=1777",
        "--mount",
        "type=volume,dst=/srv/agent-users",
        "--mount",
        "type=volume,dst=/var/lib/bb-agent-launcher",
        "--entrypoint",
        "node",
        "bb-control-plane:local",
        "deployment-check.mjs",
      ]);
      if (code !== 0) throw new Error(`Deployment check failed (${code})`);
      console.log(
        JSON.stringify({
          controlPlaneDeploymentSuite: nativeMaintenanceOnly
            ? "native-maintenance"
            : "composite",
          durationMs: Date.now() - startedAt,
          passed: true,
        }),
      );
    } finally {
      clearTimeout(deadline);
      await docker(["rm", "--force", name]);
    }
  }
  await browserTask;
  if (browserError) throw browserError;
  if (browserMode && !browserTask)
    throw new Error("Browser fixture did not run");
} finally {
  await docker(["rm", "--force", name]);
  await rm(directory, { recursive: true, force: true });
}
