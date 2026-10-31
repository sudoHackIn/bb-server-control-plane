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
  return {
    browser: {
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
    },
    async afterRestart(currentAdminToken) {
      const saved = await sendAdmin(grantPath, undefined, currentAdminToken);
      assert.equal(saved.status, 200);
      assert.equal(saved.body.grant.role, "reviewer");
      assert.ok(saved.body.grant.revision >= 4);
      await verifyRead(currentAdminToken);
      return { diagnosticGrantsReadOnlyAndForeignDenialSurviveRestart: true };
    },
  };
}
