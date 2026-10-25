import assert from "node:assert/strict";
import { once } from "node:events";
import { get } from "node:https";
import { randomUUID } from "node:crypto";
import { writeFile, chown, rm, readFile, readdir } from "node:fs/promises";
import Database from "better-sqlite3";

export async function verifyNativeAutomations({
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
    HOME: "/tmp/bb-automation-admin",
    BB_SERVER_URL: origin,
    BB_CLI: "",
    BB_CLI_ERROR_LOG: "0",
    NODE_EXTRA_CA_CERTS: "/tmp/bb-test-certificates/ca.crt",
  };
  async function cli(args, input = "") {
    const child = launch(["apps/cli/dist/index.js", ...args], { env });
    let output = "",
      error = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (error += chunk));
    child.stdin.end(input);
    assert.equal(
      (await once(child, "exit", { signal }))[0],
      0,
      error || output,
    );
    return JSON.parse(output);
  }
  const login = () =>
    cli(
      [
        "server",
        "access",
        "login",
        "--login",
        "operator",
        "--password-stdin",
        "--json",
      ],
      password,
    );
  await login();
  await cli(["plugin", "enable", "automations", "--json"]);
  async function rpc(method, input) {
    const path = `/tmp/bb-automation-input-${randomUUID()}.json`;
    await writeFile(path, JSON.stringify(input), { mode: 0o600, flag: "wx" });
    await chown(path, 1000, 1000);
    try {
      return await cli([
        "plugin",
        "rpc",
        "call",
        "automations",
        method,
        "--input-file",
        path,
        "--json",
      ]);
    } catch (error) {
      const ca = await readFile("/tmp/bb-test-certificates/ca.crt");
      const health = await new Promise((resolve) => {
        const req = get(`${origin}/health`, { ca, timeout: 2000 }, (reply) => {
          reply.resume();
          resolve(reply.statusCode);
        });
        req.on("error", () => resolve("unreachable"));
        req.on("timeout", () => req.destroy());
      });
      throw new Error(
        `Automation RPC ${method} failed; health=${health}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      await rm(path, { force: true });
    }
  }
  const storage = new Database("/srv/bb/plugins/automations/data.db", {
    readonly: true,
  });
  const owned = [];
  function payload(subject, marker, runAt = Date.now() + 3600000) {
    const definition = subject.profile.body.version.definition;
    return {
      projectId: subject.project.projectId,
      name: marker,
      enabled: true,
      origin: "human",
      createdByThreadId: subject.thread.id,
      trigger: { triggerType: "once", runAt },
      execution: {
        mode: "agent",
        prompt: `BB_PERSONAL_${marker}`,
        providerId: definition.providerId,
        model: definition.model,
        reasoningLevel: definition.reasoningLevel,
        permissionMode: definition.permissionMode,
        environment: { type: "project-default" },
      },
    };
  }
  async function completed(id) {
    await wait(() => {
      const row = storage
        .prepare("SELECT * FROM automation_runs WHERE id=?")
        .get(id);
      if (row?.status === "failed") throw new Error(row.error);
      return row?.status === "succeeded";
    }, "owned native automation completes");
  }
  async function proof(subject, marker) {
    const value = JSON.parse(
      await readFile(`${subject.user.home}/bb-personal-${marker}.json`, "utf8"),
    );
    assert.deepEqual(value, {
      uid: subject.user.uid,
      home: subject.user.home,
      cwd: subject.project.cwd,
    });
  }
  async function commandProcesses() {
    const found = [];
    for (const name of await readdir("/proc")) {
      if (!/^[0-9]+$/u.test(name)) continue;
      try {
        const command = await readFile(`/proc/${name}/cmdline`, "utf8");
        if (!command.includes("bb-personal-worker-hang-automation-alice.json"))
          continue;
        const status = await readFile(`/proc/${name}/status`, "utf8");
        found.push({
          pid: Number(name),
          uid: Number(status.match(/^Uid:\s+(\d+)/mu)?.[1]),
        });
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
      }
    }
    return found;
  }
  try {
    for (const subject of subjects) {
      const marker = `automation-agent-${subject.user.login}`;
      const saved = await rpc("automations_create", payload(subject, marker));
      const auth = storage
        .prepare("SELECT * FROM automation_authorities WHERE automation_id=?")
        .get(saved.id);
      assert.equal(auth.owner_user_id, subject.user.id);
      const run = (
        await rpc("automations_run", {
          projectId: saved.projectId,
          automationId: saved.id,
          idempotencyKey: "one",
        })
      ).run;
      assert.equal(
        (
          await rpc("automations_run", {
            projectId: saved.projectId,
            automationId: saved.id,
            idempotencyKey: "one",
          })
        ).run.id,
        run.id,
      );
      await completed(run.id);
      await wait(
        () =>
          storage
            .prepare(
              "SELECT runtime_released_at FROM automation_run_authorities WHERE run_id=?",
            )
            .get(run.id)?.runtime_released_at > 0,
        "completed automation runtime release acknowledged",
      );
      await proof(subject, marker);
      const binding = db
        .prepare(
          "SELECT * FROM control_plane_job_bindings WHERE object_id=? AND kind='automation-run'",
        )
        .get(run.id);
      assert.equal(binding.owner_user_id, subject.user.id);
      assert.equal(binding.source_binding_id, auth.binding_id);
      const worker = db
        .prepare(
          "SELECT t.owner_user_id,t.profile_version_id,b.kind,b.source_binding_id FROM control_plane_threads t JOIN control_plane_job_bindings b ON b.id=t.job_binding_id WHERE t.thread_id=?",
        )
        .get(run.threadId);
      assert.equal(worker.kind, "automation-worker");
      assert.equal(worker.owner_user_id, subject.user.id);
      assert.equal(worker.source_binding_id, binding.id);
      assert.equal(worker.profile_version_id, subject.profile.body.version.id);
      owned.push({ subject, saved, run });
    }
    const alice = subjects[0],
      bob = subjects[1];
    const first = owned[0],
      threadId = first.run.threadId;
    assert.ok(threadId);
    const sessionId = db
      .prepare(
        "SELECT qwen_session_id FROM control_plane_threads WHERE thread_id=?",
      )
      .get(threadId).qwen_session_id;
    assert.ok(sessionId);
    const history = await userCommand(alice.user.login, [
      "threads",
      "events",
      threadId,
      "--limit",
      "100",
      "--json",
    ]);
    await userCommand(
      alice.user.login,
      ["threads", "send", threadId, "--message-stdin", "--json"],
      "BB_AUTOMATION_CONTINUE",
    );
    await wait(async () => {
      const page = await userCommand(alice.user.login, [
        "threads",
        "events",
        threadId,
        "--after",
        String(history.cursor),
        "--json",
      ]);
      return page.events.some(
        (event) =>
          event.type === "turn/completed" && event.data.status === "completed",
      );
    }, "completed automation conversation resumes after runtime release");
    assert.equal(
      db
        .prepare(
          "SELECT qwen_session_id FROM control_plane_threads WHERE thread_id=?",
        )
        .get(threadId).qwen_session_id,
      sessionId,
    );
    const continued = await userCommand(alice.user.login, [
      "threads",
      "result",
      threadId,
      "--json",
    ]);
    assert.match(continued.text, /Personal automation-agent-alice completed/u);
    assert.equal(
      db
        .prepare(
          "SELECT b.enabled FROM control_plane_threads t JOIN control_plane_job_bindings b ON b.id=t.job_binding_id WHERE t.thread_id=?",
        )
        .get(threadId).enabled,
      1,
    );
    await userCommand(alice.user.login, [
      "threads",
      "stop",
      threadId,
      "--json",
    ]);

    assert.equal(alice.user.login, "alice");
    assert.equal(bob.user.login, "bob");
    await assert.rejects(
      () =>
        rpc("automations_create", {
          ...payload(alice, "forged"),
          createdByThreadId: bob.thread.id,
        }),
      /mismatch|authorized/u,
    );
    await assert.rejects(
      () =>
        rpc("automations_create", {
          ...payload(alice, "script"),
          execution: {
            mode: "script",
            script: "touch /tmp/must-not-execute",
            workingDirectory: { type: "project" },
            timeoutMs: 1000,
          },
        }),
      /isolated script launcher/u,
    );
    const scheduled = await Promise.all(
      subjects.map((subject) =>
        rpc(
          "automations_create",
          payload(
            subject,
            `automation-scheduled-${subject.user.login}`,
            Date.now() + 2000,
          ),
        ),
      ),
    );
    for (let index = 0; index < scheduled.length; index++) {
      const saved = scheduled[index],
        subject = subjects[index];
      await wait(
        () =>
          storage
            .prepare("SELECT status FROM automation_runs WHERE automation_id=?")
            .get(saved.id)?.status === "succeeded",
        "scheduled native automation completes",
      );
      await proof(subject, `automation-scheduled-${subject.user.login}`);
      assert.equal(
        storage
          .prepare(
            "SELECT count(*) AS total FROM automation_runs WHERE automation_id=?",
          )
          .get(saved.id).total,
        1,
      );
    }
    const hanging = await rpc(
      "automations_create",
      payload(alice, "worker-hang-automation-alice"),
    );
    const live = (
      await rpc("automations_run", {
        projectId: hanging.projectId,
        automationId: hanging.id,
      })
    ).run;
    await wait(async () => {
      try {
        await proof(alice, "worker-hang-automation-alice");
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    }, "automation command is running as registered UID");
    const runningProcesses = await commandProcesses();
    assert.ok(runningProcesses.length > 0);
    for (const process of runningProcesses)
      assert.equal(process.uid, alice.user.uid);
    await rpc("automations_pause", {
      projectId: hanging.projectId,
      automationId: hanging.id,
    });
    await wait(
      () =>
        storage
          .prepare("SELECT status FROM automation_runs WHERE id=?")
          .get(live.id)?.status === "failed",
      "paused source terminates active automation",
    );
    await assert.rejects(
      () =>
        rpc("automations_run", {
          projectId: hanging.projectId,
          automationId: hanging.id,
        }),
      /authorized/u,
    );
    await wait(
      async () => (await commandProcesses()).length === 0,
      "paused automation command processes exit",
    );
    assert.equal(
      storage
        .prepare(
          "SELECT count(*) AS total FROM automation_runs WHERE automation_id=?",
        )
        .get(hanging.id).total,
      1,
    );
    let offline;
    return {
      verification: {
        nativeAutomationsUseSavedOwner: true,
        nativeAutomationQwenUidHomeCwd: true,
        nativeAutomationWorkerAndSourceBindings: true,
        nativeAutomationManualIdempotency: true,
        nativeCompletedAutomationRuntimeReleasedWithoutFencingHistory: true,
        nativeAutomationRuntimeReleaseAcknowledgedBeforeResume: true,
        nativeAutomationConversationResumesSameQwenSession: true,
        nativeTwoUserOnceSchedulesSingleFire: true,
        nativeAutomationPauseStopsActiveWorker: true,
        nativeAutomationPauseKillsActualCommandProcesses: true,
        managedScriptAutomationRejectedBeforeServiceSpawn: true,
        automationOriginProjectMismatchDenied: true,
      },
      async beforeRestart() {
        offline = await rpc(
          "automations_create",
          payload(bob, "automation-offline-bob", Date.now() + 5000),
        );
      },
      async afterShutdown() {
        if (offline) {
          while (Date.now() < offline.trigger.runAt) {
            signal.throwIfAborted();
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      },
      async afterRestart() {
        await login();
        await wait(async () => {
          try {
            return (
              (await cli(["plugin", "list", "--json"])).plugins.find(
                (plugin) => plugin.id === "automations",
              )?.status === "running"
            );
          } catch {
            return false;
          }
        }, "automations native plugin recovers");
        for (const item of owned) {
          const saved = await rpc("automations_get", {
            projectId: item.saved.projectId,
            automationId: item.saved.id,
          });
          assert.equal(saved.id, item.saved.id);
          assert.equal(
            storage
              .prepare(
                "SELECT owner_user_id FROM automation_authorities WHERE automation_id=?",
              )
              .get(saved.id).owner_user_id,
            item.subject.user.id,
          );
          assert.equal(
            storage
              .prepare("SELECT status FROM automation_runs WHERE id=?")
              .get(item.run.id).status,
            "succeeded",
          );
        }
        assert.ok(offline);
        await wait(
          () =>
            storage
              .prepare(
                "SELECT status FROM automation_runs WHERE automation_id=?",
              )
              .get(offline.id)?.status === "succeeded",
          "offline due schedule starts after restart",
        );
        await proof(bob, "automation-offline-bob");
        assert.equal(
          storage
            .prepare(
              "SELECT count(*) AS total FROM automation_runs WHERE automation_id=?",
            )
            .get(offline.id).total,
          1,
        );
        storage.close();
        return {
          nativeAutomationOwnerAndHistorySurviveRestart: true,
          nativeOfflineScheduleExecutesUnderSavedOwner: true,
          nativeOfflineScheduleSingleFire: true,
        };
      },
    };
  } catch (error) {
    const states = storage
      .prepare(
        "SELECT a.id,a.name,a.enabled,a.next_run_at,a.last_error,r.id AS run_id,r.thread_id,r.status,r.error FROM automations a LEFT JOIN automation_runs r ON r.automation_id=a.id ORDER BY a.created_at DESC LIMIT 12",
      )
      .all();
    const threads = states
      .filter((state) => state.thread_id)
      .map((state) =>
        db
          .prepare("SELECT id,status FROM threads WHERE id=?")
          .get(state.thread_id),
      );
    storage.close();
    throw new Error(
      `Automation diagnostics: ${JSON.stringify({ states, threads })}; ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
