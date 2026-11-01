import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export async function verifyPublishedWorkflowAgents({
  subjects,
  userRequest,
  userCommand,
  sendAdmin,
  adminToken,
  wait,
  password,
  db,
}) {
  const published = [];
  const base = "/control-plane/user/agent-runs";
  const definitions = "/control-plane/user/workflow-definitions";
  const metadata =
    'export const meta={name:"published-workflow-agent",description:"Published agent native worker",inputSchema:{type:"string",maxLength:200},outputSchema:{type:"string"}};';
  for (const subject of subjects) {
    const { user, project, thread, profile } = subject;
    const child = `export const meta={name:"nested-agent-step",description:"Nested published worker",inputSchema:{type:"string"},outputSchema:{type:"string"}}; return (await parallel([()=>agent(args,{profileVersionId:${JSON.stringify(profile.body.version.id)}}),()=>"no-model"]))[0];`;
    const invocation = `return await workflow({script:${JSON.stringify(child)}},args);`;
    const script = metadata + invocation;
    const source = await userRequest(user.login, definitions, {
      method: "POST",
      body: { originThreadId: thread.id, script, args: "example" },
    });
    assert.equal(source.status, 201, JSON.stringify(source.body));
    const workflow = {
      definitionId: source.body.id,
      revision: source.body.revision,
    };
    const agent = await sendAdmin(
      "/control-plane/admin/profiles",
      {
        slug: `workflow-agent-${user.login}`,
        name: `Workflow agent ${user.login}`,
        definition: {
          ...profile.body.version.definition,
          workflow,
          delegation: { allowedVersionIds: [profile.body.version.id] },
        },
      },
      adminToken,
    );
    assert.equal(agent.status, 201, JSON.stringify(agent.body));
    assert.equal(agent.body.profile.strategy, "workflow");
    assert.equal(JSON.stringify(agent.body).includes(script), false);
    for (const target of subjects) {
      const grant = await sendAdmin(
        `/control-plane/admin/profiles/${agent.body.profile.id}/access/${target.user.id}`,
        { allowed: true },
        adminToken,
        "PUT",
      );
      assert.equal(grant.status, 200);
    }
    assert.deepEqual(agent.body.version.definition.delegation, {
      allowedVersionIds: [profile.body.version.id],
    });
    const deniedAgent = await sendAdmin(
      "/control-plane/admin/profiles",
      {
        slug: `workflow-denied-delegation-${user.login}`,
        name: `Denied delegation ${user.login}`,
        definition: {
          ...profile.body.version.definition,
          workflow,
          delegation: { allowedVersionIds: [] },
        },
      },
      adminToken,
    );
    assert.equal(deniedAgent.status, 201, JSON.stringify(deniedAgent.body));
    const deniedGrant = await sendAdmin(
      `/control-plane/admin/profiles/${deniedAgent.body.profile.id}/access/${user.id}`,
      { allowed: true },
      adminToken,
      "PUT",
    );
    assert.equal(deniedGrant.status, 200);
    const deniedRun = await userRequest(user.login, base, {
      method: "POST",
      body: {
        projectId: project.projectId,
        profileVersionId: deniedAgent.body.version.id,
        input: "must-not-delegate",
        source: "manual",
        idempotencyKey: `denied-delegation-${user.login}`,
      },
    });
    assert.equal(deniedRun.status, 201, JSON.stringify(deniedRun.body));
    await wait(async () => {
      const deniedResult = await userRequest(
        user.login,
        `${base}/${deniedRun.body.runId}/result`,
      );
      assert.equal(deniedResult.status, 200, JSON.stringify(deniedResult.body));
      assert.notEqual(
        deniedResult.body.run.status,
        "succeeded",
        JSON.stringify(deniedResult.body),
      );
      return deniedResult.body.run.status === "failed";
    }, `denied published worker delegation ${user.login}`);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS count FROM control_plane_job_bindings WHERE source_binding_id=(SELECT id FROM control_plane_job_bindings WHERE object_id=? AND kind='workflow-run') AND kind='workflow-worker'",
        )
        .get(deniedRun.body.runId).count,
      0,
    );
    const body = {
      projectId: project.projectId,
      profileVersionId: agent.body.version.id,
      input: `BB_PERSONAL_workflow-published-${user.login}`,
      source: "manual",
      idempotencyKey: `published-workflow-${user.login}`,
    };
    const run = await userCommand(user.login, [
      "agent-runs",
      "start",
      project.projectId,
      "--profile-version",
      body.profileVersionId,
      "--input",
      body.input,
      "--idempotency-key",
      body.idempotencyKey,
      "--json",
    ]);
    assert.equal(run.strategy, "workflow");
    assert.equal(run.threadId, null);
    assert.equal(run.workflowRunId, run.runId);
    assert.equal(run.profileVersionId, body.profileVersionId);
    const duplicate = await userRequest(user.login, base, {
      method: "POST",
      body,
    });
    assert.equal(duplicate.status, 201, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.runId, run.runId);
    const conflict = await userRequest(user.login, base, {
      method: "POST",
      body: { ...body, input: "changed" },
    });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    await wait(() => {
      const row = db
        .prepare(
          "SELECT t.status FROM threads t JOIN control_plane_threads c ON c.thread_id=t.id JOIN control_plane_job_bindings b ON b.id=c.job_binding_id JOIN control_plane_job_bindings p ON p.id=b.source_binding_id WHERE p.object_id=? AND p.kind='workflow-run'",
        )
        .get(run.runId);
      return row?.status === "idle";
    }, `published workflow worker ${user.login}`);
    let result;
    await wait(async () => {
      result = await userRequest(user.login, `${base}/${run.runId}/result`);
      assert.equal(result.status, 200);
      if (["failed", "cancelled"].includes(result.body.run.status))
        throw new Error(JSON.stringify(result.body));
      return result.body.run.status === "succeeded";
    }, `published workflow result ${user.login}`);
    assert.equal(
      result.body.text,
      `Personal workflow-published-${user.login} completed`,
    );
    const listed = await userCommand(user.login, [
      "agent-runs",
      "list",
      "--project",
      project.projectId,
      "--json",
    ]);
    assert.ok(listed.runs.some((item) => item.runId === run.runId));
    const probe = JSON.parse(
      await readFile(
        `${user.home}/bb-personal-workflow-published-${user.login}.json`,
        "utf8",
      ),
    );
    assert.deepEqual(probe, {
      uid: user.uid,
      home: user.home,
      cwd: project.cwd,
    });
    const next = await userRequest(
      user.login,
      `${definitions}/${source.body.id}`,
      {
        method: "PUT",
        body: {
          expectedRevision: 1,
          script: script.replace(invocation, 'return "edited-source";'),
          args: "example",
        },
      },
    );
    assert.equal(next.status, 200, JSON.stringify(next.body));
    const newer = await sendAdmin(
      `/control-plane/admin/profiles/${agent.body.profile.id}/versions`,
      {
        definition: {
          ...profile.body.version.definition,
          workflow: { ...workflow, revision: 2 },
        },
      },
      adminToken,
    );
    assert.equal(newer.status, 201, JSON.stringify(newer.body));
    assert.notEqual(newer.body.version.id, agent.body.version.id);
    assert.equal(
      (
        await userRequest(user.login, `${definitions}/${source.body.id}`, {
          method: "DELETE",
        })
      ).status,
      200,
    );
    const repeat = await userRequest(user.login, base, {
      method: "POST",
      body,
    });
    assert.equal(repeat.status, 201, JSON.stringify(repeat.body));
    assert.equal(repeat.body.runId, run.runId);
    const invalid = await userRequest(user.login, base, {
      method: "POST",
      body: { ...body, idempotencyKey: "too-long", input: "x".repeat(201) },
    });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
    const chat = await userRequest(user.login, "/control-plane/user/threads", {
      method: "POST",
      body: {
        projectId: project.projectId,
        profileVersionId: body.profileVersionId,
        message: "must not become chat",
      },
    });
    assert.equal(chat.status, 409);
    const replay = await userCommand(
      user.login,
      [
        "workflows",
        "start",
        "--project",
        project.projectId,
        "--profile-version",
        body.profileVersionId,
        "--script-stdin",
        "--args",
        JSON.stringify(body.input),
        "--resume",
        run.runId,
        "--json",
      ],
      script,
    );
    await wait(
      async () =>
        (
          await userRequest(
            user.login,
            `/control-plane/user/workflows/${replay.id}`,
          )
        ).body.status === "succeeded",
      `published workflow replay ${user.login}`,
    );
    const history = await userCommand(user.login, [
      "workflows",
      "history",
      run.runId,
      "--json",
    ]);
    assert.equal(history.calls.length, 1);
    assert.ok(history.calls[0].childThreadId);
    const trace = await userCommand(user.login, [
      "workflows",
      "trace",
      run.runId,
      "--limit",
      "100",
      "--json",
    ]);
    assert.equal(trace.attempt.status, "succeeded");
    assert.equal(trace.attempt.truncated, false);
    const nestedScope = trace.entries.find(
      (entry) => entry.kind === "workflow",
    );
    const parallelSpan = trace.entries.find(
      (entry) => entry.kind === "parallel",
    );
    const agentEntry = trace.entries.find((entry) => entry.kind === "agent");
    assert.equal(nestedScope.name, "nested-agent-step");
    assert.equal(nestedScope.sourceHash.length, 64);
    assert.equal(parallelSpan.scopeId, nestedScope.nodeId);
    assert.equal(parallelSpan.branchCount, 2);
    assert.equal(agentEntry.scopeId, nestedScope.nodeId);
    assert.equal(agentEntry.callId, history.calls[0].id);
    assert.equal(agentEntry.source, "live");
    const traceReplay = await userCommand(user.login, [
      "workflows",
      "trace",
      replay.id,
      "--json",
    ]);
    assert.equal(
      traceReplay.entries.find((entry) => entry.kind === "agent").source,
      "cached",
    );
    assert.equal(
      traceReplay.entries.find((entry) => entry.kind === "workflow").sourceHash,
      nestedScope.sourceHash,
    );
    const inspection = await userCommand(user.login, [
      "workflows",
      "inspect",
      run.runId,
      "--limit",
      "1",
      "--json",
    ]);
    assert.equal(inspection.run.id, run.runId);
    assert.equal(inspection.input, body.input);
    assert.equal(inspection.profileVersionId, body.profileVersionId);
    assert.deepEqual(inspection.workflowRevision, workflow);
    assert.equal(inspection.calls[0].source, "live");
    assert.equal(inspection.calls[0].profileVersionId, profile.body.version.id);
    assert.equal(
      inspection.calls[0].permissionMode,
      profile.body.version.definition.permissionMode,
    );
    const inspectedCall = await userCommand(user.login, [
      "workflows",
      "call",
      run.runId,
      history.calls[0].id,
      "--json",
    ]);
    assert.equal(inspectedCall.diagnostics.recordedSince > 0, true);
    assert.ok(
      inspectedCall.diagnostics.entries.some(
        (entry) => entry.kind === "started",
      ),
    );
    const artifact = inspectedCall.fileArtifacts.entries.find(
      (entry) => entry.kind === "write_file",
    );
    assert.ok(artifact, JSON.stringify(inspectedCall.fileArtifacts));
    assert.equal(
      artifact.path,
      `${project.cwd}/workflow-published-${user.login}.puml`,
    );
    assert.equal(artifact.status, "completed", JSON.stringify(artifact));
    assert.equal(artifact.threadId, history.calls[0].childThreadId);
    assert.equal(artifact.outputTruncated, false);
    assert.ok(artifact.output);
    const cwd = db
      .prepare(
        "SELECT e.path FROM threads t JOIN environments e ON e.id=t.environment_id WHERE t.id=?",
      )
      .get(artifact.threadId).path;
    assert.match(
      await readFile(`${cwd}/workflow-published-${user.login}.puml`, "utf8"),
      /@startuml/,
    );
    assert.equal(inspectedCall.input, body.input);
    assert.equal(inspectedCall.outputAvailable, true);
    assert.equal(inspectedCall.output, result.body.text);
    assert.ok(
      inspectedCall.workers.some(
        (worker) => worker.threadId === history.calls[0].childThreadId,
      ),
    );
    const replayHistory = await userCommand(user.login, [
      "workflows",
      "history",
      replay.id,
      "--json",
    ]);
    const replayCall = await userCommand(user.login, [
      "workflows",
      "call",
      replay.id,
      replayHistory.calls[0].id,
      "--json",
    ]);
    assert.equal(replayCall.call.source, "cached");
    assert.equal(replayCall.call.childThreadId, null);
    assert.deepEqual(replayCall.workers, []);
    assert.deepEqual(replayCall.replayedFrom, {
      runId: run.runId,
      callId: history.calls[0].id,
    });
    const delegationScript =
      'export const meta={name:"agent-composition",description:"Complete published agent calls",inputSchema:{type:"string"},outputSchema:{type:"object"}};' +
      `if(args.startsWith("workflow-cancel:")) return {workflow:await invokeAgent(${JSON.stringify(agent.body.version.id)},args.slice(16))}; const chat=await invokeAgent(${JSON.stringify(profile.body.version.id)}, args+"-chat"); const workflow=await invokeAgent(${JSON.stringify(agent.body.version.id)},args+"-workflow"); return {chat,workflow};`;
    const delegationDefinition = await userRequest(user.login, definitions, {
      method: "POST",
      body: {
        originThreadId: thread.id,
        script: delegationScript,
        args: "example",
      },
    });
    assert.equal(
      delegationDefinition.status,
      201,
      JSON.stringify(delegationDefinition.body),
    );
    const delegationProfile = await sendAdmin(
      "/control-plane/admin/profiles",
      {
        slug: `composition-${user.login}`,
        name: `Composition ${user.login}`,
        definition: {
          ...profile.body.version.definition,
          workflow: { definitionId: delegationDefinition.body.id, revision: 1 },
          delegation: {
            allowedVersionIds: [profile.body.version.id, agent.body.version.id],
          },
        },
      },
      adminToken,
    );
    assert.equal(
      delegationProfile.status,
      201,
      JSON.stringify(delegationProfile.body),
    );
    assert.equal(
      (
        await sendAdmin(
          `/control-plane/admin/profiles/${delegationProfile.body.profile.id}/access/${user.id}`,
          { allowed: true },
          adminToken,
          "PUT",
        )
      ).status,
      200,
    );
    const deniedComposition = await sendAdmin(
      "/control-plane/admin/profiles",
      {
        slug: `composition-denied-${user.login}`,
        name: `Denied composition ${user.login}`,
        definition: {
          ...delegationProfile.body.version.definition,
          delegation: { allowedVersionIds: [] },
        },
      },
      adminToken,
    );
    assert.equal(
      deniedComposition.status,
      201,
      JSON.stringify(deniedComposition.body),
    );
    assert.equal(
      (
        await sendAdmin(
          `/control-plane/admin/profiles/${deniedComposition.body.profile.id}/access/${user.id}`,
          { allowed: true },
          adminToken,
          "PUT",
        )
      ).status,
      200,
    );
    const deniedCompositionRun = await userRequest(user.login, base, {
      method: "POST",
      body: {
        projectId: project.projectId,
        profileVersionId: deniedComposition.body.version.id,
        input: "denied-agent-call",
        source: "manual",
        idempotencyKey: `composition-denied-${user.login}`,
      },
    });
    assert.equal(
      deniedCompositionRun.status,
      201,
      JSON.stringify(deniedCompositionRun.body),
    );
    await wait(
      async () =>
        (
          await userRequest(
            user.login,
            `${base}/${deniedCompositionRun.body.runId}/result`,
          )
        ).body.run.status === "failed",
      `denied complete-agent call ${user.login}`,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS count FROM control_plane_agent_invocations i JOIN control_plane_job_bindings p ON p.id=i.parent_id WHERE p.object_id=?",
        )
        .get(deniedCompositionRun.body.runId).count,
      0,
    );
    const composed = await userRequest(user.login, base, {
      method: "POST",
      body: {
        projectId: project.projectId,
        profileVersionId: delegationProfile.body.version.id,
        input: `BB_PERSONAL_delegated-${user.login}`,
        source: "manual",
        idempotencyKey: `composition-${user.login}`,
      },
    });
    assert.equal(composed.status, 201, JSON.stringify(composed.body));
    let composedResult;
    await wait(async () => {
      composedResult = await userRequest(
        user.login,
        `${base}/${composed.body.runId}/result`,
      );
      assert.equal(
        composedResult.status,
        200,
        JSON.stringify(composedResult.body),
      );
      assert.ok(
        !["failed", "cancelled"].includes(composedResult.body.run.status),
        JSON.stringify(composedResult.body),
      );
      return composedResult.body.run.status === "succeeded";
    }, `composed agent result ${user.login}`);
    const composedOutput = JSON.parse(composedResult.body.text);
    const otherLogin = subjects.find((item) => item.user.id !== user.id).user
      .login;
    assert.equal(
      (await userRequest(otherLogin, `${base}/${composed.body.runId}/result`))
        .status,
      404,
    );
    assert.equal(composedOutput.chat.strategy, "conversation");
    assert.equal(
      (
        await userRequest(
          otherLogin,
          `${base}/${composedOutput.chat.runId}/result`,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await userRequest(
          otherLogin,
          `${base}/${composedOutput.workflow.runId}/result`,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await userRequest(user.login, base, {
          method: "POST",
          body: {
            projectId: project.projectId,
            profileVersionId: profile.body.version.id,
            input: "forged",
            source: "manual",
            idempotencyKey: `invocation:${composedOutput.chat.invocationId}`,
          },
        })
      ).status,
      400,
    );
    assert.equal(
      composedOutput.chat.output,
      `Personal delegated-${user.login}-chat completed`,
    );
    assert.equal(composedOutput.workflow.strategy, "workflow");
    assert.equal(
      composedOutput.workflow.output,
      `Personal delegated-${user.login}-workflow completed`,
    );
    const invocationRows = db
      .prepare(
        "SELECT i.* FROM control_plane_agent_invocations i JOIN control_plane_job_bindings b ON b.id=i.parent_id WHERE b.object_id=? ORDER BY i.idempotency_key",
      )
      .all(composed.body.runId);
    assert.equal(invocationRows.length, 2);
    assert.ok(
      invocationRows.every(
        (row) =>
          row.owner_user_id === user.id &&
          row.project_id === project.projectId &&
          row.state === "succeeded",
      ),
    );
    assert.equal(invocationRows[0].root_id, invocationRows[1].root_id);
    const composedHistory = await userCommand(user.login, [
      "workflows",
      "history",
      composed.body.runId,
      "--json",
    ]);
    const composedCall = await userCommand(user.login, [
      "workflows",
      "call",
      composed.body.runId,
      composedHistory.calls[1].id,
      "--json",
    ]);
    assert.equal(
      composedCall.agentInvocation.runId,
      composedOutput.workflow.runId,
    );
    assert.equal(composedCall.call.profileVersionId, agent.body.version.id);
    for (const suffix of ["chat", "workflow"]) {
      assert.deepEqual(
        JSON.parse(
          await readFile(
            `${user.home}/bb-personal-delegated-${user.login}-${suffix}.json`,
            "utf8",
          ),
        ),
        { uid: user.uid, home: user.home, cwd: project.cwd },
      );
    }
    if (user.login === "alice") {
      const nestedCancelled = await userRequest(user.login, base, {
        method: "POST",
        body: {
          projectId: project.projectId,
          profileVersionId: delegationProfile.body.version.id,
          input:
            "workflow-cancel:BB_PERSONAL_worker-hang-delegated-workflow-alice",
          source: "manual",
          idempotencyKey: "nested-delegation-stop",
        },
      });
      assert.equal(
        nestedCancelled.status,
        201,
        JSON.stringify(nestedCancelled.body),
      );
      let nestedInvocation;
      await wait(() => {
        nestedInvocation = db
          .prepare(
            "SELECT i.* FROM control_plane_agent_invocations i JOIN control_plane_job_bindings p ON p.id=i.parent_id WHERE p.object_id=?",
          )
          .get(nestedCancelled.body.runId);
        return (
          nestedInvocation?.run_id &&
          db
            .prepare(
              "SELECT count(*) AS count FROM threads t JOIN control_plane_threads c ON c.thread_id=t.id JOIN control_plane_job_bindings w ON w.id=c.job_binding_id JOIN control_plane_job_bindings r ON r.id=w.source_binding_id WHERE r.object_id=? AND t.status='active'",
            )
            .get(nestedInvocation.run_id).count > 0
        );
      }, "nested delegated workflow active before stop");
      await wait(async () => {
        try {
          await readFile(
            `${user.home}/bb-personal-worker-hang-delegated-workflow-alice.json`,
          );
          return true;
        } catch {
          return false;
        }
      }, "nested delegated command running before cancellation");
      assert.equal(
        (
          await userRequest(
            user.login,
            `/control-plane/user/workflows/${nestedCancelled.body.runId}/stop`,
            { method: "POST" },
          )
        ).status,
        200,
      );
      await wait(
        () =>
          db
            .prepare(
              "SELECT state FROM control_plane_agent_invocations WHERE id=?",
            )
            .get(nestedInvocation.id)?.state === "cancelled",
        "nested invocation cancellation acknowledged",
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS count FROM threads t JOIN control_plane_threads c ON c.thread_id=t.id JOIN control_plane_job_bindings w ON w.id=c.job_binding_id JOIN control_plane_job_bindings r ON r.id=w.source_binding_id WHERE r.object_id=? AND t.status IN ('active','starting')",
          )
          .get(nestedInvocation.run_id).count,
        0,
      );
    }
    const delegatorProfile = await sendAdmin(
      "/control-plane/admin/profiles",
      {
        slug: `delegator-${user.login}`,
        name: `Delegator ${user.login}`,
        definition: {
          ...profile.body.version.definition,
          tools: [...profile.body.version.definition.tools, "bb:invoke_agent"],
          mcpServers: ["bb"],
          delegation: { allowedVersionIds: [profile.body.version.id] },
        },
      },
      adminToken,
    );
    assert.equal(
      delegatorProfile.status,
      201,
      JSON.stringify(delegatorProfile.body),
    );
    assert.equal(
      (
        await sendAdmin(
          `/control-plane/admin/profiles/${delegatorProfile.body.profile.id}/access/${user.id}`,
          { allowed: true },
          adminToken,
          "PUT",
        )
      ).status,
      200,
    );
    const delegatorThread = await userRequest(
      user.login,
      "/control-plane/user/threads",
      {
        method: "POST",
        body: {
          projectId: project.projectId,
          profileVersionId: delegatorProfile.body.version.id,
          message: `BB_PERSONAL_delegator-${user.login} BB_INVOKE_VERSION=${profile.body.version.id}`,
        },
      },
    );
    assert.equal(
      delegatorThread.status,
      201,
      JSON.stringify(delegatorThread.body),
    );
    try {
      await wait(() => {
        const state = db
          .prepare("SELECT status FROM threads WHERE id=?")
          .get(delegatorThread.body.id)?.status;
        if (state === "error")
          throw new Error("MCP caller failed before completion");
        return state === "idle";
      }, `MCP agent invocation ${user.login}`);
    } catch (error) {
      const rows = db
        .prepare(
          "SELECT i.id,i.state,i.run_id,t.id AS child_id,t.status AS child_status FROM control_plane_agent_invocations i LEFT JOIN control_plane_threads c ON c.run_idempotency_key=i.child_key LEFT JOIN threads t ON t.id=c.thread_id WHERE i.parent_kind='thread' AND i.parent_id=?",
        )
        .all(delegatorThread.body.id);
      const queues = db
        .prepare(
          "SELECT q.thread_id,q.state,q.waiting_on,q.wait_holder FROM queued_thread_messages q WHERE q.thread_id=? OR q.thread_id IN (SELECT c.thread_id FROM control_plane_agent_invocations i JOIN control_plane_threads c ON c.run_idempotency_key=i.child_key WHERE i.parent_kind='thread' AND i.parent_id=?)",
        )
        .all(delegatorThread.body.id, delegatorThread.body.id);
      throw new Error(
        `MCP invocation state ${JSON.stringify({ parentId: delegatorThread.body.id, parent: db.prepare("SELECT status FROM threads WHERE id=?").get(delegatorThread.body.id), rows, queues })}`,
        { cause: error },
      );
    }
    const mcpInvocation = db
      .prepare(
        "SELECT * FROM control_plane_agent_invocations WHERE parent_kind='thread' AND parent_id=?",
      )
      .get(delegatorThread.body.id);
    assert.ok(mcpInvocation, `Missing MCP invocation ${user.login}`);
    assert.equal(mcpInvocation.state, "succeeded");
    assert.equal(mcpInvocation.owner_user_id, user.id);
    assert.deepEqual(
      JSON.parse(
        await readFile(
          `${user.home}/bb-personal-delegated-mcp-${user.login}.json`,
          "utf8",
        ),
      ),
      { uid: user.uid, home: user.home, cwd: project.cwd },
    );
    const mcpDeniedProfile = await sendAdmin(
      "/control-plane/admin/profiles",
      {
        slug: `delegator-denied-${user.login}`,
        name: `Delegator denied ${user.login}`,
        definition: {
          ...delegatorProfile.body.version.definition,
          delegation: { allowedVersionIds: [] },
        },
      },
      adminToken,
    );
    assert.equal(
      mcpDeniedProfile.status,
      201,
      JSON.stringify(mcpDeniedProfile.body),
    );
    assert.equal(
      (
        await sendAdmin(
          `/control-plane/admin/profiles/${mcpDeniedProfile.body.profile.id}/access/${user.id}`,
          { allowed: true },
          adminToken,
          "PUT",
        )
      ).status,
      200,
    );
    const mcpDeniedThread = await userRequest(
      user.login,
      "/control-plane/user/threads",
      {
        method: "POST",
        body: {
          projectId: project.projectId,
          profileVersionId: mcpDeniedProfile.body.version.id,
          message: `BB_PERSONAL_delegator-denied-${user.login} BB_INVOKE_VERSION=${profile.body.version.id}`,
        },
      },
    );
    assert.equal(
      mcpDeniedThread.status,
      201,
      JSON.stringify(mcpDeniedThread.body),
    );
    await wait(
      () =>
        db
          .prepare("SELECT status FROM threads WHERE id=?")
          .get(mcpDeniedThread.body.id)?.status === "idle",
      `denied MCP invocation ${user.login}`,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS count FROM control_plane_agent_invocations WHERE parent_kind='thread' AND parent_id=?",
        )
        .get(mcpDeniedThread.body.id).count,
      0,
    );
    const workerBinding = db
      .prepare(
        "SELECT b.owner_user_id,b.profile_version_id FROM control_plane_threads c JOIN control_plane_job_bindings b ON b.id=c.job_binding_id WHERE c.thread_id=?",
      )
      .get(history.calls[0].childThreadId);
    assert.equal(workerBinding.owner_user_id, user.id);
    assert.equal(workerBinding.profile_version_id, profile.body.version.id);
    assert.equal(history.calls[0].model, profile.body.version.definition.model);
    assert.equal(
      history.calls[0].reasoningLevel,
      profile.body.version.definition.reasoningLevel,
    );
    assert.equal(
      (
        await userRequest(
          user.login,
          `/control-plane/user/threads/${history.calls[0].childThreadId}/profile`,
        )
      ).body.version.id,
      profile.body.version.id,
    );
    const foreign = subjects.find((item) => item.user.id !== user.id);
    for (const suffix of ["", "/result", "/events"])
      assert.equal(
        (await userRequest(foreign.user.login, `${base}/${run.runId}${suffix}`))
          .status,
        404,
      );
    assert.equal(
      (
        await userRequest(foreign.user.login, `${base}/${run.runId}/cancel`, {
          method: "POST",
        })
      ).status,
      404,
    );
    assert.equal(
      (await userRequest(foreign.user.login, base, { method: "POST", body }))
        .status,
      404,
    );
    for (const suffix of ["", "/result", "/timeline", "/profile"])
      assert.equal(
        (
          await userRequest(
            foreign.user.login,
            `/control-plane/user/threads/${history.calls[0].childThreadId}${suffix}`,
          )
        ).status,
        404,
      );
    for (const suffix of [
      "inspection",
      "trace",
      `trace?attemptId=${trace.attempt.id}`,
      `calls/${history.calls[0].id}`,
    ]) {
      assert.equal(
        (
          await userRequest(
            foreign.user.login,
            `/control-plane/user/workflows/${run.runId}/${suffix}`,
          )
        ).status,
        404,
      );
    }
    const denied = await userRequest(foreign.user.login, base, {
      method: "POST",
      body: {
        ...body,
        projectId: foreign.project.projectId,
        idempotencyKey: `foreign-step-${user.login}`,
      },
    });
    assert.equal(denied.status, 201, JSON.stringify(denied.body));
    await wait(
      async () =>
        (await userRequest(foreign.user.login, `${base}/${denied.body.runId}`))
          .body.status === "failed",
      "ungranted workflow step rejected",
    );
    assert.equal(
      (
        await userCommand(foreign.user.login, [
          "workflows",
          "history",
          denied.body.runId,
          "--json",
        ])
      ).calls.length,
      0,
    );
    published.push({
      compositionSource: {
        profileVersionId: delegationProfile.body.version.id,
        script: delegationScript,
        args: `BB_PERSONAL_delegated-${user.login}`,
      },
      composition: {
        runId: composed.body.runId,
        callId: composedHistory.calls[1].id,
        childRunId: composedOutput.workflow.runId,
      },
      subject,
      body,
      run,
      script,
      callId: history.calls[0].id,
      childThreadId: history.calls[0].childThreadId,
    });
  }
  return {
    inspections: published.map((item) => ({
      login: item.subject.user.login,
      composition: item.composition,
      runId: item.run.runId,
      callId: item.callId,
      childThreadId: item.childThreadId,
    })),
    verification: {
      workflowInspectionNativeMetadataCliAndForeignDenial: true,
      workflowTraceNestedScopesParallelAndReplay: true,
      workflowCallDiagnosticsAndNativeEditArtifacts: true,
      workflowInspectionReplayProvenance: true,
      publishedAgentConversationAndWorkflowCompositionTwoUsers: true,
      qwenMcpPublishedAgentInvocationTwoUsers: true,
      qwenMcpDeniedTargetCreatesNoInvocationTwoUsers: true,
      parentCancellationStopsDelegatedWorkflowAndWorker: true,
      publishedWorkflowAgentsNativeUidHomeCwdTwoUsers: true,
      publishedWorkflowAgentsPinnedSourceAndContracts: true,
      publishedWorkflowAgentsIdempotencyAndForeignAccessDenied: true,
      publishedWorkflowAgentsNativeHistoryAndReplay: true,
      publishedWorkflowStepsPinnedProfileAndForeignChildScope: true,
    },
    async afterRestart() {
      for (const saved of published) {
        const restoredComposition = await userRequest(
          saved.subject.user.login,
          `${base}/${saved.composition.runId}/result`,
        );
        assert.equal(
          restoredComposition.status,
          200,
          JSON.stringify(restoredComposition.body),
        );
        assert.equal(restoredComposition.body.run.status, "succeeded");
        const restoredCall = await userCommand(saved.subject.user.login, [
          "workflows",
          "call",
          saved.composition.runId,
          saved.composition.callId,
          "--json",
        ]);
        assert.equal(
          restoredCall.agentInvocation.runId,
          saved.composition.childRunId,
        );
        assert.equal(restoredCall.agentInvocation.state, "succeeded");
        assert.equal(
          (
            await userRequest(
              saved.subject.user.login,
              `${base}/${saved.composition.childRunId}/result`,
            )
          ).status,
          200,
        );
      }
      const item = published.find((row) => row.subject.user.login === "alice");
      const result = await userRequest(
        "alice",
        `${base}/${item.run.runId}/result`,
      );
      assert.equal(result.status, 200);
      assert.equal(result.body.run.status, "succeeded");
      const retried = await userRequest("alice", base, {
        method: "POST",
        body: item.body,
      });
      assert.equal(retried.status, 201, JSON.stringify(retried.body));
      assert.equal(retried.body.runId, item.run.runId);
      const restored = await userCommand("alice", [
        "workflows",
        "call",
        item.run.runId,
        item.callId,
        "--json",
      ]);
      assert.ok(
        restored.workers.some(
          (worker) => worker.threadId === item.childThreadId,
        ),
      );
      assert.equal(restored.outputAvailable, true);
      const restoredTrace = await userCommand("alice", [
        "workflows",
        "trace",
        item.run.runId,
        "--json",
      ]);
      assert.equal(restoredTrace.attempt.status, "succeeded");
      assert.equal(
        restoredTrace.entries.find((entry) => entry.kind === "workflow").name,
        "nested-agent-step",
      );
      const login = await sendAdmin("/control-plane/login", {
        login: "operator",
        password,
      });
      assert.equal(login.status, 200);
      const access = `/control-plane/admin/profiles/${item.subject.profile.body.profile.id}/access/${item.subject.user.id}`;
      const compositionReplayInput = {
        projectId: item.subject.project.projectId,
        ...item.compositionSource,
        resumeRunId: item.composition.runId,
      };
      const replayInput = {
        projectId: item.body.projectId,
        profileVersionId: item.body.profileVersionId,
        script: item.script,
        args: item.body.input,
        resumeRunId: item.run.runId,
      };
      assert.equal(
        (await sendAdmin(access, { allowed: false }, login.body.token, "PUT"))
          .status,
        200,
      );
      try {
        const deniedCompositionReplay = await userRequest(
          "alice",
          "/control-plane/user/workflows",
          { method: "POST", body: compositionReplayInput },
        );
        assert.equal(
          deniedCompositionReplay.status,
          201,
          JSON.stringify(deniedCompositionReplay.body),
        );
        await wait(
          async () =>
            (
              await userRequest(
                "alice",
                `/control-plane/user/workflows/${deniedCompositionReplay.body.id}`,
              )
            ).body.status === "failed",
          "revoked delegated target denies cached result after restart",
        );
        const denied = await userRequest(
          "alice",
          "/control-plane/user/workflows",
          { method: "POST", body: replayInput },
        );
        assert.equal(denied.status, 201, JSON.stringify(denied.body));
        await wait(
          async () =>
            (
              await userRequest(
                "alice",
                `/control-plane/user/workflows/${denied.body.id}`,
              )
            ).body.status === "failed",
          "revoked cached step after restart",
        );
        const result = await userRequest(
          "alice",
          `/control-plane/user/workflows/${denied.body.id}/result`,
        );
        assert.equal(result.body.available, false);
        assert.equal(
          (
            await userCommand("alice", [
              "workflows",
              "history",
              denied.body.id,
              "--json",
            ])
          ).calls.length,
          0,
        );
      } finally {
        assert.equal(
          (await sendAdmin(access, { allowed: true }, login.body.token, "PUT"))
            .status,
          200,
        );
      }
      const resumed = await userRequest(
        "alice",
        "/control-plane/user/workflows",
        { method: "POST", body: replayInput },
      );
      assert.equal(resumed.status, 201, JSON.stringify(resumed.body));
      await wait(
        async () =>
          (
            await userRequest(
              "alice",
              `/control-plane/user/workflows/${resumed.body.id}`,
            )
          ).body.status === "succeeded",
        "regranted cached step after restart",
      );
      const reused = await userCommand("alice", [
        "workflows",
        "history",
        resumed.body.id,
        "--json",
      ]);
      assert.equal(reused.calls.length, 1);
      assert.equal(reused.calls[0].childThreadId, null);
      const composedReplay = await userRequest(
        "alice",
        "/control-plane/user/workflows",
        { method: "POST", body: compositionReplayInput },
      );
      assert.equal(
        composedReplay.status,
        201,
        JSON.stringify(composedReplay.body),
      );
      await wait(
        async () =>
          (
            await userRequest(
              "alice",
              `/control-plane/user/workflows/${composedReplay.body.id}`,
            )
          ).body.status === "succeeded",
        "delegated cached replay after regrant",
      );
      const composedReplayInspection = await userCommand("alice", [
        "workflows",
        "inspect",
        composedReplay.body.id,
        "--json",
      ]);
      assert.equal(composedReplayInspection.calls.length, 2);
      assert.ok(
        composedReplayInspection.calls.every(
          (call) => call.source === "cached",
        ),
      );
      return {
        publishedAgentCompositionMetadataAndResultsSurviveRestart: true,
        publishedAgentCompositionReplayRevocationAndRegrant: true,
        workflowTraceStructureSurvivesRestart: true,
        publishedWorkflowAgentsIdentityAndResultAfterRestart: true,
        publishedWorkflowStepRevocationAndRegrantReplayAfterRestart: true,
      };
    },
  };
}
