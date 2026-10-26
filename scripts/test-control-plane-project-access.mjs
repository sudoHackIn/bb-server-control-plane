import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeControlPlaneSeccomp } from "./control-plane-seccomp.mjs";

const name = `bb-project-access-check-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), "bb-project-access-security-"));
const seccomp = join(directory, "seccomp.json");
try {
  await writeControlPlaneSeccomp(seccomp);
  const result = spawnSync(
    "docker",
    [
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
      "check-control-plane-project-access.mjs",
      "--standalone",
    ],
    { stdio: "inherit", timeout: 120000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Project access check failed (${result.status})`);
} finally {
  spawnSync("docker", ["rm", "--force", "--volumes", name], {
    stdio: "ignore",
    timeout: 15000,
  });
  await rm(directory, { recursive: true, force: true });
}
