import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
export async function verifyWorkflowDefinitions({
  subjects,
  userCommand,
  db,
  wait,
  adminRpc,
}) {
  const storage = new Database("/srv/bb/plugins/workflows/data.db", {
    readonly: true,
  });
  const saved = [];
  const script =
    'export const meta={name:"saved-definition",description:"Saved native definition"}; return args;';
  const command = (subject, ...args) =>
    userCommand(subject.user.login, [
      "workflows",
      "definitions",
      ...args,
      "--json",
    ]);
  async function completed(run, value) {
    await wait(() => {
      const row = storage
        .prepare(
          "SELECT status,error,result_json FROM workflow_runs WHERE id=?",
        )
        .get(run.id);
      if (row?.status === "failed") throw new Error(row.error);
      if (row?.status !== "succeeded") return false;
      assert.deepEqual(JSON.parse(row.result_json), value);
      return true;
    }, "saved definition executes exact revision and arguments");
  }
  try {
    for (const subject of subjects) {
      const args = { owner: subject.user.login, revision: 1 };
      const item = await userCommand(
        subject.user.login,
        [
          "workflows",
          "definitions",
          "create",
          subject.thread.id,
          "--script-stdin",
          "--args",
          JSON.stringify(args),
          "--json",
        ],
        script,
      );
      assert.equal(item.revision, 1);
      const updated = await userCommand(
        subject.user.login,
        [
          "workflows",
          "definitions",
          "update",
          item.id,
          "--revision",
          "1",
          "--script-stdin",
          "--args",
          JSON.stringify({ ...args, revision: 2 }),
          "--json",
        ],
        script,
      );
      assert.equal(updated.revision, 2);
      await assert.rejects(
        () =>
          userCommand(
            subject.user.login,
            [
              "workflows",
              "definitions",
              "update",
              item.id,
              "--revision",
              "1",
              "--script-stdin",
              "--json",
            ],
            script,
          ),
        /400/u,
      );
      const previous = await command(
        subject,
        "get",
        item.id,
        "--revision",
        "1",
      );
      assert.deepEqual(previous.args, args);
      const run = await command(subject, "run", item.id, "--revision", "1");
      await completed(run, args);
      const root = db
        .prepare(
          "SELECT * FROM control_plane_job_bindings WHERE kind='workflow-definition' AND object_id=?",
        )
        .get(item.id);
      const child = db
        .prepare(
          "SELECT * FROM control_plane_job_bindings WHERE kind='workflow-run' AND object_id=?",
        )
        .get(run.id);
      assert.equal(root.owner_user_id, subject.user.id);
      assert.equal(root.profile_version_id, subject.profile.body.version.id);
      assert.equal(child.source_binding_id, root.id);
      const replay = await userCommand(
        subject.user.login,
        [
          "workflows",
          "start",
          subject.thread.id,
          "--resume",
          run.id,
          "--script-stdin",
          "--json",
        ],
        script,
      );
      await completed(replay, null);
      assert.equal(
        db
          .prepare(
            "SELECT source_binding_id FROM control_plane_job_bindings WHERE kind='workflow-run' AND object_id=?",
          )
          .get(replay.id).source_binding_id,
        root.id,
      );
      const overridden = await command(
        subject,
        "run",
        item.id,
        "--revision",
        "2",
        "--args",
        "null",
      );
      await completed(overridden, null);
      saved.push({ subject, id: item.id, args, firstRunId: run.id });
    }
    for (const [index, entry] of saved.entries()) {
      const foreign = saved[1 - index].subject;
      const listing = await command(
        entry.subject,
        "list",
        "--project",
        entry.subject.project.projectId,
      );
      assert.equal(
        listing.definitions.some((row) => row.id === entry.id),
        true,
      );
      assert.equal(
        listing.definitions.some((row) => row.id === saved[1 - index].id),
        false,
      );
      for (const action of ["get", "delete", "enable", "disable"])
        await assert.rejects(() => command(foreign, action, entry.id), /404/u);
      await assert.rejects(
        () => command(foreign, "run", entry.id, "--revision", "1"),
        /404/u,
      );
    }
    const alice = saved[0];
    const waiting =
      'export const meta={name:"definition-wait",description:"Source revocation"}; phase("definition-wait"); return await agent("BB_PERSONAL_worker-hang-definition-alice");';
    await userCommand(
      alice.subject.user.login,
      [
        "workflows",
        "definitions",
        "update",
        alice.id,
        "--revision",
        "2",
        "--script-stdin",
        "--json",
      ],
      waiting,
    );
    const running = await command(
      alice.subject,
      "run",
      alice.id,
      "--revision",
      "3",
    );
    await wait(
      () =>
        storage
          .prepare("SELECT phase FROM workflow_runs WHERE id=?")
          .get(running.id)?.phase === "definition-wait",
      "definition run starts before source disable",
    );
    const marker = "bb-personal-worker-hang-definition-alice.json";
    async function commandProcesses() {
      const found = [];
      for (const pid of await readdir("/proc")) {
        if (!/^[0-9]+$/u.test(pid)) continue;
        try {
          const code = await readFile(`/proc/${pid}/cmdline`, "utf8");
          if (!code.includes(marker)) continue;
          const status = await readFile(`/proc/${pid}/status`, "utf8");
          assert.equal(
            Number(status.match(/^Uid:\s+(\d+)/mu)[1]),
            alice.subject.user.uid,
          );
          found.push(pid);
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
        }
      }
      return found;
    }
    await wait(async () => {
      try {
        const identity = JSON.parse(
          await readFile(`${alice.subject.user.home}/${marker}`, "utf8"),
        );
        assert.deepEqual(identity, {
          uid: alice.subject.user.uid,
          home: alice.subject.user.home,
          cwd: alice.subject.project.cwd,
        });
        return (await commandProcesses()).length > 0;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    }, "saved definition Qwen command runs under registered UID HOME cwd");
    assert.equal(
      (await command(alice.subject, "disable", alice.id)).enabled,
      false,
    );
    await wait(() => {
      const row = storage
        .prepare("SELECT status FROM workflow_runs WHERE id=?")
        .get(running.id);
      return row && ["failed", "cancelled"].includes(row.status);
    }, "disabled definition terminates active evaluator");
    await wait(
      async () => (await commandProcesses()).length === 0,
      "source disable reaps the actual Qwen command descendants",
    );
    await wait(() => {
      const child = storage
        .prepare("SELECT child_thread_id FROM workflow_calls WHERE run_id=?")
        .get(running.id)?.child_thread_id;
      const row = child
        ? db.prepare("SELECT archived_at FROM threads WHERE id=?").get(child)
        : null;
      return row && row.archived_at !== null;
    }, "disabled definition worker archived");
    await assert.rejects(
      () => command(alice.subject, "run", alice.id, "--revision", "1"),
      /400/u,
    );
    await assert.rejects(
      () =>
        userCommand(
          alice.subject.user.login,
          [
            "workflows",
            "start",
            alice.subject.thread.id,
            "--resume",
            alice.firstRunId,
            "--script-stdin",
            "--json",
          ],
          script,
        ),
      /400/u,
    );
    const bobRun = await command(
      saved[1].subject,
      "run",
      saved[1].id,
      "--revision",
      "1",
    );
    await completed(bobRun, saved[1].args);
    const disposable = await userCommand(
      alice.subject.user.login,
      [
        "workflows",
        "definitions",
        "create",
        alice.subject.thread.id,
        "--script-stdin",
        "--json",
      ],
      script,
    );
    await command(alice.subject, "delete", disposable.id);
    await assert.rejects(
      () => command(alice.subject, "get", disposable.id),
      /404/u,
    );
    return {
      verification: {
        personalDefinitionsCliCrudAndImmutableVersions: true,
        personalDefinitionDefaultAndExplicitNullArgs: true,
        personalDefinitionForeignIdsDenied: true,
        definitionRunBindsStableSourceAuthority: true,
        definitionReplayPreservesDisabledSourceAuthority: true,
        definitionDisableTerminatesActualUidEvaluator: true,
        definitionDisableDoesNotBlockAnotherOwner: true,
        definitionDisableReapsActualQwenCommandDescendants: true,
        definitionQwenCommandActualUidHomeAndCwd: true,
      },
      async afterRestart() {
        const reopened = new Database("/srv/bb/plugins/workflows/data.db", {
          readonly: true,
        });
        try {
          for (const [index, entry] of saved.entries()) {
            const current = await adminRpc("controlPlaneDefinitionGet", {
              id: entry.id,
            });
            assert.equal(current.revision, index === 0 ? 3 : 2);
            assert.equal(current.enabled, index !== 0);
            assert.deepEqual(
              (
                await adminRpc("controlPlaneDefinitionGet", {
                  id: entry.id,
                  revision: 1,
                })
              ).args,
              entry.args,
            );
          }
          const inventory = await adminRpc("controlPlaneDefinitionInventory", {
            limit: 50,
          });
          for (const entry of saved)
            assert.ok(
              inventory.definitions.some(
                (row) =>
                  row.id === entry.id &&
                  row.ownerUserId === entry.subject.user.id,
              ),
            );
          const source = db
            .prepare(
              "SELECT id FROM control_plane_job_bindings WHERE kind='workflow-definition' AND object_id=?",
            )
            .get(saved[0].id);
          const before = db
            .prepare(
              "SELECT count(*) AS count FROM control_plane_job_bindings WHERE source_binding_id=?",
            )
            .get(source.id).count;
          await assert.rejects(() =>
            adminRpc("controlPlaneDefinitionRun", {
              id: saved[0].id,
              revision: 1,
            }),
          );
          assert.equal(
            db
              .prepare(
                "SELECT count(*) AS count FROM control_plane_job_bindings WHERE source_binding_id=?",
              )
              .get(source.id).count,
            before,
          );
          await assert.rejects(
            () => command(saved[1].subject, "get", saved[1].id),
            /401/u,
          );
          const resumed = await adminRpc("controlPlaneDefinitionRun", {
            id: saved[1].id,
            revision: 1,
          });
          const owner = db
            .prepare(
              "SELECT owner_user_id FROM control_plane_job_bindings WHERE kind='workflow-run' AND object_id=?",
            )
            .get(resumed.id);
          assert.equal(owner.owner_user_id, saved[1].subject.user.id);
          await wait(() => {
            const row = reopened
              .prepare(
                "SELECT status,error,result_json FROM workflow_runs WHERE id=?",
              )
              .get(resumed.id);
            if (row?.status === "failed") throw new Error(row.error);
            if (row?.status !== "succeeded") return false;
            assert.deepEqual(JSON.parse(row.result_json), saved[1].args);
            return true;
          }, "saved definition executes after restart");
          return {
            definitionOwnerVersionsEnabledStateAndExecutionSurviveRestart: true,
            adminDefinitionInventoryIncludesBothOwners: true,
            revokedBobCredentialStillDeniedAfterRestart: true,
            definitionExecutionAfterLogoutUsesSavedOwnerNotAdmin: true,
          };
        } finally {
          reopened.close();
        }
      },
    };
  } finally {
    storage.close();
  }
}
