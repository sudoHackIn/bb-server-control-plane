import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

export async function verifyDiagnosticAccess({
  subjects,
  inspections,
  db,
  wait,
  sendAdmin,
  adminToken,
  userRequest,
  userCommand,
}) {
  const alice = subjects.find((s) => s.user.login === "alice");
  const bob = subjects.find((s) => s.user.login === "bob");
  const inspection = inspections.find((s) => s.login === "alice");
  const reviewer = db
    .prepare("SELECT id FROM control_plane_users WHERE login='reviewer'")
    .get();
  assert.ok(alice && bob && inspection && reviewer);
  const projectId = alice.project.projectId;
  const rolePath = `/control-plane/admin/projects/${projectId}/access`;
  const grantPath = `/control-plane/admin/projects/${projectId}/diagnostics/${reviewer.id}`;
  const root = `/control-plane/user/inspections/workflows/${inspection.runId}`;
  const read = (login, path) => userRequest(login, path);
  const grant = async (role, expectedRevision) => {
    const result = await sendAdmin(
      grantPath,
      { role, expectedRevision },
      adminToken,
      "PUT",
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
  };
  await grant("reviewer", 0);
  assert.equal((await read("reviewer", `${root}/inspection`)).status, 404);
  const environment = await userRequest(
    "reviewer",
    "/control-plane/user/environment",
    { method: "POST", body: {} },
  );
  assert.equal(environment.status, 200, JSON.stringify(environment.body));
  assert.equal(environment.body.status, "ready");
  const policy = await sendAdmin(rolePath, undefined, adminToken);
  const changed = await sendAdmin(
    `${rolePath}/${reviewer.id}`,
    { role: "viewer", expectedRevision: policy.body.revision },
    adminToken,
    "PUT",
  );
  assert.ok([200, 202].includes(changed.status), JSON.stringify(changed.body));
  let maintenancePhase = null;
  if (changed.body.operationId)
    await wait(async () => {
      const status = await sendAdmin(
        `${rolePath}/maintenance/${changed.body.operationId}`,
        undefined,
        adminToken,
      );
      assert.equal(status.status, 200, JSON.stringify(status.body));
      assert.notEqual(status.body.phase, "failed", JSON.stringify(status.body));
      if (status.body.phase !== maintenancePhase) {
        maintenancePhase = status.body.phase;
        console.log(
          JSON.stringify({
            controlPlaneStage: "diagnostic-reviewer-project-maintenance",
            phase: maintenancePhase,
          }),
        );
      }
      return status.body.phase === "complete";
    }, "diagnostic reviewer project-read grant");
  async function verifyRead(currentAdminToken = adminToken) {
    const tree = await userCommand("reviewer", [
      "inspections",
      "workflow",
      inspection.runId,
      "--json",
    ]);
    assert.equal(tree.run.id, inspection.runId);
    const call = await userCommand("reviewer", [
      "inspections",
      "workflow",
      inspection.runId,
      "--call",
      inspection.callId,
      "--json",
    ]);
    assert.ok(
      call.fileArtifacts.entries.some(
        (entry) => entry.threadId === inspection.childThreadId,
      ),
    );
    const timeline = await userCommand("reviewer", [
      "inspections",
      "thread",
      inspection.childThreadId,
      "--workflow",
      inspection.runId,
      "--timeline",
      "--json",
    ]);
    assert.ok(
      JSON.stringify(timeline).includes("BB_PERSONAL_workflow-published-alice"),
    );
    let cursor = null;
    let found = false;
    const cursors = new Set();
    do {
      const runs = await userCommand("reviewer", [
        "inspections",
        "list",
        projectId,
        "--limit",
        "5",
        ...(cursor ? ["--cursor", cursor] : []),
        "--json",
      ]);
      found ||= runs.runs.some((run) => run.id === inspection.runId);
      cursor = runs.nextCursor;
      assert.ok(
        !cursor || !cursors.has(cursor),
        "Diagnostic pagination must advance",
      );
      if (cursor) cursors.add(cursor);
    } while (cursor && !found);
    assert.equal(found, true);
    assert.ok(
      [401, 404].includes((await read("bob", `${root}/inspection`)).status),
    );
    assert.equal(
      (
        await read(
          "reviewer",
          `/control-plane/user/threads/${inspection.childThreadId}`,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await read(
          "reviewer",
          `/control-plane/user/inspections/threads/${inspection.childThreadId}`,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await read(
          "reviewer",
          `/control-plane/user/inspections/threads/${bob.thread.id}`,
        )
      ).status,
      404,
    );
    const admin = await sendAdmin(
      `/control-plane/admin/inspections/workflows/${inspection.runId}/inspection`,
      undefined,
      currentAdminToken,
    );
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
  }
  await verifyRead();
  const denied = await userRequest(
    "reviewer",
    `/control-plane/user/workflows/${inspection.runId}/stop`,
    { method: "POST" },
  );
  assert.ok([403, 404].includes(denied.status));
  await grant(null, 1);
  assert.equal((await read("reviewer", `${root}/inspection`)).status, 404);
  await grant("developer", 2);
  assert.equal((await read("reviewer", `${root}/inspection`)).status, 200);
  const stale = await sendAdmin(
    grantPath,
    { role: null, expectedRevision: 1 },
    adminToken,
    "PUT",
  );
  assert.equal(stale.status, 409);
  await grant("reviewer", 3);
  console.log(
    JSON.stringify({
      controlPlaneStage: "diagnostic-reviewer-admin-scopes-verified",
    }),
  );
  const tests = await verifySeparateTests({
    alice,
    bob,
    inspection,
    userRequest,
    userCommand,
    wait,
  });
  return {
    browser: {
      tests: tests.browser,
      login: "reviewer",
      userId: reviewer.id,
      projectId,
      inspection,
      foreignThreadId: bob.thread.id,
    },
    verification: {
      diagnosticReviewerNativeCliAndArtifacts: true,
      diagnosticAdminForeignRunInspection: true,
      diagnosticGrantRevocationRoleChangeAndCas: true,
      diagnosticReadDoesNotGrantExecution: true,
      separatePublishedDraftAndJsonTestRunsActualUidHomeCwd: true,
    },
    async afterRestart(currentAdminToken) {
      const saved = await sendAdmin(grantPath, undefined, currentAdminToken);
      assert.equal(saved.status, 200);
      assert.equal(saved.body.grant.role, "reviewer");
      assert.ok(saved.body.grant.revision >= 4);
      await verifyRead(currentAdminToken);
      return {
        diagnosticGrantsReadOnlyAndForeignDenialSurviveRestart: true,
        ...(await tests.afterRestart()),
      };
    },
  };
}

async function verifySeparateTests({
  alice,
  bob,
  inspection,
  userRequest,
  userCommand,
  wait,
}) {
  const marker = "BB_PERSONAL_test-reproduce-alice";
  const script =
    'export const meta={name:"captured-test-source",description:"Captured production input"};return args;';
  const source = await userRequest("alice", "/control-plane/user/workflows", {
    method: "POST",
    body: {
      projectId: alice.project.projectId,
      profileVersionId: alice.profile.body.version.id,
      script,
      args: marker,
    },
  });
  assert.equal(source.status, 201, JSON.stringify(source.body));
  const target = await userCommand("alice", [
    "projects",
    "create",
    "workflow-tests",
    "--name",
    "Workflow test project",
    "--json",
  ]);
  const published = await userRequest(
    "alice",
    `/control-plane/user/inspections/workflows/${inspection.runId}/inspection`,
  );
  assert.equal(published.status, 200);
  const profileVersionId = published.body.profileVersionId;
  async function terminal(id) {
    let result;
    await wait(async () => {
      result = await userRequest(
        "alice",
        `/control-plane/user/workflows/${id}`,
      );
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.ok(
        !["failed", "cancelled"].includes(result.body.status),
        JSON.stringify(result.body),
      );
      return result.body.status === "succeeded";
    }, "separate workflow test completion");
    return result.body;
  }
  await terminal(source.body.id);
  const captured = await userRequest(
    "alice",
    `/control-plane/user/inspections/workflows/${source.body.id}/inspection`,
  );
  const start = (args) =>
    userCommand("alice", [
      "test-runs",
      "start",
      source.body.id,
      "--project",
      target.projectId,
      ...args,
      "--json",
    ]);
  const tested = await start([
    "--profile-version",
    profileVersionId,
    "--idempotency-key",
    "published-test",
  ]);
  assert.equal(tested.input, marker);
  assert.notEqual(tested.runId, source.body.id);
  await terminal(tested.runId);
  assert.equal(
    (
      await start([
        "--profile-version",
        profileVersionId,
        "--idempotency-key",
        "published-test",
      ])
    ).id,
    tested.id,
  );
  const proof = JSON.parse(
    await readFile(
      `${alice.user.home}/bb-personal-test-reproduce-alice.json`,
      "utf8",
    ),
  );
  assert.deepEqual(proof, {
    uid: alice.user.uid,
    home: alice.user.home,
    cwd: target.cwd,
  });
  const draftScript =
    'export const meta={name:"draft-test",description:"Saved draft selection"};return args;';
  const draft = await userRequest(
    "alice",
    "/control-plane/user/workflow-definitions",
    {
      method: "POST",
      body: {
        originThreadId: alice.thread.id,
        script: draftScript,
        args: "do not use defaults",
      },
    },
  );
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const draftTest = await start([
    "--profile-version",
    alice.profile.body.version.id,
    "--draft",
    draft.body.id,
    "--revision",
    "1",
    "--idempotency-key",
    "draft-test",
  ]);
  await terminal(draftTest.runId);
  assert.equal(
    (
      await userRequest(
        "alice",
        `/control-plane/user/workflows/${draftTest.runId}/result`,
      )
    ).body.value,
    marker,
  );
  const update = await userRequest(
    "alice",
    `/control-plane/user/workflow-definitions/${draft.body.id}`,
    {
      method: "PUT",
      body: {
        expectedRevision: 1,
        script: draftScript + "\n",
        args: "new defaults",
      },
    },
  );
  assert.equal(update.status, 200, JSON.stringify(update.body));
  const conflict = await userRequest("alice", "/control-plane/user/test-runs", {
    method: "POST",
    body: {
      sourceRunId: source.body.id,
      projectId: target.projectId,
      target: {
        kind: "draft",
        profileVersionId: alice.profile.body.version.id,
        definitionId: draft.body.id,
        revision: 2,
      },
      idempotencyKey: "draft-test",
    },
  });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(
    (await userRequest("bob", `/control-plane/user/test-runs/${tested.id}`))
      .status,
    404,
  );
  assert.equal(
    (
      await userRequest("reviewer", "/control-plane/user/test-runs", {
        method: "POST",
        body: {
          sourceRunId: inspection.runId,
          projectId: target.projectId,
          target: { kind: "published", profileVersionId },
          idempotencyKey: "no-execution-grants",
        },
      })
    ).status,
    404,
  );
  const jsonInput = { task: "preserve JSON", items: [1, 2, 3] };
  const jsonSource = await userRequest(
    "alice",
    "/control-plane/user/workflows",
    {
      method: "POST",
      body: {
        projectId: alice.project.projectId,
        profileVersionId: alice.profile.body.version.id,
        script,
        args: jsonInput,
      },
    },
  );
  assert.equal(jsonSource.status, 201, JSON.stringify(jsonSource.body));
  await terminal(jsonSource.body.id);
  const jsonTest = await userCommand("alice", [
    "test-runs",
    "start",
    jsonSource.body.id,
    "--project",
    target.projectId,
    "--profile-version",
    alice.profile.body.version.id,
    "--draft",
    draft.body.id,
    "--revision",
    "1",
    "--idempotency-key",
    "json-test",
    "--json",
  ]);
  await terminal(jsonTest.runId);
  assert.deepEqual(
    (
      await userRequest(
        "alice",
        `/control-plane/user/workflows/${jsonTest.runId}/result`,
      )
    ).body.value,
    jsonInput,
  );
  const finalSource = await userRequest(
    "alice",
    `/control-plane/user/inspections/workflows/${source.body.id}/inspection`,
  );
  assert.equal(finalSource.body.sourceHash, captured.body.sourceHash);
  assert.equal(finalSource.body.run.status, "succeeded");
  assert.equal(finalSource.body.callCounts.total, 0);
  console.log(
    JSON.stringify({
      controlPlaneStage: "separate-test-runs-published-draft-json-uid-verified",
    }),
  );
  return {
    browser: {
      sourceRunId: source.body.id,
      testProjectId: target.projectId,
      profileVersionId,
      workerProfileVersionId: alice.profile.body.version.id,
      draftDefinitionId: draft.body.id,
      executionUserId: alice.user.id,
      input: marker,
    },
    async afterRestart() {
      for (const item of [tested, draftTest, jsonTest]) {
        const stored = await userCommand("alice", [
          "test-runs",
          "get",
          item.runId,
          "--run",
          "--json",
        ]);
        assert.equal(stored.testRun.id, item.id);
        assert.equal(stored.testRun.testedSourceHash, item.testedSourceHash);
        assert.equal(stored.testRun.state, "started");
        assert.equal(
          (
            await userRequest(
              "alice",
              `/control-plane/user/workflows/${item.runId}/result`,
            )
          ).status,
          200,
        );
      }
      return { separateTestProvenanceAndResultsSurviveRestart: true };
    },
  };
}
