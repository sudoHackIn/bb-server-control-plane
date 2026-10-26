import { verifyWorkflowDefinitions } from "./check-control-plane-workflow-definitions.mjs";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  readFile,
  readdir,
  mkdir,
  writeFile,
  chown,
  symlink,
  rm,
} from "node:fs/promises";
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
  async function personalStart(
    subject,
    script,
    resumeRunId = null,
    args = null,
  ) {
    const run = await userCommand(
      subject.user.login,
      [
        "workflows",
        "start",
        subject.thread.id,
        "--script-stdin",
        ...(args === null ? [] : ["--args", JSON.stringify(args)]),
        ...(resumeRunId ? ["--resume", resumeRunId] : []),
        "--json",
      ],
      script,
    );
    assert.equal(run.originThreadId, subject.thread.id);
    assert.equal(run.projectId, subject.project.projectId);
    return { runId: run.id };
  }
  const runs = [];
  for (const subject of subjects) {
    const source =
      'export const meta = {name: "managed-owner-check", description: "Native ownership check"}; phase("computed"); return {value: 42};';
    const escaped = subject.user.login === "alice";
    const run = await personalStart(
      subject,
      escaped ? `/*${'"'.repeat(512000)}*/${source}` : source,
      null,
      escaped ? { text: '"'.repeat(40000) } : null,
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
        assert.equal(row.notification_outcome, "delivered");
        assert.equal(row.notification_sent, 1);
        const receipt = db
          .prepare(
            "SELECT * FROM control_plane_job_notifications WHERE binding_id = ?",
          )
          .get(binding.id);
        assert.equal(receipt?.thread_id, subject.thread.id);
        const notices = db
          .prepare(
            "SELECT thread_id,data FROM events WHERE type = 'client/turn/requested' AND data LIKE ?",
          )
          .all(`%[BB workflow finished · ${id}]%`);
        assert.equal(notices.length, 1);
        assert.equal(notices[0].thread_id, subject.thread.id);
        const noticeData = JSON.parse(notices[0].data);
        assert.equal(receipt.request_id, noticeData.requestId);
        assert.ok(
          db
            .prepare(
              "SELECT request_id FROM control_plane_turn_sources WHERE thread_id=? AND request_id=?",
            )
            .get(subject.thread.id, receipt.request_id),
        );
        const content = noticeData.input;
        assert.ok(
          content.some(
            (item) =>
              item.type === "text" &&
              item.visibility === "agent-only" &&
              item.text.includes(id),
          ),
        );
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
  for (const { id, subject } of runs) {
    assert.equal(
      (
        await userCommand(subject.user.login, [
          "workflows",
          "get",
          id,
          "--json",
        ])
      ).status,
      "succeeded",
    );
    assert.deepEqual(
      (
        await userCommand(subject.user.login, [
          "workflows",
          "result",
          id,
          "--json",
        ])
      ).value,
      { value: 42 },
    );
    assert.deepEqual(
      (
        await userCommand(subject.user.login, [
          "workflows",
          "history",
          id,
          "--json",
        ])
      ).calls,
      [],
    );
    let cursor = null;
    const found = new Set();
    const cursors = new Set();
    do {
      const page = await userCommand(subject.user.login, [
        "workflows",
        "list",
        "--project",
        subject.project.projectId,
        "--limit",
        "2",
        ...(cursor ? ["--cursor", cursor] : []),
        "--json",
      ]);
      for (const run of page.runs) {
        assert.equal(run.projectId, subject.project.projectId);
        assert.equal(run.originThreadId, subject.thread.id);
        found.add(run.id);
      }
      cursor = page.nextCursor;
      if (cursor) {
        assert.equal(cursors.has(cursor), false);
        cursors.add(cursor);
        assert.ok(cursors.size < 100);
      }
    } while (cursor);
    assert.ok(found.has(id));
    const other = subjects.find((item) => item.user.id !== subject.user.id);
    for (const action of ["get", "result", "history", "stop"])
      await assert.rejects(() =>
        userCommand(other.user.login, ["workflows", action, id, "--json"]),
      );
    await assert.rejects(() =>
      personalStart(
        other,
        'export const meta={name:"foreign-resume",description:"must fail"}; return 1;',
        id,
      ),
    );
  }
  async function definitionAdminRpc(method, input) {
    const file = `/tmp/bb-definition-rpc-${randomUUID()}.json`;
    await writeFile(file, JSON.stringify(input), { mode: 0o600, flag: "wx" });
    await chown(file, 1000, 1000);
    try {
      return await cli([
        "plugin",
        "rpc",
        "call",
        "workflows",
        method,
        "--input-file",
        file,
        "--json",
      ]);
    } finally {
      await rm(file, { force: true });
    }
  }
  const definitions = await verifyWorkflowDefinitions({
    subjects,
    userCommand,
    db,
    wait,
    adminRpc: definitionAdminRpc,
  });
  const personalCancelled = await personalStart(
    subjects[0],
    'export const meta={name:"personal-cancel",description:"User API cancellation"}; phase("waiting"); return await new Promise(()=>{});',
  );
  assert.equal(
    (
      await userCommand(subjects[0].user.login, [
        "workflows",
        "stop",
        personalCancelled.runId,
        "--json",
      ])
    ).stopped,
    true,
  );
  assert.equal(
    (
      await userCommand(subjects[0].user.login, [
        "workflows",
        "get",
        personalCancelled.runId,
        "--json",
      ])
    ).status,
    "cancelled",
  );
  const agentStorage = new Database("/srv/bb/plugins/workflows/data.db", {
    readonly: true,
  });
  const agentRuns = [];
  async function waitAgent(runId) {
    await wait(() => {
      const row = agentStorage
        .prepare("SELECT status, error FROM workflow_runs WHERE id = ?")
        .get(runId);
      if (row?.status === "failed") {
        const call = agentStorage
          .prepare(
            "SELECT child_thread_id FROM workflow_calls WHERE run_id = ? LIMIT 1",
          )
          .get(runId);
        const events = call?.child_thread_id
          ? db
              .prepare(
                "SELECT * FROM events WHERE thread_id = ? ORDER BY sequence DESC LIMIT 5",
              )
              .all(call.child_thread_id)
          : [];
        throw new Error(JSON.stringify({ error: row.error, events }));
      }
      return row?.status === "succeeded";
    }, "native isolated agent workflow");
    return agentStorage
      .prepare("SELECT * FROM workflow_runs WHERE id = ?")
      .get(runId);
  }
  try {
    for (const subject of subjects) {
      const script = `export const meta = {name: "isolated-agent", description: "Real controlled Qwen worker"}; return await agent("BB_PERSONAL_workflow-agent-${subject.user.login}");`;
      const run = await personalStart(subject, script);
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
    const selected = await personalStart(alice, selectedScript);
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
    const selectedReplay = await personalStart(
      alice,
      selectedScript,
      selected.runId,
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
    const childSource =
      'export const meta = {name:"nested-child",description:"UID workspace child",inputSchema:{type:"number"},outputSchema:{type:"object"}}; phase("nested-child"); return {value:args+1,reply:await agent("BB_PERSONAL_workflow-nested-alice")};';
    const nestedDir = `${alice.project.cwd}/.bb/workflows`;
    await mkdir(nestedDir, { recursive: true, mode: 0o770 });
    for (const directory of [`${alice.project.cwd}/.bb`, nestedDir])
      await chown(directory, alice.user.uid, alice.user.uid);
    const nestedPath = `${nestedDir}/nested-child.js`;
    await writeFile(nestedPath, childSource, { mode: 0o600 });
    await chown(nestedPath, alice.user.uid, alice.user.uid);
    const nestedScript =
      'export const meta = {name:"native-nested-parent",description:"Same UID nested VM"}; return await workflow("nested-child",41);';
    const nestedRun = await cli(
      ["workflows", "run", "--script", nestedScript, "--json"],
      alice,
    );
    assert.deepEqual(
      JSON.parse((await waitAgent(nestedRun.runId)).result_json),
      {
        value: 42,
        reply: "Personal workflow-nested-alice completed",
      },
    );
    const nestedCall = agentStorage
      .prepare("SELECT * FROM workflow_calls WHERE run_id = ?")
      .get(nestedRun.runId);
    assert.equal(
      db
        .prepare(
          "SELECT owner_user_id FROM control_plane_threads WHERE thread_id = ?",
        )
        .get(nestedCall.child_thread_id).owner_user_id,
      alice.user.id,
    );
    const nestedBefore = db
      .prepare("SELECT count(*) AS count FROM threads")
      .get().count;
    const nestedReplay = await cli(
      [
        "workflows",
        "run",
        "--script",
        nestedScript,
        "--resume",
        nestedRun.runId,
        "--json",
      ],
      alice,
    );
    await waitAgent(nestedReplay.runId);
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM threads").get().count,
      nestedBefore,
    );
    async function rejectNested(reference, reason) {
      const script = `export const meta = {name:"nested-denied",description:"Confined child resolution"}; return await workflow(${JSON.stringify(reference)});`;
      const run = await cli(
        ["workflows", "run", "--script", script, "--json"],
        alice,
      );
      await wait(
        () =>
          agentStorage
            .prepare("SELECT status FROM workflow_runs WHERE id = ?")
            .get(run.runId)?.status === "failed",
        "nested denial",
      );
      const row = agentStorage
        .prepare("SELECT error FROM workflow_runs WHERE id = ?")
        .get(run.runId);
      assert.match(row.error, reason);
    }
    await rejectNested(
      {
        script:
          'export const meta = {name:"child",description:"No Node"}; return process.cwd();',
      },
      /process is unavailable/u,
    );
    const outside = `${alice.user.home}/outside-workflow.js`;
    await writeFile(outside, childSource, { mode: 0o600 });
    await chown(outside, alice.user.uid, alice.user.uid);
    await symlink(outside, `${nestedDir}/symlink-child.js`);
    await symlink(nestedDir, `${alice.project.cwd}/linked-workflows`);
    await rejectNested(
      { scriptPath: "../outside-workflow.js" },
      /inside the origin workspace/u,
    );
    await rejectNested(
      {
        scriptPath: `${subjects[1].project.cwd}/.bb/workflows/nested-child.js`,
      },
      /inside the origin workspace/u,
    );
    await rejectNested("symlink-child", /ELOOP/u);
    await rejectNested(
      { scriptPath: "linked-workflows/nested-child.js" },
      /ENOTDIR|ELOOP/u,
    );
    await rejectNested(
      {
        script:
          'export const meta = {name:"child",description:"Depth check"}; return await workflow("nested-child");',
      },
      /depth limit exceeded/u,
    );
    await writeFile(`${nestedDir}/oversized.js`, "x".repeat(524289), {
      mode: 0o644,
    });
    await rejectNested("oversized", /exceeds byte limit/u);
    await rejectNested({ scriptPath: ".bb/workflows" }, /regular file/u);
    await writeFile(`${nestedDir}/invalid-utf8.js`, Buffer.from([255]), {
      mode: 0o644,
    });
    await rejectNested("invalid-utf8", /not valid.*utf-8/u);

    for (const marker of [
      "workflow-retry-alice",
      "workflow-denied-alice",
      "workflow-repair-alice",
      "workflow-invalid-alice",
    ]) {
      const structured =
        marker.includes("repair") || marker.includes("invalid");
      const script = `export const meta = {name:"managed-provider-repair",description:"Retries and bounded corrective turns"}; return await agent("BB_PERSONAL_${marker}"${structured ? ', {schema:{type:"object",properties:{value:{type:"number"}},required:["value"]}}' : ""});`;
      const started = await cli(
        ["workflows", "run", "--script", script, "--json"],
        alice,
      );
      const expected =
        marker.includes("denied") || marker.includes("invalid")
          ? "failed"
          : "succeeded";
      await wait(() => {
        const row = agentStorage
          .prepare("SELECT status,error FROM workflow_runs WHERE id = ?")
          .get(started.runId);
        if (expected === "succeeded" && row?.status === "failed")
          throw new Error(row.error);
        return row?.status === expected;
      }, `native ${marker}`);
      const row = agentStorage
        .prepare("SELECT * FROM workflow_runs WHERE id = ?")
        .get(started.runId);
      const call = agentStorage
        .prepare("SELECT * FROM workflow_calls WHERE run_id = ?")
        .get(started.runId);
      const workers = db
        .prepare(
          "SELECT count(*) AS count FROM control_plane_threads t JOIN control_plane_job_bindings b ON b.id = t.job_binding_id WHERE b.source_binding_id = ?",
        )
        .get(row.authority_binding_id).count;
      if (marker.includes("retry")) {
        assert.equal(call.provider_retry_attempts, 1);
        assert.equal(workers, 2);
        assert.equal(
          JSON.parse(row.result_json),
          `Personal ${marker} completed`,
        );
      } else {
        assert.equal(call.provider_retry_attempts, 0);
        assert.equal(workers, 1);
        if (marker.includes("repair")) {
          assert.equal(call.repair_attempts, 1);
          assert.deepEqual(JSON.parse(row.result_json), { value: 42 });
        }
        if (marker.includes("invalid")) {
          assert.equal(call.repair_attempts, 3);
          assert.match(
            row.error,
            /Structured output failed after 2 corrective turns/u,
          );
        }
        if (marker.includes("denied"))
          assert.match(row.error, /Authentication|401/u);
      }
    }
    for (const action of ["cancel", "revoke", "exhaust"]) {
      const marker = `workflow-retry-${action}-alice`;
      const script = `export const meta = {name:"retry-admission",description:"Authority changes between attempts"}; return await agent("BB_PERSONAL_${marker}");`;
      const run = await cli(
        ["workflows", "run", "--script", script, "--json"],
        alice,
      );
      const bindingId = agentStorage
        .prepare("SELECT authority_binding_id FROM workflow_runs WHERE id = ?")
        .get(run.runId).authority_binding_id;
      const countWorkers = () =>
        db
          .prepare(
            "SELECT count(*) AS count FROM control_plane_threads o JOIN control_plane_job_bindings b ON b.id = o.job_binding_id WHERE b.source_binding_id = ?",
          )
          .get(bindingId).count;
      if (action !== "exhaust") {
        await wait(() => {
          const call = agentStorage
            .prepare(
              "SELECT status,provider_retry_attempts FROM workflow_calls WHERE run_id = ?",
            )
            .get(run.runId);
          return (
            call?.status === "queued" && call.provider_retry_attempts === 2
          );
        }, `second retry backoff before ${action}`);
        assert.equal(countWorkers(), 2);
        const queuedAt = Date.now();
        try {
          if (action === "cancel")
            await cli(["workflows", "stop", run.runId, "--json"], alice);
          else
            await cli([
              "server",
              "access",
              "profiles",
              "revoke",
              alice.profile.body.profile.id,
              alice.user.id,
              "--json",
            ]);
          await wait(
            () =>
              agentStorage
                .prepare("SELECT status FROM workflow_runs WHERE id = ?")
                .get(run.runId)?.status ===
              (action === "cancel" ? "cancelled" : "failed"),
            `retry ${action} settled`,
          );
          await wait(
            () =>
              agentStorage
                .prepare(
                  "SELECT notification_outcome FROM workflow_runs WHERE id = ?",
                )
                .get(run.runId)?.notification_outcome === "abandoned",
            `retry ${action} unauthorized notification settled`,
          );
          assert.equal(
            db
              .prepare(
                "SELECT count(*) AS count FROM control_plane_job_notifications WHERE binding_id = ?",
              )
              .get(bindingId).count,
            0,
          );
          assert.equal(
            db
              .prepare(
                "SELECT count(*) AS count FROM events WHERE type = 'client/turn/requested' AND data LIKE ?",
              )
              .get(`%[BB workflow finished · ${run.runId}]%`).count,
            0,
          );
          if (action === "revoke")
            assert.match(
              agentStorage
                .prepare("SELECT error FROM workflow_runs WHERE id = ?")
                .get(run.runId).error,
              /not authorized/u,
            );
        } finally {
          if (action === "revoke")
            await cli([
              "server",
              "access",
              "profiles",
              "grant",
              alice.profile.body.profile.id,
              alice.user.id,
              "--json",
            ]);
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, queuedAt + 4500 - Date.now())),
        );
        assert.equal(countWorkers(), 2);
      } else {
        await wait(
          () =>
            agentStorage
              .prepare("SELECT status FROM workflow_runs WHERE id = ?")
              .get(run.runId)?.status === "failed",
          "transient retry budget exhaustion",
          60000,
        );
        assert.equal(countWorkers(), 3);
      }
      assert.equal(
        agentStorage
          .prepare(
            "SELECT provider_retry_attempts FROM workflow_calls WHERE run_id = ?",
          )
          .get(run.runId).provider_retry_attempts,
        2,
      );
      await wait(
        () =>
          db
            .prepare(
              "SELECT count(*) AS count FROM control_plane_threads o JOIN control_plane_job_bindings b ON b.id = o.job_binding_id JOIN threads t ON t.id = o.thread_id WHERE b.source_binding_id = ? AND (b.enabled = 1 OR t.archived_at IS NULL)",
            )
            .get(bindingId).count === 0,
        "all failed or cancelled retry attempts retired",
      );
    }
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
    ['return await workflow("must-not-run-in-service");', /ENOENT/u],
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
  assert.equal(
    (
      await userCommand(subjects[0].user.login, [
        "workflows",
        "stop",
        parentRuns[0].parentRunId,
        "--json",
      ])
    ).stopped,
    true,
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
  assert.equal(
    (
      await userCommand(subjects[1].user.login, [
        "workflows",
        "stop",
        parentRuns[1].parentRunId,
        "--json",
      ])
    ).stopped,
    true,
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
    db,
    launch,
    signal,
    wait,
    subjects,
  });
  let recoveryRun = null;
  let previousRecoveryWorker = null;
  let orphanWorkers = [];
  const crashRuns = [];
  return {
    async beforeCrash() {
      for (const source of agentRuns) {
        const subject = source.subject;
        const login = subject.user.login;
        const script = `export const meta = {name:"native-crash-recovery",description:"Interrupted UID worker and current grants"}; const first=await agent("BB_PERSONAL_workflow-agent-${login}"); return [first,await agent("BB_PERSONAL_worker-hang-crash-${login}")];`;
        const run = await cli(
          [
            "workflows",
            "run",
            "--script",
            script,
            "--resume",
            source.runId,
            "--json",
          ],
          subject,
        );
        await wait(async () => {
          try {
            await readFile(
              `${subject.user.home}/bb-personal-worker-hang-crash-${login}.json`,
            );
            return true;
          } catch (error) {
            if (error.code === "ENOENT") return false;
            throw error;
          }
        }, `pending workflow before crash for ${login}`);
        const storage = new Database("/srv/bb/plugins/workflows/data.db", {
          readonly: true,
        });
        try {
          const row = storage
            .prepare(
              "SELECT authority_binding_id FROM workflow_runs WHERE id = ?",
            )
            .get(run.runId);
          const call = storage
            .prepare(
              "SELECT child_thread_id FROM workflow_calls WHERE run_id = ? AND call_index = 1",
            )
            .get(run.runId);
          crashRuns.push({
            runId: run.runId,
            bindingId: row.authority_binding_id,
            threadId: call.child_thread_id,
            subject,
          });
          assert.ok(call.child_thread_id);
        } finally {
          storage.close();
        }
      }
    },
    async afterCrashShutdown() {
      const subject = crashRuns[0].subject;
      await workerFixture("access", {
        profileId: subject.profile.body.profile.id,
        userId: subject.user.id,
        allowed: false,
      });
    },
    async afterCrash() {
      const storage = new Database("/srv/bb/plugins/workflows/data.db", {
        readonly: true,
      });
      try {
        for (const [index, run] of crashRuns.entries()) {
          const expected = index === 0 ? "failed" : "succeeded";
          await wait(() => {
            const row = storage
              .prepare("SELECT status,error FROM workflow_runs WHERE id = ?")
              .get(run.runId);
            if (index !== 0 && row?.status === "failed")
              throw new Error(row.error);
            return row?.status === expected;
          }, `workflow crash recovery ${run.subject.user.login}`);
          const calls = storage
            .prepare(
              "SELECT * FROM workflow_calls WHERE run_id = ? ORDER BY call_index",
            )
            .all(run.runId);
          if (index === 0) {
            assert.match(
              storage
                .prepare("SELECT error FROM workflow_runs WHERE id = ?")
                .get(run.runId).error,
              /not authorized/u,
            );
            assert.equal(
              db
                .prepare(
                  "SELECT count(*) AS count FROM control_plane_job_bindings WHERE source_binding_id = ? AND kind = 'workflow-worker'",
                )
                .get(run.bindingId).count,
              1,
            );
          } else {
            assert.equal(calls[0].replay_source, "same-run");
            assert.equal(calls[1].status, "succeeded");
            assert.notEqual(calls[1].child_thread_id, run.threadId);
            assert.equal(
              db
                .prepare(
                  "SELECT owner_user_id FROM control_plane_threads WHERE thread_id = ?",
                )
                .get(calls[1].child_thread_id).owner_user_id,
              run.subject.user.id,
            );
          }
          await wait(
            () =>
              db
                .prepare("SELECT archived_at FROM threads WHERE id = ?")
                .get(run.threadId)?.archived_at > 0,
            "old crash worker retirement",
          );
          assert.equal(
            db
              .prepare(
                "SELECT b.enabled FROM control_plane_threads t JOIN control_plane_job_bindings b ON b.id = t.job_binding_id WHERE t.thread_id = ?",
              )
              .get(run.threadId).enabled,
            0,
          );
        }
      } finally {
        storage.close();
        const subject = crashRuns[0].subject;
        await workerFixture("access", {
          profileId: subject.profile.body.profile.id,
          userId: subject.user.id,
          allowed: true,
        });
      }
      return {
        abruptCrashWorkflowRecoveryVerified: true,
        crashRecoveryReusesSuccessfulPrefix: true,
        revokedUserDeniedNewAttemptAfterCrash: true,
        otherUserRecoverySurvivesRevocation: true,
        oldCrashWorkerAttemptsDisabledAndArchived: true,
      };
    },
    async beforeRestart() {
      const subject = agentRuns[0].subject;
      const script =
        'export const meta = {name:"native-recovery",description:"Successful prefix and interrupted worker"}; const first = await agent("BB_PERSONAL_workflow-agent-alice"); return [first, await agent("BB_PERSONAL_worker-hang-recovery-alice")];';
      recoveryRun = await cli(
        [
          "workflows",
          "run",
          "--script",
          script,
          "--resume",
          agentRuns[0].runId,
          "--json",
        ],
        subject,
      );
      await wait(async () => {
        try {
          await readFile(
            `${subject.user.home}/bb-personal-worker-hang-recovery-alice.json`,
          );
          return true;
        } catch (error) {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      }, "interrupted native workflow worker");
      const storage = new Database("/srv/bb/plugins/workflows/data.db", {
        readonly: true,
      });
      try {
        previousRecoveryWorker = storage
          .prepare(
            "SELECT child_thread_id FROM workflow_calls WHERE run_id = ? AND call_index = 1",
          )
          .get(recoveryRun.runId).child_thread_id;
        assert.ok(previousRecoveryWorker);
      } finally {
        storage.close();
      }
    },
    async afterShutdown() {
      orphanWorkers = await workerFixture("orphan");
      await workerFixture(
        "notification-retry",
        runs.map((run) => run.id),
      );
    },
    verification: {
      ...definitions.verification,
      ...processProof,
      ...evaluatorProof,
      nativeWorkflowCliOwnerAndPinnedProfile: true,
      personalWorkflowApiAndCliTwoUserOwnership: true,
      personalWorkflowEscapedEnvelopeWithinSourceAndArgsLimits: true,
      personalWorkflowListPaginationAndResultHistory: true,
      personalForeignWorkflowReadStopAndResumeDenied: true,
      personalWorkflowStopDisablesExecution: true,
      personalWorkflowCancellationStopsActualQwenWorkers: true,
      personalWorkflowAgentProfileSelectionAndReplay: true,
      nativeWorkflowNotificationAcceptedForEachOwner: true,
      nativeWorkflowNotificationAgentOnlyAndNoForeignThread: true,
      nativeRevokedAndCancelledNotificationAbandonedWithoutEvents: true,
      nativeEvaluatorAgentToQwenRoundTrip: true,
      nativeTransientProviderFailureUsesNewWorkerAttempt: true,
      nativeCancelDuringSecondBackoffPreventsNextAttempt: true,
      nativeGrantRevocationDuringBackoffPreventsNextAttempt: true,
      nativeTransientRetryExhaustionStopsAtThreeWorkers: true,
      nativeAllRetryAttemptsRetiredAfterTerminalOutcome: true,
      nativeAuthenticationFailureIsNotRetried: true,
      nativeStructuredCorrectionUsesSameWorker: true,
      nativeStructuredCorrectionExhaustionIsNotProviderRetry: true,
      nestedWorkflowNamedSourceLoadedUnderOwnerUid: true,
      nestedAgentUsesParentAuthorityAndDurableReplay: true,
      nestedSchemasAndNoNodeGlobals: true,
      nestedForeignTraversalAndSymlinkDenied: true,
      nestedOversizedSourceAndDepthDenied: true,
      nestedNonregularAndInvalidUtf8Denied: true,
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
      nativeWorkflowMissingNestedSourceDenied: true,
      nativeWorkflowOutputSchemaEnforced: true,
      nativeWorkflowIsolatedEvaluatorCompleted: true,
      nativeWorkflowEvaluatorIdentityAndCredentialIsolation: true,
    },
    async afterRestart() {
      await wait(() => {
        try {
          verify();
          return true;
        } catch {
          return false;
        }
      }, "notification acknowledgement replay without duplicate native requests");
      verify();
      const workerRestart = await workerFixture("verify");
      const recoveredStorage = new Database(
        "/srv/bb/plugins/workflows/data.db",
        { readonly: true },
      );
      try {
        await wait(() => {
          const row = recoveredStorage
            .prepare("SELECT status,error FROM workflow_runs WHERE id = ?")
            .get(recoveryRun.runId);
          if (row?.status === "failed") throw new Error(row.error);
          return row?.status === "succeeded";
        }, "automatic native workflow recovery after restart");
        const calls = recoveredStorage
          .prepare(
            "SELECT * FROM workflow_calls WHERE run_id = ? ORDER BY call_index",
          )
          .all(recoveryRun.runId);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].replay_source, "same-run");
        assert.equal(calls[1].status, "succeeded");
        assert.notEqual(calls[1].child_thread_id, previousRecoveryWorker);
        await wait(
          () =>
            orphanWorkers.every(
              (worker) =>
                db
                  .prepare("SELECT archived_at FROM threads WHERE id = ?")
                  .get(worker.threadId)?.archived_at > 0,
            ),
          "scoped orphan cleanup after restart",
        );
        for (const worker of orphanWorkers)
          assert.equal(
            db
              .prepare(
                "SELECT enabled FROM control_plane_job_bindings WHERE id = ?",
              )
              .get(worker.bindingId).enabled,
            0,
          );
      } finally {
        recoveredStorage.close();
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
      await wait(async () => {
        const { plugins } = await cli(["plugin", "list", "--json"]);
        const plugin = plugins.find((entry) => entry.id === "workflows");
        assert.notEqual(plugin?.status, "error", plugin?.statusDetail);
        return plugin?.status === "running";
      }, "workflow plugin registration after restart");
      const definitionRestart = await definitions.afterRestart();
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
        ...definitionRestart,
        ...workerRestart,
        interruptedNativeWorkflowAutomaticallyRecovered: true,
        successfulPrefixRecoveredWithoutDuplicateWorker: true,
        missingRunOrphansDiscoveredAndArchivedAfterRestart: true,
        nativeWorkflowOwnerBindingSurvivesRestart: true,
        nativeNotificationAcknowledgementLossDoesNotDuplicateAfterRestart: true,
        isolatedAgentPrefixReplaySurvivesRestartWithoutNewWorker: true,
      };
    },
  };
}

async function verifyEvaluatorProcesses({
  db,
  launch,
  signal,
  wait,
  subjects,
}) {
  const generations = new Map(
    subjects.map((subject) => {
      const state = db
        .prepare(
          "SELECT generation,phase FROM control_plane_uid_maintenance WHERE user_id=?",
        )
        .get(subject.user.id);
      assert.ok(state === undefined || state.phase === "idle");
      return [subject.user.id, state?.generation ?? 0];
    }),
  );
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
          `--uid-generation=${generations.get(subject.user.id)}`,
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
      `--uid-generation=${generations.get(alice.subject.user.id)}`,
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
      `--uid-generation=${generations.get(alice.subject.user.id)}`,
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
