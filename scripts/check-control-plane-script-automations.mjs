import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function verifyScriptAutomations({
  subjects,
  rpc,
  storage,
  wait,
  commandProcesses,
  userRequest,
  userCommand,
  setPluginEnabled,
}) {
  const definitions = [];
  let crashCases = [];
  let shutdownCases = [];
  async function create(subject, source, runAt = Date.now() + 3600000) {
    const value = await rpc("automations_create", {
      projectId: subject.project.projectId,
      createdByThreadId: subject.thread.id,
      name: `node-script-${randomUUID()}`,
      enabled: true,
      origin: "human",
      trigger: { triggerType: "once", runAt },
      execution: {
        mode: "script",
        interpreter: "node",
        script: source,
        workingDirectory: { type: "project" },
        timeoutMs: 30000,
      },
    });
    definitions.push({ subject, value });
    return value;
  }
  const input = (value) => ({
    automationId: value.id,
    projectId: value.projectId,
  });
  async function run(value, key = randomUUID()) {
    return (
      await rpc("automations_run", { ...input(value), idempotencyKey: key })
    ).run;
  }
  const row = (id) =>
    storage.prepare("SELECT * FROM automation_runs WHERE id=?").get(id);
  async function terminal(id, expected) {
    await wait(() => {
      const value = row(id);
      if (value?.status !== "running" && value?.status !== expected)
        throw new Error(JSON.stringify(value));
      return value?.status === expected;
    }, `script run settles ${expected}`);
    return row(id);
  }
  for (const subject of subjects) {
    const source =
      'console.log(JSON.stringify({uid:process.getuid(),home:process.env.HOME,cwd:process.cwd(),job:process.env.BB_AGENT_JOB_ID,backend:!!process.env.BB_SERVER_TOKEN}));console.error("native-script-stderr");';
    const value = await userCommand(
      subject.user.login,
      [
        "automations",
        "create",
        subject.thread.id,
        "--name",
        `personal-script-${randomUUID()}`,
        "--script-stdin",
        "--timeout-ms",
        "30000",
        "--at",
        String(Date.now() + 3600000),
        "--json",
      ],
      source,
    );
    assert.equal(value.executionMode, "script");
    const detail = await userCommand(subject.user.login, [
      "automations",
      "definition",
      value.id,
      "--json",
    ]);
    assert.equal(detail.script.source, source);
    const first = await userCommand(subject.user.login, [
      "automations",
      "run",
      value.id,
      "--idempotency-key",
      "stable-script-manual",
      "--json",
    ]);
    assert.equal(first.runMode, "script");
    assert.equal(first.threadId, null);
    const result = await terminal(first.id, "succeeded");
    assert.equal(result.thread_id, null);
    const output = JSON.parse(result.output);
    const actual = JSON.parse(output.stdout);
    assert.deepEqual(actual, {
      uid: subject.user.uid,
      home: subject.user.home,
      cwd: subject.project.cwd,
      job: output.jobId,
      backend: false,
    });
    assert.match(output.stderr, /native-script-stderr/u);
    const personalOutput = await userCommand(subject.user.login, [
      "automations",
      "output",
      value.id,
      first.id,
      "--json",
    ]);
    assert.deepEqual(personalOutput.result, output);
    assert.equal(personalOutput.cleanupPending, false);
    const denied = subjects.find((item) => item.user.id !== subject.user.id);
    assert.equal(
      (
        await userRequest(
          denied.user.login,
          `/control-plane/user/automations/${value.id}/runs/${first.id}/output`,
        )
      ).status,
      404,
    );

    const saved = storage
      .prepare(
        "SELECT a.job_id,r.binding_id,a.result_json,a.cleanup_error FROM automation_script_attempts a JOIN automation_run_authorities r ON r.run_id=a.run_id WHERE a.run_id=?",
      )
      .get(first.id);
    assert.equal(saved.job_id, output.jobId);
    assert.equal(saved.binding_id, output.jobId);
    assert.equal(saved.cleanup_error, null);
    assert.deepEqual(JSON.parse(saved.result_json), output);
    assert.equal((await run(value, "stable-script-manual")).id, first.id);
    assert.equal(
      storage
        .prepare(
          "SELECT count(*) AS n FROM automation_runs WHERE automation_id=?",
        )
        .get(value.id).n,
      1,
    );
    const other = subjects.find((item) => item.user.id !== subject.user.id);
    assert.equal(
      (
        await userRequest(
          other.user.login,
          `/control-plane/user/automations/${value.id}`,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await userRequest(
          subject.user.login,
          `/control-plane/user/automations/${value.id}`,
        )
      ).status,
      200,
    );
  }
  async function hanging(subject) {
    const marker = `script-${randomUUID()}`;
    const file = `${subject.user.home}/bb-personal-${marker}.json`;
    const source = `import fs from 'node:fs';import {spawn} from 'node:child_process';spawn(process.execPath,['-e','setInterval(()=>{},1000)',${JSON.stringify(file)}],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(file)},JSON.stringify({uid:process.getuid(),home:process.env.HOME,cwd:process.cwd()}));console.log('ready');setInterval(()=>{},1000);`;
    const value = await create(subject, source);
    const started = await run(value);
    await wait(
      async () => (await commandProcesses(marker)).length > 0,
      "native script detached command starts",
    );
    const proof = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(proof, {
      uid: subject.user.uid,
      home: subject.user.home,
      cwd: subject.project.cwd,
    });
    return { subject, value, started, marker };
  }
  const [alice, bob] = await Promise.all(subjects.map(hanging));
  await rpc("automations_pause", input(alice.value));
  await terminal(alice.started.id, "cancelled");
  assert.equal((await commandProcesses(alice.marker)).length, 0);
  assert.ok((await commandProcesses(bob.marker)).length > 0);
  assert.equal(
    (
      await rpc("controlPlaneAutomationStop", {
        ...input(bob.value),
        runId: bob.started.id,
      })
    ).stopped,
    true,
  );
  await terminal(bob.started.id, "cancelled");
  assert.equal((await commandProcesses(bob.marker)).length, 0);
  assert.equal(
    storage
      .prepare(
        "SELECT enabled,consecutive_failures FROM automations WHERE id=?",
      )
      .get(bob.value.id).enabled,
    1,
  );
  assert.equal(
    storage
      .prepare("SELECT consecutive_failures FROM automations WHERE id=?")
      .get(bob.value.id).consecutive_failures,
    0,
  );
  const deleted = await hanging(subjects[0]);
  await rpc("automations_delete", input(deleted.value));
  assert.equal((await commandProcesses(deleted.marker)).length, 0);
  const scheduled = await create(
    subjects[0],
    'console.log("scheduled-script");',
    Date.now() + 1000,
  );
  await wait(
    () =>
      storage
        .prepare("SELECT status FROM automation_runs WHERE automation_id=?")
        .get(scheduled.id)?.status === "succeeded",
    "native script once schedule executes",
  );
  assert.equal(
    storage
      .prepare(
        "SELECT count(*) AS n FROM automation_runs WHERE automation_id=?",
      )
      .get(scheduled.id).n,
    1,
  );
  const unloading = await Promise.all(subjects.map(hanging));
  await setPluginEnabled(false);
  for (const item of unloading) {
    await terminal(item.started.id, "cancelled");
    assert.equal((await commandProcesses(item.marker)).length, 0);
    assert.equal(
      (
        await userRequest(
          item.subject.user.login,
          `/control-plane/user/automations/${item.value.id}`,
        )
      ).status,
      503,
    );
  }
  await setPluginEnabled(true);
  const fresh = await run(unloading[0].value);
  await wait(
    async () => (await commandProcesses(unloading[0].marker)).length > 0,
    "re-enabled script controller admits a fresh run",
  );
  assert.notEqual(fresh.id, unloading[0].started.id);
  await rpc("controlPlaneAutomationStop", {
    ...input(unloading[0].value),
    runId: fresh.id,
  });
  await terminal(fresh.id, "cancelled");
  assert.equal((await commandProcesses(unloading[0].marker)).length, 0);
  return {
    verification: {
      nativeScriptAutomationsTwoOwnerUidHomeCwd: true,
      nativeScriptAutomationDurableJobAndResult: true,
      nativeScriptManualIdempotency: true,
      nativeScriptForeignMetadataDenied: true,
      personalScriptCliCreateDefinitionRunAndOutput: true,
      personalScriptForeignOutputDenied: true,
      nativeScriptPauseAndIndividualCancelReapDescendants: true,
      nativeScriptCancellationPreservesOtherOwnerAndFailureBudget: true,
      nativeScriptDeleteReapsBeforeRemoval: true,
      nativeScriptOnceScheduleSingleFire: true,
      scriptPluginUnloadReapsBothOwnerCommandsBeforeStorageClose: true,
      disabledScriptPluginPublicApiUnavailable: true,
      reenabledScriptControllerAdmitsFreshRun: true,
    },
    async beforeCrash(serverPid) {
      crashCases = await Promise.all(subjects.map(hanging));
      process.kill(serverPid, "SIGSTOP");
      const writable = new Database("/srv/bb/plugins/automations/data.db");
      try {
        const changed = writable
          .prepare(
            "UPDATE automation_run_authorities SET cancel_requested_at=? WHERE run_id=?",
          )
          .run(Date.now(), crashCases[0].started.id);
        assert.equal(changed.changes, 1);
      } catch (error) {
        process.kill(serverPid, "SIGCONT");
        throw error;
      } finally {
        writable.close();
      }
    },
    async afterCrash() {
      const current = new Database("/srv/bb/plugins/automations/data.db", {
        readonly: true,
      });
      try {
        for (const [index, item] of crashCases.entries()) {
          const expected = index === 0 ? "cancelled" : "failed";
          await wait(
            () =>
              current
                .prepare("SELECT status FROM automation_runs WHERE id=?")
                .get(item.started.id)?.status === expected,
            "script crash cleanup reaches terminal state",
          );
          assert.equal((await commandProcesses(item.marker)).length, 0);
          assert.equal(
            current
              .prepare(
                "SELECT count(*) AS n FROM automation_runs WHERE automation_id=?",
              )
              .get(item.value.id).n,
            1,
          );
          assert.equal(
            current
              .prepare(
                "SELECT cleanup_error FROM automation_script_attempts WHERE run_id=?",
              )
              .get(item.started.id).cleanup_error,
            null,
          );
        }
        return {
          nativeScriptPendingCancelSurvivesActualServerCrash: true,
          nativeScriptInterruptedRunIsNotRelaunchedAfterCrash: true,
          nativeScriptCrashCleanupReapsActualCommands: true,
        };
      } finally {
        current.close();
      }
    },
    async beforeRestart() {
      shutdownCases = await Promise.all(subjects.map(hanging));
      const value = await create(
        subjects[1],
        'console.log("offline-script");',
        Date.now() + 5000,
      );
      return value;
    },
    async afterShutdown(offline) {
      for (const item of shutdownCases) {
        assert.equal(row(item.started.id).status, "cancelled");
        assert.equal((await commandProcesses(item.marker)).length, 0);
        assert.equal(
          storage
            .prepare(
              "SELECT cleanup_error FROM automation_script_attempts WHERE run_id=?",
            )
            .get(item.started.id).cleanup_error,
          null,
        );
        assert.equal(
          storage
            .prepare("SELECT consecutive_failures FROM automations WHERE id=?")
            .get(item.value.id).consecutive_failures,
          0,
        );
      }
      assert.equal(
        storage
          .prepare(
            "SELECT count(*) AS n FROM automation_runs WHERE automation_id=?",
          )
          .get(offline.id).n,
        0,
      );
    },
    async afterRestart(offline) {
      await wait(
        () =>
          storage
            .prepare("SELECT status FROM automation_runs WHERE automation_id=?")
            .get(offline.id)?.status === "succeeded",
        "saved owner script schedule starts after restart",
      );
      assert.equal(
        storage
          .prepare(
            "SELECT count(*) AS n FROM automation_runs WHERE automation_id=?",
          )
          .get(offline.id).n,
        1,
      );
      return {
        nativeScriptScheduleRestoresOwnerAndSingleFire: true,
        activeScriptGracefulShutdownPersistsCancelAndReapsCommands: true,
      };
    },
  };
}
