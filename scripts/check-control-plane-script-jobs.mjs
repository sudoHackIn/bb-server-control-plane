import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, readdir, writeFile, chown } from "node:fs/promises";
import Database from "better-sqlite3";

export async function verifyScriptJobs({ command, launch, signal }) {
  const db = new Database("/srv/bb/bb.db", { readonly: true });
  const users = db
    .prepare(
      "SELECT id,uid,home,projects_root FROM control_plane_users ORDER BY uid",
    )
    .all();
  db.close();
  assert.equal(users.length, 2);
  const args = (user, job, cwd = `${user.projects_root}/app`) => [
    "script-job-client.mjs",
    "launch-script",
    user.id,
    String(user.uid),
    job,
    cwd,
  ];
  const stop = (user, job) =>
    command(["script-job-client.mjs", "stop", user.id, String(user.uid), job]);
  for (const user of users) {
    await writeFile(`${user.home}/script-private`, "private", { mode: 0o600 });
    await chown(`${user.home}/script-private`, user.uid, user.uid);
    const module = `${user.projects_root}/app/script-runtime-module.mjs`;
    await writeFile(module, `export const marker = ${user.uid};`, {
      mode: 0o600,
    });
    await chown(module, user.uid, user.uid);
  }
  for (const user of users) {
    const other = users.find((row) => row.id !== user.id);
    const source = `import fs from 'node:fs'; import {marker} from './script-runtime-module.mjs';
      const denied = path => { try {fs.readFileSync(path);return false;}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e;return true;} };
      let escalationDenied=false;try{process.setuid(0)}catch{escalationDenied=true}
      console.log(JSON.stringify({moduleMarker:marker,noForeignProcesses:fs.readdirSync('/proc').filter(name=>/^[0-9]+$/.test(name)).every(name=>fs.statSync('/proc/'+name).uid===process.getuid()),uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),home:process.env.HOME,cwd:process.cwd(),otherDenied:denied(${JSON.stringify(other.home + "/script-private")}),dbDenied:denied('/srv/bb/bb.db'),escalationDenied,credentialKeys:Object.keys(process.env).filter(k=>/TOKEN|SECRET|API_KEY|NODE_OPTIONS|BB_SERVER|BB_CLI/.test(k)),noNewPrivileges:fs.readFileSync('/proc/self/status','utf8').includes('NoNewPrivs:\\t1')}));`;
    const value = JSON.parse(
      await command(args(user, randomUUID()), source, {
        env: {
          ...process.env,
          HOME: "/home/node",
          OPENAI_API_KEY: "script-credential-must-not-cross",
          BB_SERVER_TOKEN: "script-backend-must-not-cross",
        },
      }),
    );
    assert.deepEqual(value, {
      moduleMarker: user.uid,
      noForeignProcesses: true,
      uid: user.uid,
      gid: user.uid,
      groups: [user.uid],
      home: user.home,
      cwd: `${user.projects_root}/app`,
      otherDenied: true,
      dbDenied: true,
      escalationDenied: true,
      credentialKeys: [],
      noNewPrivileges: true,
    });
    await assert.rejects(
      command(
        args(user, randomUUID(), other.projects_root + "/app"),
        "console.log('forbidden')",
      ),
    );
    await assert.rejects(
      command(
        [
          ...args(user, randomUUID()),
          "--",
          "--eval",
          "console.log('forbidden')",
        ],
        "",
      ),
    );
    const fenced = randomUUID();
    await stop(user, fenced);
    await assert.rejects(
      command(args(user, fenced), "console.log('forbidden')"),
    );
  }
  async function wait(test, description) {
    const deadline = Date.now() + 15000;
    while (!signal.aborted && Date.now() < deadline) {
      if (await test()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(description);
  }
  const running = [];
  try {
    for (const [index, user] of [users[0], users[0], users[1]].entries()) {
      const job = randomUUID();
      const marker = `script-runtime-${index}-${job}`;
      const path = `${user.home}/${marker}.json`;
      const source = `import fs from 'node:fs'; import {marker} from './script-runtime-module.mjs'; import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)',${JSON.stringify(marker)}],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(path)},JSON.stringify({uid:process.getuid(),job:process.env.BB_AGENT_JOB_ID}));setInterval(()=>{},1000);`;
      const process = launch(args(user, job));
      let stderr = "";
      process.stderr.on("data", (data) => {
        stderr = (stderr + data).slice(-4096);
      });
      process.stdout.resume();
      process.stdin.end(source);
      const exited = once(process, "exit", { signal });
      const record = { user, job, marker, path, process, exited };
      running.push(record);
      await wait(async () => {
        assert.equal(process.exitCode, null, stderr);
        try {
          return JSON.parse(await readFile(path, "utf8")).job === job;
        } catch (error) {
          if (error.code === "ENOENT" || error instanceof SyntaxError)
            return false;
          throw error;
        }
      }, "Isolated script did not start");
    }
    async function descendants(record) {
      const leasePath = `/var/lib/bb-agent-launcher/jobs/${record.job}.json`;
      let lease;
      try {
        lease = JSON.parse(await readFile(leasePath, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
      const result = [];
      for (const name of await readdir("/proc")) {
        if (!/^[0-9]+$/u.test(name)) continue;
        try {
          const cmd = await readFile(`/proc/${name}/cmdline`, "utf8");
          if (cmd.includes(record.marker)) result.push(Number(name));
        } catch (error) {
          if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
        }
      }
      assert.equal(lease.uid, record.user.uid);
      return result;
    }
    await wait(
      async () => (await descendants(running[0])).length > 0,
      "Detached script child missing",
    );
    await assert.rejects(stop(users[1], running[0].job));
    assert.equal(running[0].process.exitCode, null);
    const detached = await descendants(running[0]);
    await stop(running[0].user, running[0].job);
    await running[0].exited;
    await wait(async () => {
      for (const pid of detached) {
        try {
          await readFile(`/proc/${pid}/stat`);
          return false;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      return true;
    }, "Script command descendants survived stop");
    assert.equal(running[1].process.exitCode, null);
    assert.equal(running[2].process.exitCode, null);
    assert.ok((await descendants(running[2])).length > 0);
    const orphaned = await descendants(running[1]);
    assert.ok(orphaned.length > 0);
    running[1].process.kill("SIGKILL");
    await running[1].exited;
    await wait(async () => {
      for (const pid of orphaned) {
        try {
          await readFile(`/proc/${pid}/stat`);
          return false;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      return true;
    }, "Script commands survived caller death");
    assert.equal(running[2].process.exitCode, null);
    assert.ok((await descendants(running[2])).length > 0);
  } finally {
    for (const record of running) {
      await stop(record.user, record.job);
      await record.exited;
    }
  }
  return {
    fixedNodeEsmStdinRuntime: true,
    twoUserUidHomeCwdVerified: true,
    noServiceOrModelCredentials: true,
    scriptPrivateProcessMetadata: true,
    projectRelativeModuleImport: true,
    foreignHomeAndServiceDatabaseDenied: true,
    privilegeEscalationDenied: true,
    foreignCwdAndArgumentsDenied: true,
    stopBeforeStartFenced: true,
    foreignStopDenied: true,
    detachedCommandsReapedOnStop: true,
    sameUserAndOtherUserJobsSurviveUnrelatedStop: true,
    callerDeathReapsCommands: true,
    automationControllerIntegrationComplete: false,
  };
}
