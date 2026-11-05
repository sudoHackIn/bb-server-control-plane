import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
export async function verifyTaskSources({
  published,
  fixture,
  userRequest,
  userCommand,
  wait,
  db,
  sendAdmin,
  adminToken,
}) {
  const saved = [];
  for (const item of published) {
    const { user, project, profile } = item.subject;
    const bd = (args) =>
      execFileSync(
        "/usr/bin/setpriv",
        [
          "--reuid",
          String(user.uid),
          "--regid",
          String(user.uid),
          "--clear-groups",
          "--no-new-privs",
          "/usr/local/bin/bd",
          ...args,
        ],
        {
          cwd: project.cwd,
          env: {
            PATH: "/usr/local/bin:/usr/bin:/bin",
            HOME: user.home,
            USER: user.login,
            LANG: "C.UTF-8",
            BEADS_DIR: `${project.cwd}/.beads`,
          },
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 1048576,
        },
      );
    bd(["init", "--quiet", "--stealth", "--prefix", `tasks${user.login}`]);
    const task = JSON.parse(
      bd([
        "create",
        `BB_PERSONAL_poll-${user.login}`,
        "--type",
        "task",
        "--json",
      ]),
    );
    const blocked = JSON.parse(
      bd([
        "create",
        "Must not dispatch blocked work",
        "--type",
        "task",
        "--json",
      ]),
    );
    bd(["dep", "add", blocked.id, task.id]);
    const source = await userCommand(user.login, [
      "task-sources",
      "create",
      project.projectId,
      "--profile-version",
      profile.body.version.id,
      "--name",
      `Beads ${user.login}`,
      "--interval",
      "3600",
      "--json",
    ]);
    assert.equal(source.enabled, false);
    const base = `/control-plane/user/task-sources/${source.id}`;
    assert.equal(
      (await userRequest(user.login, `${base}/poll`, { method: "POST" }))
        .status,
      409,
    );
    await userCommand(user.login, [
      "task-sources",
      "enable",
      source.id,
      "--json",
    ]);
    const first = await userCommand(user.login, [
      "task-sources",
      "poll",
      source.id,
      "--json",
    ]);
    assert.equal(first.error, null, JSON.stringify(first));
    const history = await userCommand(user.login, [
      "task-sources",
      "history",
      source.id,
      "--json",
    ]);
    assert.equal(history.items.length, 1, JSON.stringify(history));
    assert.equal(history.items[0].externalId, task.id);
    assert.equal(history.items[0].state, "accepted");
    const admission = history.items[0];
    await wait(async () => {
      const response = await userRequest(
        user.login,
        `/control-plane/user/agent-runs/${admission.runId}/result`,
      );
      assert.equal(response.status, 200);
      assert.equal(response.body.run.source, "task-source");
      return response.body.text === `Personal poll-${user.login} completed`;
    }, `Beads native run ${user.login}`);
    assert.deepEqual(
      JSON.parse(
        await readFile(
          `${user.home}/bb-personal-poll-${user.login}.json`,
          "utf8",
        ),
      ),
      { uid: user.uid, home: user.home, cwd: project.cwd },
    );
    await userCommand(user.login, [
      "task-sources",
      "poll",
      source.id,
      "--json",
    ]);
    assert.deepEqual(
      (
        await userCommand(user.login, [
          "task-sources",
          "history",
          source.id,
          "--json",
        ])
      ).items,
      history.items,
    );
    assert.equal(JSON.parse(bd(["show", task.id, "--json"]))[0].status, "open");
    const other = user.login === "alice" ? "bob" : "alice";
    for (const suffix of ["", "/history"])
      assert.equal((await userRequest(other, base + suffix)).status, 404);
    assert.equal(
      (await userRequest(other, `${base}/poll`, { method: "POST" })).status,
      404,
    );
    assert.equal(
      (
        await userRequest(
          other,
          `/control-plane/user/agent-runs/${admission.runId}/result`,
        )
      ).status,
      404,
    );
    const revoke = await sendAdmin(
      `/control-plane/admin/profiles/${profile.body.profile.id}/access/${user.id}`,
      { allowed: false },
      adminToken,
      "PUT",
    );
    assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
    assert.equal(
      (await userRequest(user.login, `${base}/poll`, { method: "POST" }))
        .status,
      403,
    );
    const grant = await sendAdmin(
      `/control-plane/admin/profiles/${profile.body.profile.id}/access/${user.id}`,
      { allowed: true },
      adminToken,
      "PUT",
    );
    assert.equal(grant.status, 200);
    await userCommand(user.login, [
      "task-sources",
      "disable",
      source.id,
      "--json",
    ]);
    await fixture("task-source-lost-reply", { id: admission.id });
    saved.push({ user, source, admission });
  }
  return {
    async afterRestart() {
      for (const { user, source, admission } of saved) {
        await userCommand(user.login, [
          "task-sources",
          "enable",
          source.id,
          "--json",
        ]);
        const polled = await userCommand(user.login, [
          "task-sources",
          "poll",
          source.id,
          "--json",
        ]);
        assert.equal(polled.error, null, JSON.stringify(polled));
        const history = await userCommand(user.login, [
          "task-sources",
          "history",
          source.id,
          "--json",
        ]);
        assert.equal(history.items.length, 1);
        assert.equal(history.items[0].runId, admission.runId);
        assert.equal(history.items[0].id, admission.id);
        assert.equal(
          db
            .prepare(
              "SELECT count(*) AS count FROM control_plane_threads WHERE run_idempotency_key=?",
            )
            .get(`task-source:${admission.id}`).count,
          1,
        );
        await userCommand(user.login, [
          "task-sources",
          "disable",
          source.id,
          "--json",
        ]);
      }
      return { taskSourceBeadsLostReplyRecoveryAfterRestart: true };
    },
  };
}
