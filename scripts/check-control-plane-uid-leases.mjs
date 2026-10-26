import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";

const exec = promisify(execFile);
const helper = "/opt/bb-control-plane/launcher/helper.py";
const broker =
  'const c=require("node:child_process").spawn("/usr/bin/sudo",process.argv.slice(1),{stdio:"inherit"});c.on("error",()=>process.exit(1));c.on("exit",code=>process.exit(code??1));';
const serviceArgs = [
  "--reuid=1000",
  "--regid=1000",
  "--clear-groups",
  process.execPath,
  "-e",
  broker,
  "--",
  "-n",
  "--",
  helper,
];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(20);
  }
  throw new Error("UID lease fixture timed out: " + label);
}
function observe(child) {
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (part) => {
    stdout += part;
    assert.ok(stdout.length < 65536);
  });
  child.stderr.on("data", (part) => {
    stderr += part;
    assert.ok(stderr.length < 65536);
  });
  child.stdin.on("error", () => {});
  const done = new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("close", (code) => resolve({ code }));
  });
  return { child, done, stdout: () => stdout, stderr: () => stderr };
}

export async function verifyProjectUidLeases({
  alice,
  bob,
  charlie,
  project,
  service,
  as,
  denied,
}) {
  const jobs = [];
  const tombstone = randomUUID();
  let unmanaged, exclusive;
  const change = (role) =>
    service({
      mode: "policy-grant",
      projectId: project.projectId,
      userId: bob.id,
      role,
    });
  const apply = () =>
    service({ mode: "policy-apply", projectId: project.projectId });
  const path =
    "/var/lib/bb-agent-launcher/project-access/" +
    alice.id +
    "-" +
    createHash("sha256").update(project.projectId).digest("hex") +
    ".json";
  const digest = async () =>
    createHash("sha256")
      .update(await readFile(path))
      .update(
        (
          await exec("/usr/bin/getfacl", [
            "--absolute-names",
            "--numeric",
            project.cwd,
          ])
        ).stdout,
      )
      .digest("hex");
  const idleCode = `console.log(JSON.stringify({ready:true,uid:process.getuid()}));setInterval(()=>{},1000);`;
  const heldCode = `import fs from "node:fs";import cp from "node:child_process";const fd=fs.openSync(${JSON.stringify(project.cwd + "/policy.txt")},"r");cp.spawn(process.execPath,["-e",'const fs=require("node:fs");fs.readFileSync(3);console.log(JSON.stringify({ready:true,uid:process.getuid(),heldDescriptor:true}));setInterval(()=>{},1000)'],{stdio:["ignore","inherit","inherit",fd]});setInterval(()=>{},1000);`;
  function start(user, code = idleCode) {
    const session = randomUUID();
    const observed = observe(
      spawn(
        "/usr/bin/setpriv",
        [
          ...serviceArgs,
          "launch-script",
          user.id,
          String(user.uid),
          session,
          user.projectsRoot + "/default",
        ],
        {
          cwd: "/opt/bb",
          env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
          stdio: "pipe",
        },
      ),
    );
    observed.child.stdin.end(code);
    const job = { ...observed, user, session, closed: false };
    jobs.push(job);
    return job;
  }
  async function ready(job) {
    await wait(() => {
      if (job.child.exitCode !== null)
        throw new Error("UID script exited before readiness: " + job.stderr());
      return job.stdout().includes('"ready":true');
    }, "script ready");
    assert.ok(job.stdout().includes('"uid":' + job.user.uid));
  }
  async function stop(job) {
    await exec(
      "/usr/bin/setpriv",
      [...serviceArgs, "stop", job.user.id, String(job.user.uid), job.session],
      {
        cwd: "/opt/bb",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        timeout: 12000,
        maxBuffer: 65536,
      },
    );
    assert.equal((await job.done).code, 0);
    job.closed = true;
  }
  async function busy() {
    const before = await digest();
    await assert.rejects(apply());
    assert.equal(
      await digest(),
      before,
      "Busy ACL attempt changed root policy or permissions",
    );
  }
  try {
    await change("runner");
    await apply();
    const first = start(bob, heldCode),
      second = start(bob, heldCode);
    await ready(first);
    await ready(second);
    assert.ok(first.stdout().includes('"heldDescriptor":true'));
    assert.ok(second.stdout().includes('"heldDescriptor":true'));
    const leasePath =
      "/var/lib/bb-agent-launcher/jobs/" + first.session + ".json";
    const savedLease = await readFile(leasePath);
    await change("viewer");
    await busy();
    await stop(first);
    await busy();
    await stop(second);
    await apply();
    await denied(bob, project.cwd + "/policy.txt");

    await change("runner");
    await writeFile(leasePath, savedLease, { flag: "wx", mode: 0o600 });
    try {
      await busy();
    } finally {
      await unlink(leasePath);
    }
    await apply();

    unmanaged = observe(
      spawn(
        "/usr/bin/setpriv",
        [
          "--reuid=" + bob.uid,
          "--regid=" + bob.gid,
          "--clear-groups",
          "--no-new-privs",
          process.execPath,
          "-e",
          idleCode,
        ],
        {
          cwd: bob.home,
          env: { HOME: bob.home, PATH: "/usr/local/bin:/usr/bin:/bin" },
          stdio: "pipe",
        },
      ),
    );
    await wait(
      () => unmanaged.stdout().includes('"ready":true'),
      "unmanaged process ready",
    );
    await change("viewer");
    await busy();
    unmanaged.child.kill("SIGTERM");
    await unmanaged.done;
    unmanaged = undefined;
    await apply();

    const savedReady = await readFile(path);
    const legacyReady = JSON.parse(savedReady.toString());
    delete legacyReady.writers;
    await writeFile(path, JSON.stringify(legacyReady));
    const legacyActor = start(bob);
    try {
      await ready(legacyActor);
      await busy();
      await stop(legacyActor);
      await apply();
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")).writers, []);
    } finally {
      await writeFile(path, savedReady);
    }

    exclusive = observe(
      spawn(
        "/usr/bin/python3",
        [
          "-I",
          "-c",
          `import runpy,sys,os\nfds=runpy.run_path('/opt/bb-control-plane/launcher/uid_leases.py')['acquire']([${bob.uid}],exclusive=True)\nprint('locked',flush=True)\nsys.stdin.read()\nfor fd in fds: os.close(fd)`,
        ],
        { stdio: "pipe" },
      ),
    );
    await wait(
      () => exclusive.stdout().includes("locked"),
      "exclusive UID lease",
    );
    const refused = start(bob);
    assert.notEqual((await refused.done).code, 0);
    refused.closed = true;
    await assert.rejects(
      readFile("/var/lib/bb-agent-launcher/jobs/" + refused.session + ".json"),
      { code: "ENOENT" },
    );
    const unaffected = start(charlie);
    await ready(unaffected);
    await stop(unaffected);
    exclusive.child.stdin.end();
    assert.equal((await exclusive.done).code, 0);
    exclusive = undefined;

    await change("runner");
    await exec(
      "/usr/bin/setpriv",
      [...serviceArgs, "stop", bob.id, String(bob.uid), tombstone],
      { timeout: 12000, maxBuffer: 65536 },
    );
    await apply();
    const tombstonePath =
      "/var/lib/bb-agent-launcher/jobs/" + tombstone + ".json";
    assert.equal(
      JSON.parse(await readFile(tombstonePath, "utf8")).stopped,
      true,
    );
    await unlink(tombstonePath);
    await as(
      alice,
      `require("node:fs").linkSync(process.env.HOME+"/credential.txt",${JSON.stringify(project.cwd + "/pending-hardlink")})`,
    );
    const removed = await change(null);
    await assert.rejects(apply());
    const pending = JSON.parse(await readFile(path, "utf8"));
    assert.equal(pending.phase, "pending");
    assert.deepEqual(pending.members, []);
    assert.ok(
      pending.writers.some(
        (row) => row.userId === bob.id && row.uid === bob.uid,
      ),
    );
    const pendingWriter = start(bob);
    await ready(pendingWriter);
    await busy();
    await stop(pendingWriter);
    await as(
      alice,
      `require("node:fs").unlinkSync(${JSON.stringify(project.cwd + "/pending-hardlink")})`,
    );
    const savedPending = await readFile(path);
    const legacy = { ...pending };
    delete legacy.writers;
    await writeFile(path, JSON.stringify(legacy));
    try {
      await busy();
    } finally {
      await writeFile(path, savedPending);
    }
    await apply();
    await denied(bob, project.cwd + "/policy.txt");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).writers, []);
    return {
      revision: removed.revision,
      verification: {
        projectAclManagedUidLifetimeLeasesSharedByTwoJobs: true,
        projectAclLiveHeldDescriptorJobsBlockMutationUntilBothStopped: true,
        projectAclStaleSupervisorLeaseBlocksMutation: true,
        projectAclUnmanagedUidProcessBlocksMutation: true,
        projectAclExclusiveLeaseRefusesNewLaunchBeforeJobRegistration: true,
        projectAclOtherUidLaunchRemainsAvailable: true,
        projectAclStoppedTombstoneDoesNotBlockMutation: true,
        projectAclPendingPriorWritersRemainInCleanupBarrier: true,
        projectAclLegacyPendingWriterStateRequiresReview: true,
        projectAclLegacyReadyAdoptionRequiresAllRegisteredUsersIdle: true,
        projectAclBusyAttemptsPreservePolicyAndAcl: true,
      },
    };
  } finally {
    if (unmanaged) {
      unmanaged.child.kill("SIGKILL");
      await unmanaged.done;
    }
    if (exclusive) {
      exclusive.child.stdin.end();
      await exclusive.done;
    }
    for (const job of jobs) if (!job.closed) await stop(job);
  }
}
