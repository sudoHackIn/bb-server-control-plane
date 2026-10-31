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
    const invocation = `return await agent(args,{profileVersionId:${JSON.stringify(profile.body.version.id)}});`;
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
        definition: { ...profile.body.version.definition, workflow },
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
    for (const suffix of ["inspection", `calls/${history.calls[0].id}`]) {
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
      runId: item.run.runId,
      callId: item.callId,
      childThreadId: item.childThreadId,
    })),
    verification: {
      workflowInspectionNativeMetadataCliAndForeignDenial: true,
      workflowInspectionReplayProvenance: true,
      publishedWorkflowAgentsNativeUidHomeCwdTwoUsers: true,
      publishedWorkflowAgentsPinnedSourceAndContracts: true,
      publishedWorkflowAgentsIdempotencyAndForeignAccessDenied: true,
      publishedWorkflowAgentsNativeHistoryAndReplay: true,
      publishedWorkflowStepsPinnedProfileAndForeignChildScope: true,
    },
    async afterRestart() {
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
      const login = await sendAdmin("/control-plane/login", {
        login: "operator",
        password,
      });
      assert.equal(login.status, 200);
      const access = `/control-plane/admin/profiles/${item.subject.profile.body.profile.id}/access/${item.subject.user.id}`;
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
      return {
        publishedWorkflowAgentsIdentityAndResultAfterRestart: true,
        publishedWorkflowStepRevocationAndRegrantReplayAfterRestart: true,
      };
    },
  };
}
