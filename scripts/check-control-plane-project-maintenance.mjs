import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export async function verifyProjectMaintenance({
  alice,
  charlie,
  project,
  service,
  as,
  denied,
}) {
  const jobs = [];
  const grant = (role) =>
    service({
      mode: "policy-grant",
      projectId: project.projectId,
      userId: charlie.id,
      role,
    });
  const maintenance = (user) =>
    service({
      mode: "maintenance",
      userId: user.id,
      request: { action: "status" },
    });
  async function start(user, generation, held = false) {
    const id = randomUUID();
    const child = spawn(
      "/usr/bin/setpriv",
      [
        "--reuid=1000",
        "--regid=1000",
        "--clear-groups",
        process.execPath,
        "-e",
        'const c=require("node:child_process").spawn("/usr/bin/sudo",process.argv.slice(1),{stdio:"inherit"});c.on("error",()=>process.exit(1));c.on("exit",code=>process.exit(code??1));',
        "--",
        "-n",
        "--",
        "/opt/bb-control-plane/launcher/helper.py",
        "launch-script",
        user.id,
        String(user.uid),
        `--uid-generation=${generation}`,
        id,
        user.projectsRoot + "/default",
      ],
      {
        cwd: "/opt/bb",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        stdio: "pipe",
      },
    );
    let output = "",
      errors = "";
    child.stdout.on("data", (part) => {
      output += part;
      assert.ok(output.length < 65536);
    });
    child.stderr.on("data", (part) => {
      errors += part;
      assert.ok(errors.length < 65536);
    });
    child.stdin.on("error", () => {});
    const done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    jobs.push({ child, done });
    child.stdin.end(
      held
        ? `import fs from "node:fs";import cp from "node:child_process";const fd=fs.openSync(${JSON.stringify(project.cwd + "/shared.txt")},"r");cp.spawn(process.execPath,["-e",'require("node:fs").readFileSync(3);console.log("ready");setInterval(()=>{},1000)'],{stdio:["ignore","inherit","inherit",fd]});setInterval(()=>{},1000);`
        : 'console.log("ready");setInterval(()=>{},1000);',
    );
    const deadline = Date.now() + 10000;
    while (!output.includes("ready")) {
      if (child.exitCode !== null)
        throw new Error("Group job exited: " + errors);
      if (Date.now() > deadline)
        throw new Error("Group job readiness timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { child, done };
  }
  const assertStopped = async (rows) => {
    for (const job of rows) assert.equal(await job.done, 0);
  };
  let interrupted;
  try {
    await grant("runner");
    const firstJobs = [await start(alice, 0), await start(charlie, 0)];
    const firstId = randomUUID();
    const complete = await service({
      mode: "group",
      projectId: project.projectId,
      operationId: firstId,
    });
    assert.equal(complete.phase, "complete");
    assert.equal(complete.workerId, null);
    assert.deepEqual(
      complete.participants.map((p) => p.uid).sort(),
      [alice.uid, charlie.uid].sort(),
    );
    assert.ok(complete.participants.every((p) => p.generation === 1));
    await assertStopped(firstJobs);
    assert.deepEqual(
      await service({
        mode: "group",
        operationId: firstId,
        projectId: project.projectId,
      }),
      complete,
    );
    await assert.rejects(
      service({
        mode: "group",
        operationId: firstId,
        projectId: project.projectId,
        expectedAttempt: 1,
      }),
      (error) => error.stderr?.includes("closed"),
    );
    await as(
      charlie,
      `require("node:fs").writeFileSync(${JSON.stringify(project.cwd + "/shared.txt")},"preserved-shared-content")`,
    );
    await as(
      alice,
      `require("node:assert/strict").equal(require("node:fs").readFileSync(${JSON.stringify(project.cwd + "/shared.txt")},"utf8"),"preserved-shared-content")`,
    );
    await denied(charlie, alice.home + "/credential.txt");
    await grant(null);
    const revokeJobs = [await start(alice, 1), await start(charlie, 1, true)];
    interrupted = await service({
      mode: "group-cut-release",
      projectId: project.projectId,
      operationId: randomUUID(),
    });
    await assertStopped(revokeJobs);
    assert.equal(interrupted.phase, "releasing");
    assert.ok(interrupted.workerId);
    assert.ok(
      interrupted.participants.some(
        (p) => p.userId === charlie.id && p.generation === 2,
      ),
    );
    assert.equal((await maintenance(alice)).blocked, false);
    assert.equal((await maintenance(charlie)).blocked, true);
    await denied(charlie, project.cwd + "/shared.txt");
    await assert.rejects(
      service({
        mode: "coordinate",
        userId: alice.id,
        request: {
          action: "finish",
          operationId: interrupted.id,
          generation: 2,
        },
      }),
      (error) => error.stderr?.includes("Grouped maintenance"),
    );
  } finally {
    for (const job of jobs)
      if (job.child.exitCode === null) job.child.kill("SIGTERM");
  }
  return {
    verification: {
      projectMaintenanceStopsAllParticipantJobsAndDescriptorChildren: true,
      projectMaintenanceRootFormerWriterRetainedAfterGrantRemoval: true,
      projectMaintenancePartialRootReleaseKeepsGroupPending: true,
      projectMaintenancePrivateUidControllerCannotReleaseGroup: true,
    },
    async verifyPersistence() {
      const saved = await service({
        mode: "group-status",
        operationId: interrupted.id,
      });
      assert.equal(saved.phase, "releasing");
      assert.deepEqual(saved.participants, interrupted.participants);
      const complete = await service({
        mode: "group",
        projectId: project.projectId,
        operationId: interrupted.id,
      });
      assert.equal(complete.phase, "complete");
      assert.equal(complete.workerId, null);
      assert.equal(complete.attempt, 1);
      assert.deepEqual(complete.participants, interrupted.participants);
      for (const user of [alice, charlie]) {
        const state = await maintenance(user);
        assert.equal(state.blocked, false);
        assert.equal(state.generation, 2);
      }
      await denied(charlie, project.cwd + "/shared.txt");
      await as(
        alice,
        `require("node:assert/strict").equal(require("node:fs").readFileSync(${JSON.stringify(project.cwd + "/shared.txt")},"utf8"),"preserved-shared-content")`,
      );
      return {
        projectMaintenanceDeadWorkerReclaimedAfterRestart: true,
        projectMaintenancePartialReleaseResumesWithoutResettingGenerations: true,
        projectMaintenanceFormerWriterRevocationAndContentPersist: true,
      };
    },
  };
}
