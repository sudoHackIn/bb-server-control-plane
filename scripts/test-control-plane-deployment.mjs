import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const name = `bb-control-plane-check-${randomUUID()}`;
function docker(args) {
  return new Promise((complete, reject) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => complete(code));
  });
}

const deadline = setTimeout(() => {
  void docker(["rm", "--force", name]);
}, 90000);
try {
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
}
