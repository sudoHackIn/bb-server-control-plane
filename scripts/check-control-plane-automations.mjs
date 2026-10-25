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
  userRequest,
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
  async function commandProcesses(marker = "worker-hang-automation-alice") {
    const found = [];
    for (const name of await readdir("/proc")) {
      if (!/^[0-9]+$/u.test(name)) continue;
      try {
        const command = await readFile(`/proc/${name}/cmdline`, "utf8");
        if (!command.includes(`bb-personal-${marker}.json`)) continue;
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
  const command = (subject, ...args) =>
    userCommand(subject.user.login, ["automations", ...args, "--json"]);
  const createPersonal = (subject, marker, prompt = `BB_PERSONAL_${marker}`) =>
    userCommand(
      subject.user.login,
      [
        "automations",
        "create",
        subject.thread.id,
        "--name",
        marker,
        "--at",
        String(Date.now() + 3600000),
        "--prompt-stdin",
        "--json",
      ],
      prompt,
    );
  try {
    for (const subject of subjects) {
      const marker = `automation-agent-${subject.user.login}`;
      const created = await createPersonal(
        subject,
        marker,
        "Draft automation prompt",
      );
      assert.equal(created.revision, 1);
      const saved = await userCommand(
        subject.user.login,
        [
          "automations",
          "update",
          created.id,
          "--revision",
          "1",
          "--name",
          `${marker} revised`,
          "--prompt-stdin",
          "--json",
        ],
        `BB_PERSONAL_${marker}`,
      );
      assert.equal(saved.revision, 2);
      assert.equal(
        (await command(subject, "definition", saved.id)).prompt,
        `BB_PERSONAL_${marker}`,
      );
      assert.equal(
        (
          await userRequest(
            subject.user.login,
            `/control-plane/user/automations/${saved.id}`,
            { method: "PUT", body: { expectedRevision: 1, name: "Stale" } },
          )
        ).status,
        409,
      );
      assert.equal((await command(subject, "pause", saved.id)).enabled, false);
      assert.equal(
        (
          await userRequest(
            subject.user.login,
            `/control-plane/user/automations/${saved.id}/run`,
            { method: "POST", body: {} },
          )
        ).status,
        400,
      );
      assert.equal((await command(subject, "resume", saved.id)).enabled, true);
      assert.deepEqual(
        storage
          .prepare(
            "SELECT execution_json FROM automation_versions WHERE automation_id=? ORDER BY revision",
          )
          .all(saved.id)
          .map((row) => JSON.parse(row.execution_json).prompt),
        ["Draft automation prompt", `BB_PERSONAL_${marker}`],
      );
      const auth = storage
        .prepare("SELECT * FROM automation_authorities WHERE automation_id=?")
        .get(saved.id);
      assert.equal(auth.owner_user_id, subject.user.id);
      const run = await command(
        subject,
        "run",
        saved.id,
        "--idempotency-key",
        "one",
      );
      assert.equal(
        (await command(subject, "run", saved.id, "--idempotency-key", "one"))
          .id,
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
    for (const item of owned) {
      const other = owned.find(
        (entry) => entry.subject.user.id !== item.subject.user.id,
      );
      const base = `/control-plane/user/automations/${other.saved.id}`;
      for (const [path, method, body] of [
        [base, "PUT", { expectedRevision: 2, name: "Forged" }],
        [base, "DELETE", undefined],
        [`${base}/pause`, "POST", undefined],
        [`${base}/resume`, "POST", undefined],
        [`${base}/run`, "POST", {}],
        [`${base}/runs/${other.run.id}/stop`, "POST", undefined],
        [`${base}/definition`, "GET", undefined],
      ])
        assert.equal(
          (await userRequest(item.subject.user.login, path, { method, body }))
            .status,
          404,
        );
      const input = {
        originThreadId: other.subject.thread.id,
        name: "Forged",
        prompt: "Forged",
        trigger: { triggerType: "once", runAt: Date.now() + 3600000 },
      };
      assert.equal(
        (
          await userRequest(
            item.subject.user.login,
            "/control-plane/user/automations",
            { method: "POST", body: input },
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await userRequest(
            item.subject.user.login,
            "/control-plane/user/automations",
            {
              method: "POST",
              body: {
                ...input,
                originThreadId: item.subject.thread.id,
                home: "/root",
              },
            },
          )
        ).status,
        400,
      );
    }
    async function personalReads(items = owned) {
      for (const item of items) {
        const value = await command(item.subject, "get", item.saved.id);
        assert.equal(value.id, item.saved.id);
        assert.equal(value.projectId, item.subject.project.projectId);
        assert.equal(value.createdByThreadId, item.subject.thread.id);
        assert.equal("execution" in value, false);
        const found = new Set();
        const cursors = new Set();
        let cursor = null;
        do {
          const page = await command(
            item.subject,
            "list",
            "--project",
            value.projectId,
            "--limit",
            "1",
            ...(cursor ? ["--cursor", cursor] : []),
          );
          assert.ok(page.automations.length <= 1);
          for (const row of page.automations) {
            assert.equal(row.projectId, value.projectId);
            assert.equal(found.has(row.id), false);
            found.add(row.id);
          }
          cursor = page.nextCursor;
          if (cursor) {
            assert.equal(cursors.has(cursor), false);
            cursors.add(cursor);
            assert.ok(cursors.size < 20);
          }
        } while (cursor);
        assert.ok(found.has(item.saved.id));
        assert.equal(
          found.has(`fixture-definition-${item.subject.user.id}`),
          false,
        );
        const history = await command(
          item.subject,
          "history",
          value.id,
          "--limit",
          "1",
        );
        assert.equal(history.automationId, value.id);
        assert.equal(history.runs[0].id, item.run.id);
        assert.equal("output" in history.runs[0], false);
        assert.equal(history.runs[0].status, "succeeded");
        const other = owned.find(
          (row) => row.subject.user.id !== item.subject.user.id,
        );
        for (const suffix of ["", "/history"]) {
          assert.equal(
            (
              await userRequest(
                item.subject.user.login,
                `/control-plane/user/automations/${other.saved.id}${suffix}`,
              )
            ).status,
            404,
          );
        }
        assert.equal(
          (
            await userRequest(
              item.subject.user.login,
              `/control-plane/user/automations/${value.id}/script`,
              { method: "POST" },
            )
          ).status,
          401,
        );
        assert.equal(
          (
            await userRequest(
              item.subject.user.login,
              "/control-plane/user/automations?ownerUserId=forged",
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await userRequest(
              item.subject.user.login,
              `/control-plane/user/automations/${value.id}`,
            )
          ).headers["cache-control"],
          "no-store",
        );
      }
    }
    await personalReads();
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
    await personalReads();
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
    const cancellable = await Promise.all(
      subjects.map(async (subject) => {
        const marker = `worker-hang-automation-api-${subject.user.login}`;
        const definition = await createPersonal(subject, marker);
        const run = await command(subject, "run", definition.id);
        await wait(async () => {
          try {
            await proof(subject, marker);
            return (await commandProcesses(marker)).length > 0;
          } catch (error) {
            if (error.code === "ENOENT" || error instanceof SyntaxError)
              return false;
            throw error;
          }
        }, "personal automation command and identity marker are ready before cancellation");
        for (const process of await commandProcesses(marker))
          assert.equal(process.uid, subject.user.uid);
        return { subject, marker, definition, run };
      }),
    );
    for (let index = 0; index < cancellable.length; index++) {
      const item = cancellable[index];
      assert.equal(
        (await command(item.subject, "stop", item.definition.id, item.run.id))
          .stopped,
        true,
      );
      await wait(
        async () => (await commandProcesses(item.marker)).length === 0,
        "personal run cancellation terminates command PIDs",
      );
      assert.equal(
        (await command(item.subject, "history", item.definition.id)).runs[0]
          .status,
        "cancelled",
      );
      assert.equal(
        (await command(item.subject, "get", item.definition.id)).enabled,
        true,
      );
      const state = storage
        .prepare(
          "SELECT enabled,next_run_at,consecutive_failures FROM automations WHERE id=?",
        )
        .get(item.definition.id);
      assert.equal(state.enabled, 1);
      assert.equal(state.next_run_at, item.definition.trigger.runAt);
      assert.equal(state.consecutive_failures, 0);
      assert.ok(
        storage
          .prepare(
            "SELECT cancel_requested_at FROM automation_run_authorities WHERE run_id=?",
          )
          .get(item.run.id).cancel_requested_at,
      );
      assert.equal(
        (await command(item.subject, "stop", item.definition.id, item.run.id))
          .stopped,
        false,
      );
      if (index === 0)
        assert.ok(
          (await commandProcesses(cancellable[1].marker)).length > 0,
          "another owner's command survives individual cancellation",
        );
    }
    const deletedMarker = "worker-hang-automation-delete-alice";
    const deleted = await createPersonal(alice, deletedMarker);
    await command(alice, "run", deleted.id);
    await wait(
      async () => (await commandProcesses(deletedMarker)).length > 0,
      "owned command starts before source deletion",
    );
    assert.equal((await command(alice, "delete", deleted.id)).deleted, true);
    await wait(
      async () => (await commandProcesses(deletedMarker)).length === 0,
      "source deletion fences and reaps actual commands",
    );
    assert.equal(
      (
        await userRequest(
          alice.user.login,
          `/control-plane/user/automations/${deleted.id}`,
        )
      ).status,
      404,
    );
    const beforeOversized = storage
      .prepare("SELECT count(*) AS count FROM automations")
      .get().count;
    assert.equal(
      (
        await userRequest(alice.user.login, "/control-plane/user/automations", {
          method: "POST",
          body: { prompt: "x".repeat(1024 * 1024) },
        })
      ).status,
      413,
    );
    assert.equal(
      storage.prepare("SELECT count(*) AS count FROM automations").get().count,
      beforeOversized,
    );
    const boundedRunner = launch([
      "script-runner-check.mjs",
      JSON.stringify(
        subjects.map((subject) => ({
          userId: subject.user.id,
          projectId: subject.project.projectId,
          originThreadId: subject.thread.id,
        })),
      ),
    ]);
    let boundedOutput = "",
      boundedError = "";
    boundedRunner.stdout.on("data", (chunk) => {
      boundedOutput += chunk;
    });
    boundedRunner.stderr.on("data", (chunk) => {
      boundedError += chunk;
    });
    boundedRunner.stdin.end();
    assert.equal(
      (await once(boundedRunner, "exit", { signal }))[0],
      0,
      boundedError || boundedOutput,
    );
    const { markers, ...boundedProof } = JSON.parse(boundedOutput);
    for (const pid of await readdir("/proc")) {
      if (!/^[0-9]+$/.test(pid)) continue;
      let commandLine;
      try {
        commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8");
      } catch {
        continue;
      }
      assert.ok(
        !markers.some((marker) => commandLine.includes(marker)),
        `Script descendant survived cleanup: ${pid}`,
      );
    }
    let offline;
    return {
      verification: {
        ...boundedProof,
        boundedScriptRunnerDetachedDescendantsReaped: true,
        personalAutomationCrudAndRevisionCas: true,
        personalAutomationOriginProfileDerivedByServer: true,
        personalAutomationImmutablePromptVersions: true,
        personalAutomationForeignMutationsDenied: true,
        personalAutomationPausedRunDeniedBeforeClaim: true,
        personalAutomationIndividualCancelReapsActualCommands: true,
        personalAutomationCancelPreservesOtherOwnerAndSourceSchedule: true,
        personalAutomationCancelledHistoryWithoutFailureBudget: true,
        personalAutomationDeleteFencesAndReapsCommands: true,
        personalAutomationActualHttpBodyBudget: true,
        personalAutomationReadApiAndCli: true,
        personalAutomationOwnerFilteredPagination: true,
        personalAutomationPendingRootDoesNotBreakPagination: true,
        personalAutomationForeignReadsDenied: true,
        personalAutomationUnknownMutationAndOwnerInjectionDenied: true,
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
        await personalReads(
          owned.filter((item) => item.subject.user.id === alice.user.id),
        );
        for (const suffix of ["", "/history"]) {
          const item = owned.find(
            (entry) => entry.subject.user.id === bob.user.id,
          );
          assert.equal(
            (
              await userRequest(
                bob.user.login,
                `/control-plane/user/automations/${item.saved.id}${suffix}`,
              )
            ).status,
            401,
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
          personalAutomationActiveOwnerReadsAfterRestart: true,
          personalAutomationLoggedOutOwnerDeniedAfterRestart: true,
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
