import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import Database from "better-sqlite3";

export async function verifyNativeWorkflows({
  launch,
  signal,
  wait,
  password,
  origin,
  subjects,
  db,
  userCommand,
}) {
  const env = {
    ...process.env,
    HOME: "/tmp/bb-workflow-admin",
    BB_SERVER_URL: origin,
    BB_CLI: "",
    BB_CLI_ERROR_LOG: "0",
    NODE_EXTRA_CA_CERTS: "/tmp/bb-test-certificates/ca.crt",
  };
  async function cli(args, subject, input = "") {
    const child = launch(["apps/cli/dist/index.js", ...args], {
      env: {
        ...env,
        ...(subject
          ? {
              BB_PROJECT_ID: subject.project.projectId,
              BB_THREAD_ID: subject.thread.id,
            }
          : {}),
      },
    });
    let output = "",
      error = "";
    child.stdout.on("data", (part) => (output += part));
    child.stderr.on("data", (part) => (error += part));
    child.stdin.end(input);
    assert.equal(
      (await once(child, "exit", { signal }))[0],
      0,
      error || output,
    );
    return JSON.parse(output);
  }
  await cli(
    [
      "server",
      "access",
      "login",
      "--login",
      "operator",
      "--password-stdin",
      "--json",
    ],
    null,
    password,
  );
  await cli(["plugin", "enable", "workflows", "--json"]);
  const runs = [];
  for (const subject of subjects) {
    const source =
      'export const meta = {name: "managed-owner-check", description: "Native ownership check"}; phase("computed"); return {value: 42};';
    const run = await cli(
      ["workflows", "run", "--script", source, "--json"],
      subject,
    );
    runs.push({ id: run.runId, subject });
  }
  function verify() {
    const storage = new Database("/srv/bb/plugins/workflows/data.db", {
      readonly: true,
    });
    try {
      for (const { id, subject } of runs) {
        const row = storage
          .prepare("SELECT * FROM workflow_runs WHERE id = ?")
          .get(id);
        assert.ok(row);
        assert.equal(row.owner_user_id, subject.user.id);
        assert.equal(row.project_id, subject.project.projectId);
        assert.equal(row.origin_thread_id, subject.thread.id);
        const binding = db
          .prepare("SELECT * FROM control_plane_job_bindings WHERE id = ?")
          .get(row.authority_binding_id);
        assert.ok(binding);
        assert.equal(binding.kind, "workflow-run");
        assert.equal(binding.object_id, id);
        assert.equal(binding.owner_user_id, subject.user.id);
        assert.equal(binding.project_id, row.project_id);
        assert.equal(
          binding.profile_version_id,
          subject.profile.body.version.id,
        );
        assert.equal(binding.origin_thread_id, subject.thread.id);
        const profile = JSON.parse(
          db
            .prepare(
              "SELECT definition FROM control_plane_profile_versions WHERE id = ?",
            )
            .get(binding.profile_version_id).definition,
        );
        assert.equal(row.origin_provider, profile.providerId);
        assert.equal(row.origin_model, profile.model);
        assert.equal(row.origin_reasoning_level, profile.reasoningLevel);
        assert.equal(row.origin_permission_mode, profile.permissionMode);
        assert.equal(row.status, "succeeded");
        assert.equal(row.error, null);
        assert.equal(row.phase, "computed");
        assert.deepEqual(JSON.parse(row.result_json), { value: 42 });
      }
    } finally {
      storage.close();
    }
  }
  await wait(() => {
    try {
      verify();
      return true;
    } catch {
      return false;
    }
  }, "native workflow ownership and isolated result");
  verify();
  const agentStorage = new Database("/srv/bb/plugins/workflows/data.db", {
    readonly: true,
  });
  const agentRuns = [];
  async function waitAgent(runId) {
    await wait(() => {
      const row = agentStorage
        .prepare("SELECT status, error FROM workflow_runs WHERE id = ?")
        .get(runId);
      if (row?.status === "failed") throw new Error(row.error);
      return row?.status === "succeeded";
    }, "native isolated agent workflow");
    return agentStorage
      .prepare("SELECT * FROM workflow_runs WHERE id = ?")
      .get(runId);
  }
  try {
    for (const subject of subjects) {
      const script = `export const meta = {name: "isolated-agent", description: "Real controlled Qwen worker"}; return await agent("BB_PERSONAL_workflow-agent-${subject.user.login}");`;
      const run = await cli(
        ["workflows", "run", "--script", script, "--json"],
        subject,
      );
      const row = await waitAgent(run.runId);
      assert.equal(
        JSON.parse(row.result_json),
        `Personal workflow-agent-${subject.user.login} completed`,
      );
      const call = agentStorage
        .prepare("SELECT * FROM workflow_calls WHERE run_id = ?")
        .get(run.runId);
      assert.equal(call.status, "succeeded");
      const owner = db
        .prepare("SELECT * FROM control_plane_threads WHERE thread_id = ?")
        .get(call.child_thread_id);
      const binding = db
        .prepare("SELECT * FROM control_plane_job_bindings WHERE id = ?")
        .get(owner.job_binding_id);
      assert.equal(owner.owner_user_id, subject.user.id);
      assert.equal(binding.source_binding_id, row.authority_binding_id);
      assert.equal(binding.kind, "workflow-worker");
      assert.equal(owner.profile_version_id, subject.profile.body.version.id);
      const proof = JSON.parse(
        await readFile(
          `${subject.user.home}/bb-personal-workflow-agent-${subject.user.login}.json`,
          "utf8",
        ),
      );
      assert.deepEqual(proof, {
        uid: subject.user.uid,
        home: subject.user.home,
        cwd: subject.project.cwd,
      });
      agentRuns.push({ subject, script, runId: run.runId });
      await wait(
        () =>
          db
            .prepare("SELECT archived_at FROM threads WHERE id = ?")
            .get(call.child_thread_id)?.archived_at > 0,
        "controlled worker retirement archive",
      );
    }
    const alice = subjects[0];
    const newer = db
      .prepare(
        "SELECT id FROM control_plane_profile_versions WHERE profile_id = ? ORDER BY version DESC LIMIT 1",
      )
      .get(alice.profile.body.profile.id);
    assert.notEqual(newer.id, alice.profile.body.version.id);
    const selectedScript = `export const meta = {name: "approved-worker-profile", description: "Explicit immutable profile"}; return await agent("BB_PERSONAL_workflow-profile-alice", {profileVersionId: "${newer.id}"});`;
    const selected = await cli(
      ["workflows", "run", "--script", selectedScript, "--json"],
      alice,
    );
    await waitAgent(selected.runId);
    const selectedCall = agentStorage
      .prepare("SELECT * FROM workflow_calls WHERE run_id = ?")
      .get(selected.runId);
    assert.equal(
      db
        .prepare(
          "SELECT profile_version_id FROM control_plane_threads WHERE thread_id = ?",
        )
        .get(selectedCall.child_thread_id).profile_version_id,
      newer.id,
    );
    async function deniedSelection(script, resume = null) {
      const count = db
        .prepare("SELECT count(*) AS count FROM threads")
        .get().count;
      const run = await cli(
        [
          "workflows",
          "run",
          "--script",
          script,
          ...(resume ? ["--resume", resume] : []),
          "--json",
        ],
        alice,
      );
      await wait(
        () =>
          agentStorage
            .prepare("SELECT status FROM workflow_runs WHERE id = ?")
            .get(run.runId)?.status === "failed",
        "denied worker profile",
      );
      assert.equal(
        db.prepare("SELECT count(*) AS count FROM threads").get().count,
        count,
      );
    }
    const beforeSelectedReplay = db
      .prepare("SELECT count(*) AS count FROM threads")
      .get().count;
    const selectedReplay = await cli(
      [
        "workflows",
        "run",
        "--script",
        selectedScript,
        "--resume",
        selected.runId,
        "--json",
      ],
      alice,
    );
    await waitAgent(selectedReplay.runId);
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM threads").get().count,
      beforeSelectedReplay,
    );
    await cli([
      "server",
      "access",
      "profiles",
      "disable",
      alice.profile.body.profile.id,
      "--version",
      newer.id,
      "--json",
    ]);
    try {
      await deniedSelection(selectedScript, selected.runId);
    } finally {
      await cli([
        "server",
        "access",
        "profiles",
        "enable",
        alice.profile.body.profile.id,
        "--version",
        newer.id,
        "--json",
      ]);
    }
    await deniedSelection(
      selectedScript.replace(newer.id, subjects[1].profile.body.version.id),
    );
    await deniedSelection(
      `export const meta = {name:"conflicting-profile-model", description:"Runtime profile admission"}; const options = {profileVersionId:"${newer.id}", provider:"qwen-server", model:"unapproved-model", reasoningLevel:"none"}; return await agent("must-not-run", options);`,
    );
    const beforeReplay = db
      .prepare("SELECT count(*) AS count FROM threads")
      .get().count;
    const resumed = await cli(
      [
        "workflows",
        "run",
        "--script",
        agentRuns[0].script,
        "--resume",
        agentRuns[0].runId,
        "--json",
      ],
      agentRuns[0].subject,
    );
    await waitAgent(resumed.runId);
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM threads").get().count,
      beforeReplay,
    );
    const replayed = agentStorage
      .prepare("SELECT replay_source FROM workflow_calls WHERE run_id = ?")
      .get(resumed.runId);
    assert.equal(replayed.replay_source, "resumed-run");
    const structured = await cli(
      [
        "workflows",
        "run",
        "--script",
        'export const meta = {name: "isolated-json", description: "Structured worker result"}; return await agent("BB_PERSONAL_workflow-json-alice", {schema:{type:"object",properties:{value:{type:"number"}},required:["value"]}});',
        "--json",
      ],
      subjects[0],
    );
    assert.deepEqual(
      JSON.parse((await waitAgent(structured.runId)).result_json),
      { value: 42 },
    );
    const pending = await cli(
      [
        "workflows",
        "run",
        "--script",
        'export const meta = {name: "isolated-agent-cancel", description: "RPC and worker cancellation"}; return await agent("BB_PERSONAL_worker-hang-agent-alice");',
        "--json",
      ],
      subjects[0],
    );
    await wait(async () => {
      try {
        await readFile(
          `${subjects[0].user.home}/bb-personal-worker-hang-agent-alice.json`,
        );
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    }, "running native agent before cancellation");
    const pendingCall = agentStorage
      .prepare("SELECT child_thread_id FROM workflow_calls WHERE run_id = ?")
      .get(pending.runId);
    assert.ok(pendingCall.child_thread_id);
    await cli(["workflows", "stop", pending.runId, "--json"], subjects[0]);
    await wait(
      () =>
        db
          .prepare("SELECT status FROM threads WHERE id = ?")
          .get(pendingCall.child_thread_id)?.status === "idle",
      "cancelled RPC worker stopped",
    );
    assert.equal(
      agentStorage
        .prepare("SELECT status FROM workflow_calls WHERE run_id = ?")
        .get(pending.runId).status,
      "cancelled",
    );
  } finally {
    agentStorage.close();
  }
  const first = subjects[0];
  const negativeRuns = [];
  for (const [body, reason] of [
    [
      'return await workflow("must-not-run-in-service");',
      /workflow\(\) is unavailable/u,
    ],
    ['return "x";', /Workflow result is invalid/u],
  ]) {
    const outputSchema = reason.source.includes("result")
      ? ', outputSchema: {type: "number"}'
      : "";
    const run = await cli(
      [
        "workflows",
        "run",
        "--script",
        `export const meta = {name: "managed-denial", description: "Scoped execution check"${outputSchema}}; ${body}`,
        "--json",
      ],
      first,
    );
    negativeRuns.push({ id: run.runId, reason });
  }
  const pending = await cli(
    [
      "workflows",
      "run",
      "--script",
      'export const meta = {name: "managed-cancel", description: "Native cancellation"}; phase("waiting"); return await new Promise(() => {});',
      "--json",
    ],
    first,
  );
  const runtimeStorage = new Database("/srv/bb/plugins/workflows/data.db", {
    readonly: true,
  });
  try {
    await wait(
      () =>
        runtimeStorage
          .prepare("SELECT phase FROM workflow_runs WHERE id = ?")
          .get(pending.runId)?.phase === "waiting",
      "native pending evaluator",
    );
    await cli(["workflows", "stop", pending.runId, "--json"], first);
    assert.equal(
      runtimeStorage
        .prepare("SELECT status FROM workflow_runs WHERE id = ?")
        .get(pending.runId).status,
      "cancelled",
    );
    const pendingRow = runtimeStorage
      .prepare("SELECT authority_binding_id FROM workflow_runs WHERE id = ?")
      .get(pending.runId);
    assert.equal(
      db
        .prepare("SELECT enabled FROM control_plane_job_bindings WHERE id = ?")
        .get(pendingRow.authority_binding_id).enabled,
      0,
    );
    for (const { id, reason } of negativeRuns) {
      await wait(
        () =>
          runtimeStorage
            .prepare("SELECT status FROM workflow_runs WHERE id = ?")
            .get(id)?.status === "failed",
        "managed capability/schema denial",
      );
      const row = runtimeStorage
        .prepare("SELECT error, result_json FROM workflow_runs WHERE id = ?")
        .get(id);
      assert.match(row.error, reason);
      assert.equal(row.result_json, null);
      assert.equal(
        runtimeStorage
          .prepare(
            "SELECT count(*) AS count FROM workflow_calls WHERE run_id = ?",
          )
          .get(id).count,
        0,
      );
    }
  } finally {
    runtimeStorage.close();
  }
  async function workerFixture(mode, input) {
    const child = launch([
      "workflow-worker-check.mjs",
      mode,
      ...(input ? [JSON.stringify(input)] : []),
    ]);
    let output = "",
      error = "";
    child.stdout.on("data", (part) => (output += part));
    child.stderr.on("data", (part) => (error += part));
    child.stdin.end();
    assert.equal((await once(child, "exit", { signal }))[0], 0, error);
    return JSON.parse(output);
  }
  const parentRuns = [];
  for (const subject of subjects) {
    const parent = await cli(
      [
        "workflows",
        "run",
        "--script",
        'export const meta = {name: "worker-authority", description: "Worker source cancellation"}; phase("worker-parent-ready"); return await new Promise(() => {});',
        "--json",
      ],
      subject,
    );
    parentRuns.push({ parentRunId: parent.runId, userId: subject.user.id });
  }
  const parentStorage = new Database("/srv/bb/plugins/workflows/data.db", {
    readonly: true,
  });
  try {
    await wait(
      () =>
        parentRuns.every(
          (parent) =>
            parentStorage
              .prepare("SELECT phase FROM workflow_runs WHERE id = ?")
              .get(parent.parentRunId)?.phase === "worker-parent-ready",
        ),
      "running worker parent workflows",
    );
  } finally {
    parentStorage.close();
  }
  const boundWorkers = await workerFixture("create", parentRuns);
  for (const [index, worker] of boundWorkers.entries()) {
    const subject = subjects[index];
    await userCommand(
      subject.user.login,
      ["threads", "send", worker.threadId, "--message-stdin", "--json"],
      `BB_PERSONAL_worker-hang-${subject.user.login}`,
    );
    await wait(async () => {
      try {
        const proof = JSON.parse(
          await readFile(
            `${subject.user.home}/bb-personal-worker-hang-${subject.user.login}.json`,
            "utf8",
          ),
        );
        assert.equal(proof.uid, subject.user.uid);
        assert.equal(proof.home, subject.user.home);
        assert.equal(proof.cwd, subject.project.cwd);
        return (
          db
            .prepare("SELECT status FROM threads WHERE id = ?")
            .get(worker.threadId)?.status === "active"
        );
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    }, "actual bound Qwen worker UID and active tool");
  }
  await assert.rejects(() =>
    userCommand(subjects[1].user.login, [
      "threads",
      "get",
      boundWorkers[0].threadId,
      "--json",
    ]),
  );
  await cli(
    ["workflows", "stop", parentRuns[0].parentRunId, "--json"],
    subjects[0],
  );
  await wait(
    () =>
      db
        .prepare("SELECT status FROM threads WHERE id = ?")
        .get(boundWorkers[0].threadId)?.status === "idle",
    "parent cancellation stops first bound Qwen worker",
  );
  assert.equal(
    db
      .prepare("SELECT status FROM threads WHERE id = ?")
      .get(boundWorkers[1].threadId)?.status,
    "active",
  );
  const beforeRejectedSend = db
    .prepare(
      "SELECT count(*) AS count FROM events WHERE thread_id = ? AND type = 'system/manager/user_message' ",
    )
    .get(boundWorkers[0].threadId).count;
  await assert.rejects(() =>
    userCommand(
      subjects[0].user.login,
      [
        "threads",
        "send",
        boundWorkers[0].threadId,
        "--message-stdin",
        "--json",
      ],
      "Must not resume a cancelled worker source",
    ),
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS count FROM events WHERE thread_id = ? AND type = 'system/manager/user_message' ",
      )
      .get(boundWorkers[0].threadId).count,
    beforeRejectedSend,
  );
  await cli(
    ["workflows", "stop", parentRuns[1].parentRunId, "--json"],
    subjects[1],
  );
  await wait(
    () =>
      db
        .prepare("SELECT status FROM threads WHERE id = ?")
        .get(boundWorkers[1].threadId)?.status === "idle",
    "parent cancellation stops second bound Qwen worker",
  );
  const evaluatorCheck = launch([
    "workflow-evaluator-check.mjs",
    JSON.stringify(
      subjects.map((subject) => ({
        userId: subject.user.id,
        projectId: subject.project.projectId,
        originThreadId: subject.thread.id,
      })),
    ),
  ]);
  let evaluatorOutput = "",
    evaluatorError = "";
  evaluatorCheck.stdout.on("data", (part) => (evaluatorOutput += part));
  evaluatorCheck.stderr.on("data", (part) => (evaluatorError += part));
  evaluatorCheck.stdin.end();
  assert.equal(
    (await once(evaluatorCheck, "exit", { signal }))[0],
    0,
    evaluatorError,
  );
  const evaluatorProof = JSON.parse(evaluatorOutput);
  const processProof = await verifyEvaluatorProcesses({
    launch,
    signal,
    wait,
    subjects,
  });
  return {
    verification: {
      ...processProof,
      ...evaluatorProof,
      nativeWorkflowCliOwnerAndPinnedProfile: true,
      nativeEvaluatorAgentToQwenRoundTrip: true,
      explicitWorkerProfileAppliedToNativeQwenTools: true,
      explicitWorkerProfilePrefixReplay: true,
      revokedSelectedProfileDeniedBeforeReplayOrWorker: true,
      foreignWorkerProfileAndModelTupleDenied: true,
      actualWorkerCreationThroughScopedFacade: true,
      twoUserAgentUidHomeCwdAndProfileVerified: true,
      completedAgentPrefixReplayAvoidsNewThread: true,
      structuredAgentResultThroughProcessProtocol: true,
      nativeAgentRpcAndWorkerCancellation: true,
      completedWorkerRetirementUsesScopedArchive: true,
      actualBoundQwenWorkersUseOwnerUidHomeAndCwd: true,
      parentWorkflowCancellationStopsMappedWorker: true,
      otherUsersWorkerSurvivesUnrelatedCancellation: true,
      cancelledWorkerResumeDeniedBeforeEvents: true,
      foreignOwnedWorkerReadDenied: true,
      nativeWorkflowCancellationAndAuthorityDisable: true,
      nativeWorkflowNestedFallbackDenied: true,
      nativeWorkflowOutputSchemaEnforced: true,
      nativeWorkflowIsolatedEvaluatorCompleted: true,
      nativeWorkflowEvaluatorIdentityAndCredentialIsolation: true,
    },
    async afterRestart() {
      verify();
      const workerRestart = await workerFixture("verify");
      await cli(
        [
          "server",
          "access",
          "login",
          "--login",
          "operator",
          "--password-stdin",
          "--json",
        ],
        null,
        password,
      );
      await wait(async () => {
        const { plugins } = await cli(["plugin", "list", "--json"]);
        const plugin = plugins.find((entry) => entry.id === "workflows");
        assert.notEqual(plugin?.status, "error", plugin?.statusDetail);
        return plugin?.status === "running";
      }, "workflow plugin registration after restart");
      const before = db
        .prepare("SELECT count(*) AS count FROM threads")
        .get().count;
      const resumed = await cli(
        [
          "workflows",
          "run",
          "--script",
          agentRuns[0].script,
          "--resume",
          agentRuns[0].runId,
          "--json",
        ],
        agentRuns[0].subject,
      );
      const storage = new Database("/srv/bb/plugins/workflows/data.db", {
        readonly: true,
      });
      try {
        await wait(() => {
          const row = storage
            .prepare("SELECT status,error FROM workflow_runs WHERE id = ?")
            .get(resumed.runId);
          if (row?.status === "failed") throw new Error(row.error);
          return row?.status === "succeeded";
        }, "agent prefix replay after server restart");
        assert.equal(
          storage
            .prepare(
              "SELECT replay_source FROM workflow_calls WHERE run_id = ?",
            )
            .get(resumed.runId).replay_source,
          "resumed-run",
        );
        assert.equal(
          db.prepare("SELECT count(*) AS count FROM threads").get().count,
          before,
        );
      } finally {
        storage.close();
      }
      return {
        ...workerRestart,
        nativeWorkflowOwnerBindingSurvivesRestart: true,
        isolatedAgentPrefixReplaySurvivesRestartWithoutNewWorker: true,
      };
    },
  };
}

