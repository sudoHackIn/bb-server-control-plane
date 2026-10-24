import assert from "node:assert/strict";
import { once } from "node:events";
import Database from "better-sqlite3";

export async function verifyNativeWorkflows({
  launch,
  signal,
  wait,
  password,
  origin,
  subjects,
  db,
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
      'export const meta = {name: "managed-owner-check", description: "Native ownership check"}; return "must not evaluate in service process";';
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
        assert.equal(row.status, "failed");
        assert.match(row.error, /isolated evaluator/u);
        assert.equal(row.result_json, null);
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
  }, "native workflow owner persistence and execution guard");
  verify();
  return {
    verification: {
      nativeWorkflowCliOwnerAndPinnedProfile: true,
      nativeWorkflowServiceEvaluatorDenied: true,
    },
    afterRestart() {
      verify();
      return { nativeWorkflowOwnerBindingSurvivesRestart: true };
    },
  };
}
