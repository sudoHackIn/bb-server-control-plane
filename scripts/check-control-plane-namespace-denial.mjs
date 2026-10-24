import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";

const id = randomUUID();
const helper = "/opt/bb-control-plane/launcher/helper.py";
const invoke = (args) =>
  spawnSync(
    "/usr/bin/setpriv",
    [
      "--reuid=1000",
      "--regid=1000",
      "--clear-groups",
      "--",
      "/usr/bin/sudo",
      "-n",
      "--",
      helper,
      ...args,
    ],
    { encoding: "utf8", timeout: 15000 },
  );
const provision = invoke(["provision", id, "200000"]);
assert.equal(provision.status, 0, provision.stderr);
const { cwd } = JSON.parse(provision.stdout);
const result = invoke([
  "launch",
  id,
  "200000",
  randomUUID(),
  cwd,
  "--",
  "--version",
]);
assert.equal(result.error, undefined);
assert.notEqual(result.status, 0);
assert.equal(result.stdout.trim(), "");
assert.match(
  result.stderr,
  /unshare: unshare failed: Operation not permitted/u,
);
assert.deepEqual(readdirSync("/var/lib/bb-agent-launcher/jobs"), []);
console.log(
  JSON.stringify({ actualLauncherFailsClosedWithoutNamespaces: true }),
);