async function verifyEvaluatorProcesses({ launch, signal, wait, subjects }) {
  const helper = "/opt/bb-control-plane/launcher/helper.py";
  async function invoke(args) {
    const child = launch(["-n", "--", helper, ...args], {
      file: "/usr/bin/sudo",
    });
    let output = "",
      error = "";
    child.stdout.on("data", (part) => (output += part));
    child.stderr.on("data", (part) => (error += part));
    child.stdin.end();
    return { code: (await once(child, "exit", { signal }))[0], output, error };
  }
  const active = [];
  try {
    for (const subject of subjects) {
      const jobId = randomUUID();
      const child = launch(
        [
          "-n",
          "--",
          helper,
          "launch-workflow",
          subject.user.id,
          String(subject.user.uid),
          jobId,
          subject.project.cwd,
        ],
        {
          file: "/usr/bin/sudo",
          env: {
            PATH: "/usr/local/bin:/usr/bin:/bin",
            OPENAI_API_KEY: "must-not-reach-workflow",
            NEURALDEAP_KEY: "must-not-reach-workflow",
          },
        },
      );
      const completed = once(child, "exit", { signal });
      let probe,
        error = "";
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const event = JSON.parse(line);
        if (event.type === "ready") probe = event;
      });
      child.stderr.on("data", (part) => (error += part));
      active.push({ child, completed, subject, jobId, lines, stopped: false });
      child.stdin.end(
        JSON.stringify({
          body: "return await new Promise(() => {});",
          args: null,
          maxAgentCalls: 1,
          maxConcurrentAgents: 1,
          timeoutMs: 60000,
        }),
      );
      await wait(() => {
        assert.equal(child.exitCode, null, error);
        return probe;
      }, "isolated workflow process readiness");
      assert.deepEqual(probe, {
        type: "ready",
        uid: subject.user.uid,
        home: subject.user.home,
        cwd: subject.project.cwd,
        backendCredential: false,
      });
      const lease = JSON.parse(
        await readFile(`/var/lib/bb-agent-launcher/jobs/${jobId}.json`, "utf8"),
      );
      assert.equal(lease.userId, subject.user.id);
      assert.equal(lease.uid, subject.user.uid);
      let found = false;
      for (const name of await readdir("/proc")) {
        if (!/^\d+$/u.test(name)) continue;
        try {
          const command = await readFile(`/proc/${name}/cmdline`, "utf8");
          if (!command.split("\0")[0].endsWith("/node")) continue;
          if (!command.includes("/opt/bb-control-plane/workflow-evaluator.mjs"))
            continue;
          const status = await readFile(`/proc/${name}/status`, "utf8");
          if (Number(status.match(/^Uid:\s+(\d+)/mu)[1]) !== subject.user.uid)
            continue;
          assert.match(status, /^NoNewPrivs:\s+1$/mu);
          assert.equal(
            BigInt(`0x${status.match(/^CapEff:\s+(\w+)/mu)[1]}`),
            0n,
          );
          assert.ok(
            status
              .match(/^NSpid:\s+(.+)/mu)[1]
              .trim()
              .split(/\s+/u).length >= 2,
          );
          found = true;
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
        }
      }
      assert.equal(
        found,
        true,
        "No evaluator process with the registered external UID",
      );
    }
    const [alice, bob] = active;
    const foreign = await invoke([
      "stop",
      bob.subject.user.id,
      String(bob.subject.user.uid),
      alice.jobId,
    ]);
    assert.notEqual(foreign.code, 0);
    assert.equal(alice.child.exitCode, null);
    const stopped = await invoke([
      "stop",
      alice.subject.user.id,
      String(alice.subject.user.uid),
      alice.jobId,
    ]);
    assert.equal(stopped.code, 0, stopped.error);
    await alice.completed;
    alice.stopped = true;
    assert.equal(bob.child.exitCode, null);
    await assert.rejects(
      readFile(`/var/lib/bb-agent-launcher/jobs/${alice.jobId}.json`),
      (error) => error.code === "ENOENT",
    );
    const injection = await invoke([
      "launch-workflow",
      alice.subject.user.id,
      String(alice.subject.user.uid),
      randomUUID(),
      alice.subject.project.cwd,
      "--",
      "--eval",
      "process.exit(0)",
    ]);
    assert.notEqual(injection.code, 0);
    assert.equal(injection.output, "");
    const wrongCwd = await invoke([
      "launch-workflow",
      alice.subject.user.id,
      String(alice.subject.user.uid),
      randomUUID(),
      bob.subject.project.cwd,
    ]);
    assert.notEqual(wrongCwd.code, 0);
    return {
      workflowExternalUidHomeCwdAndPidNamespace: true,
      workflowNoNewPrivilegesOrBackendCredential: true,
      workflowForeignStopAndCwdDenied: true,
      workflowSameUserCommandOverrideDenied: true,
      workflowStopPreservesOtherUsersEvaluator: true,
      workflowEvaluatorsReapedAfterCancellationAndRevocation: true,
    };
  } finally {
    for (const item of active) {
      if (!item.stopped) {
        const result = await invoke([
          "stop",
          item.subject.user.id,
          String(item.subject.user.uid),
          item.jobId,
        ]);
        assert.equal(result.code, 0, result.error);
        await item.completed;
      }
      item.lines.close();
    }
    for (const file of await readdir("/var/lib/bb-agent-launcher/jobs")) {
      const lease = JSON.parse(
        await readFile(`/var/lib/bb-agent-launcher/jobs/${file}`, "utf8"),
      );
      if (!lease.pid) continue;
      try {
        const command = await readFile(`/proc/${lease.pid}/cmdline`, "utf8");
        assert.equal(
          command.includes("\0launch-workflow\0"),
          false,
          "A workflow supervisor survived completed cancellation",
        );
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
      }
    }
  }
}
