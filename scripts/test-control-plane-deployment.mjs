import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeControlPlaneSeccomp } from "./control-plane-seccomp.mjs";

const name = `bb-control-plane-check-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), "bb-control-plane-security-"));
const seccomp = join(directory, "seccomp.json");
await writeControlPlaneSeccomp(seccomp);
function docker(args) {
  return new Promise((complete, reject) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => complete(code));
  });
}

const deadline = setTimeout(() => {
  void docker(["rm", "--force", name]);
}, 210000);
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
  const code = await docker([
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "none",
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
} finally {
  clearTimeout(deadline);
  await docker(["rm", "--force", name]);
  await rm(directory, { recursive: true, force: true });
}
