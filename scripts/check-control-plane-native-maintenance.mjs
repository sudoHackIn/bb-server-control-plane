import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
const exec = promisify(execFile);
export function createNativeMaintenanceFixture({ db, users }) {
  let restartOperation;
  const service = async (input) =>
    JSON.parse(
      (
        await exec(
          "/usr/bin/setpriv",
          [
            "--reuid=1000",
            "--regid=1000",
            "--clear-groups",
            process.execPath,
            "apps/server/dist/project-access-check.mjs",
            JSON.stringify(input),
          ],
          { cwd: "/opt/bb", timeout: 35000, maxBuffer: 65536 },
        )
      ).stdout,
    );
  const status = (id) =>
    db
      .prepare("SELECT * FROM control_plane_project_maintenance WHERE id=?")
      .get(id);
  function handle(body, res) {
    const text = JSON.stringify(body.messages);
    const live = text.match(/BB_ACCESS_MAINTENANCE_LIVE_(ACTIVE|PAUSED)/u)?.[1];
    if (!live) return false;
    const continued = text.includes("BB_ACCESS_MAINTENANCE_CONTINUE_");
    const code = `const fs=require("node:fs");fs.writeFileSync(process.env.HOME+"/bb-maintenance-${live.toLowerCase()}-ready","ready");setInterval(()=>{},1000)`;
    const delta = continued
      ? { role: "assistant", content: "Maintenance continuation complete" }
      : {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "maint_" + live,
              type: "function",
              function: {
                name: "run_shell_command",
                arguments: JSON.stringify({
                  command: `/usr/local/bin/node -e '${code}'`,
                  description:
                    "Hold a real native process for access maintenance",
                  timeout: 60000,
                }),
              },
            },
          ],
        };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: "maintenance", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: continued ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
    );
    return true;
  }
  return {
    handle,
    async verify({ send, token, created, wait }) {
      const ids = [];
      for (const kind of ["ACTIVE", "PAUSED"]) {
        const result = await send(
          "/api/v1/threads",
          {
            ...created[0].threadInput,
            input: [
              {
                type: "text",
                text: "BB_ACCESS_MAINTENANCE_LIVE_" + kind,
                mentions: [],
              },
            ],
          },
          token,
        );
        assert.equal(result.status, 201, JSON.stringify(result.body));
        ids.push(result.body.id);
        await wait(
          async () =>
            (await readFile(
              users[0].home +
                "/bb-maintenance-" +
                kind.toLowerCase() +
                "-ready",
              "utf8",
            )) === "ready",
          "live maintenance process ready",
        );
      }
      const sessions = ids.map(
        (id) =>
          db
            .prepare(
              "SELECT qwen_session_id FROM control_plane_threads WHERE thread_id=?",
            )
            .get(id).qwen_session_id,
      );
      assert.ok(sessions.every(Boolean));
      const paused = await send(`/api/v1/threads/${ids[1]}/stop`, {}, token);
      assert.equal(paused.status, 200);
      const operationId = randomUUID();
      const reserved = await service({
        mode: "native-group",
        threadIds: ids,
        operationId,
        queue: true,
      });
      assert.equal(reserved.group.phase, "preparing");
      await wait(
        () => status(operationId)?.phase === "complete",
        "native maintenance group completion",
      );
      const row = (id) =>
        db.prepare("SELECT * FROM queued_thread_messages WHERE id=?").get(id);
      const count = (id) =>
        db
          .prepare(
            "SELECT count(*) AS n FROM events WHERE thread_id=? AND type='client/turn/requested'",
          )
          .get(id).n;
      await wait(
        () =>
          !row(reserved.queueIds[0]) &&
          db.prepare("SELECT status FROM threads WHERE id=?").get(ids[0])
            .status === "idle",
        "automatic queue continuation after maintenance",
      );
      assert.equal(count(ids[0]), 2);
      assert.equal(count(ids[1]), 1);
      assert.equal(row(reserved.queueIds[1]).failure_count, 0);
      assert.equal(row(reserved.queueIds[1]).claim_token, null);
      const reasons = (id) =>
        db
          .prepare(
            "SELECT data FROM events WHERE thread_id=? AND type='system/thread/interrupted' ORDER BY sequence",
          )
          .all(id)
          .map((event) => JSON.parse(event.data).reason);
      assert.ok(reasons(ids[0]).includes("access-maintenance"));
      assert.ok(!reasons(ids[0]).includes("manual-stop"));
      assert.ok(reasons(ids[1]).includes("manual-stop"));
      const resumed = await send(
        `/api/v1/threads/${ids[1]}/queued-messages/${reserved.queueIds[1]}/send`,
        { mode: "auto" },
        token,
      );
      assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
      await wait(
        () =>
          !row(reserved.queueIds[1]) &&
          db.prepare("SELECT status FROM threads WHERE id=?").get(ids[1])
            .status === "idle",
        "explicit continuation of user-paused queue",
      );
      assert.equal(count(ids[1]), 2);
      for (let index = 0; index < ids.length; index++) {
        assert.equal(
          db
            .prepare(
              "SELECT qwen_session_id FROM control_plane_threads WHERE thread_id=?",
            )
            .get(ids[index]).qwen_session_id,
          sessions[index],
        );
        const released = await send(
          `/api/v1/threads/${ids[index]}/stop`,
          {},
          token,
        );
        assert.equal(released.status, 200);
      }
      assert.ok(status(operationId).participants);
      return {
        nativeMaintenanceSweepDrainsLiveQwenAndReleasesRootJobs: true,
        nativeMaintenanceAutoQueueContinuesOnceWithoutManualPause: true,
        nativeMaintenancePriorUserPauseRemainsUntilExplicitSend: true,
        nativeMaintenanceBothLogicalQwenSessionsPreserved: true,
      };
    },
    async beforeRestart({ serverPid, threadId }) {
      restartOperation = randomUUID();
      const saved = await service({
        mode: "native-group",
        threadIds: [threadId],
        operationId: restartOperation,
        queue: false,
        workerPid: serverPid,
      });
      assert.equal(saved.group.phase, "preparing");
      assert.equal(saved.group.workerPid, serverPid);
    },
    async afterRestart({ wait }) {
      assert.ok(restartOperation);
      await wait(
        () =>
          status(restartOperation)?.phase === "complete" &&
          status(restartOperation)?.worker_id === null,
        "saved native maintenance startup recovery",
      );
      const completed = status(restartOperation);
      assert.equal(completed.attempt, 1);
      assert.equal(completed.worker_id, null);
      const participants = JSON.parse(completed.participants);
      assert.ok(participants.length > 0);
      for (const participant of participants) {
        const intent = db
          .prepare(
            "SELECT phase,generation FROM control_plane_uid_maintenance WHERE user_id=?",
          )
          .get(participant.userId);
        assert.equal(intent.phase, "idle");
        assert.equal(intent.generation, participant.generation);
      }
      return {
        nativeMaintenanceSavedIntentRecoveredOnServerStartup: true,
        nativeMaintenanceStartupKeepsParticipantGenerations: true,
      };
    },
  };
}
