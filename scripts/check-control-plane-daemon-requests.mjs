import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

export function createDaemonRequestFixture({ db }) {
  const pending = new Map();
  let saved;
  function finish(marker) {
    const response = pending.get(marker);
    assert.ok(response, "Missing held provider response");
    pending.delete(marker);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: marker, object: "chat.completion.chunk", created: 1, model: "qwen-job-test", choices: [{ index: 0, delta: { role: "assistant", content: "Daemon admission probe completed" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  }
  return {
    handle(body, response) {
      const marker = JSON.stringify(body.messages).match(
        /BB_DAEMON_ADMISSION_(alice|bob)/u,
      )?.[0];
      if (
        !marker ||
        !body.tools?.some(
          (tool) => tool.function?.name === "mcp__bb__approved_server_probe",
        )
      )
        return false;
      assert.equal(
        pending.has(marker),
        false,
        "Duplicate held provider request",
      );
      pending.set(marker, response);
      return true;
    },
    async verify({ send, wait, token, created }) {
      const auth = JSON.parse(await readFile("/srv/bb/auth.json", "utf8"));
      assert.equal(typeof auth.hostKey, "string");
      const session = db
        .prepare(
          "SELECT * FROM host_daemon_sessions WHERE host_id=? AND status='active' AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1",
        )
        .get(auth.hostId);
      assert.ok(session);
      const subjects = [];
      const approvalPayload = {
        kind: "approval",
        subject: {
          kind: "command",
          itemId: "daemon-admission",
          command: "git push",
          cwd: "/",
          actions: [],
          sessionGrant: null,
        },
        reason: "Admission fixture",
        availableDecisions: ["allow_once", "deny"],
      };
      const pendingCount = () =>
        db.prepare("SELECT count(*) AS n FROM pending_interactions").get().n;
      const internal = (path, body) => send(path, body, auth.hostKey);
      try {
        for (const [index, login] of ["alice", "bob"].entries()) {
          const marker = `BB_DAEMON_ADMISSION_${login}`;
          const started = await send(
            "/api/v1/threads",
            {
              ...created[index].threadInput,
              input: [{ type: "text", text: marker, mentions: [] }],
            },
            token,
          );
          assert.equal(started.status, 201, JSON.stringify(started.body));
          const threadId = started.body.id;
          await wait(
            () =>
              pending.has(marker) &&
              db.prepare("SELECT status FROM threads WHERE id=?").get(threadId)
                ?.status === "active" &&
              db
                .prepare(
                  "SELECT turn_id FROM events WHERE thread_id=? AND type='turn/started' AND turn_id IS NOT NULL ORDER BY sequence DESC LIMIT 1",
                )
                .get(threadId),
            `active daemon admission ${login}`,
          );
          const owner = db
            .prepare("SELECT * FROM control_plane_threads WHERE thread_id=?")
            .get(threadId);
          assert.ok(owner.qwen_session_id);
          const turn = db
            .prepare(
              "SELECT turn_id FROM events WHERE thread_id=? AND type='turn/started' AND turn_id IS NOT NULL ORDER BY sequence DESC LIMIT 1",
            )
            .get(threadId);
          subjects.push({
            marker,
            threadId,
            providerThreadId: owner.qwen_session_id,
            turnId: turn.turn_id,
            projectId: created[index].threadInput.projectId,
            profileId: created[index].profileId,
            userId: owner.owner_user_id,
          });
        }
        const [alice, bob] = subjects;
        assert.notEqual(alice.providerThreadId, bob.providerThreadId);
        assert.notEqual(alice.userId, bob.userId);
        const toolBody = (subject, override = {}) => ({
          sessionId: session.id,
          threadId: subject.threadId,
          providerThreadId: subject.providerThreadId,
          turnId: subject.turnId,
          callId: randomUUID(),
          tool: "approved_server_probe",
          arguments: {
            userId: "forged",
            threadId: "forged",
            projectId: "forged",
          },
          ...override,
        });
        const interactionBody = (subject, override = {}) => ({
          sessionId: session.id,
          interaction: {
            threadId: subject.threadId,
            providerId: "qwen-server",
            providerThreadId: subject.providerThreadId,
            turnId: subject.turnId,
            providerRequestId: randomUUID(),
            payload: approvalPayload,
            ...override,
          },
        });
        const count = pendingCount();
        for (const override of [
          { providerThreadId: bob.providerThreadId },
          { turnId: "old-turn" },
          { threadId: bob.threadId },
        ]) {
          const result = await internal(
            "/internal/session/tool-call",
            toolBody(alice, override),
          );
          assert.equal(result.status, 403, JSON.stringify(result.body));
          const registered = await internal(
            "/internal/session/interactive-request",
            interactionBody(alice, override),
          );
          assert.equal(registered.status, 403, JSON.stringify(registered.body));
        }
        assert.equal(pendingCount(), count);
        for (const subject of subjects) {
          const result = await internal(
            "/internal/session/tool-call",
            toolBody(subject),
          );
          assert.equal(result.status, 200, JSON.stringify(result.body));
          assert.equal(result.body.success, true);
          const text = result.body.contentItems.find(
            (item) => item.type === "inputText",
          )?.text;
          const actual = JSON.parse(text);
          assert.equal(actual.threadId, subject.threadId);
          assert.equal(actual.projectId, subject.projectId);
          assert.equal(actual.unscopedSdkDenied, true);
        }
        const registered = await internal(
          "/internal/session/interactive-request",
          interactionBody(alice),
        );
        assert.equal(registered.status, 200, JSON.stringify(registered.body));
        assert.equal(registered.body.outcome, "created");
        const id = registered.body.interactionId;
        assert.equal(
          (
            await send(
              `/control-plane/admin/profiles/${alice.profileId}/access/${alice.userId}`,
              { allowed: false },
              token,
              "PUT",
            )
          ).status,
          200,
        );
        try {
          for (const [path, body] of [
            ["/internal/session/tool-call", toolBody(alice)],
            ["/internal/session/interactive-request", interactionBody(alice)],
          ]) {
            const denied = await internal(path, body);
            assert.equal(denied.status, 403, JSON.stringify(denied.body));
          }
          const denied = await send(
            `/api/v1/threads/${alice.threadId}/interactions/${id}/resolve`,
            { decision: "allow_once", grantedPermissions: null },
            token,
          );
          assert.equal(denied.status, 403, JSON.stringify(denied.body));
          assert.equal(
            db
              .prepare("SELECT status FROM pending_interactions WHERE id=?")
              .get(id).status,
            "pending",
          );
          assert.equal(
            (await internal("/internal/session/tool-call", toolBody(bob)))
              .status,
            200,
          );
          const cleanup = await internal(
            "/internal/session/interactive-request/interrupt",
            {
              sessionId: session.id,
              providerId: "qwen-server",
              threadIds: [alice.threadId],
              reason: "thread-stopped",
            },
          );
          assert.equal(cleanup.status, 200, JSON.stringify(cleanup.body));
          assert.equal(
            db
              .prepare("SELECT status FROM pending_interactions WHERE id=?")
              .get(id).status,
            "interrupted",
          );
        } finally {
          assert.equal(
            (
              await send(
                `/control-plane/admin/profiles/${alice.profileId}/access/${alice.userId}`,
                { allowed: true },
                token,
                "PUT",
              )
            ).status,
            200,
          );
        }
        assert.ok(
          [401, 403].includes(
            (await internal("/api/v1/projects", undefined)).status,
          ),
        );
        saved = {
          send,
          tool: toolBody(alice),
          approval: interactionBody(alice),
          internal,
        };
      } finally {
        for (const subject of subjects)
          if (pending.has(subject.marker)) finish(subject.marker);
      }
      await wait(
        () =>
          subjects.every(
            (subject) =>
              db
                .prepare("SELECT status FROM threads WHERE id=?")
                .get(subject.threadId)?.status === "idle",
          ),
        "daemon admission threads complete",
      );
      for (const [path, body] of [
        ["/internal/session/tool-call", saved.tool],
        ["/internal/session/interactive-request", saved.approval],
      ]) {
        const stale = await internal(path, body);
        assert.equal(stale.status, 403, JSON.stringify(stale.body));
      }
      return {
        managedDaemonCurrentTurnAndNativeSessionAdmission: true,
        managedDaemonTwoOwnersUseSavedToolPrincipal: true,
        managedDaemonRevocationAndSafeInterrupt: true,
        managedDaemonCompletedTurnRequestsDenied: true,
        machineCredentialNotFullPublicApi: true,
      };
    },
    async duringShutdown() {
      const auth = JSON.parse(await readFile("/srv/bb/auth.json", "utf8"));
      const session = db
        .prepare(
          "SELECT id FROM host_daemon_sessions WHERE host_id=? AND status='active' AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1",
        )
        .get(auth.hostId);
      assert.ok(session);
      for (const [path, body] of [
        ["/internal/session/tool-call", saved.tool],
        ["/internal/session/interactive-request", saved.approval],
      ]) {
        const denied = await saved.send(
          path,
          { ...body, sessionId: session.id },
          auth.hostKey,
        );
        assert.equal(denied.status, 503, JSON.stringify(denied.body));
        assert.equal(denied.body.code, "server_stopping");
      }
    },
  };
}
