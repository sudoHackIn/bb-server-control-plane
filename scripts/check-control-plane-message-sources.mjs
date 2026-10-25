import assert from "node:assert/strict";

export function createMessageSourceFixture({ db, users }) {
  const calls = new Map();
  let saved;
  return {
    handle(body, response) {
      if (
        !body.tools?.some((tool) => tool.function?.name === "run_shell_command")
      )
        return false;
      const markers = [
        ...JSON.stringify(body.messages).matchAll(
          /BB_MESSAGE_SOURCE_[A-Z_]+/gu,
        ),
      ];
      const marker = markers.at(-1)?.[0];
      if (!marker) return false;
      calls.set(marker, (calls.get(marker) ?? 0) + 1);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: marker, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: `Source fixture ${marker}` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
      return true;
    },
    async verify({ send, wait, token, created }) {
      const sources = [];
      for (const [index, user] of users.entries()) {
        const profile = await send(
          "/control-plane/admin/profiles",
          {
            slug: `message-source-${user.login}`,
            name: `Message source ${user.login}`,
            definition: {
              prompt: "Message source fixture",
              providerId: "qwen-server",
              model: "qwen-job-test",
              reasoningLevel: "none",
              permissionMode: "full",
              tools: ["run_shell_command", "bb:approved_server_probe"],
              mcpServers: ["bb"],
            },
          },
          token,
        );
        assert.equal(profile.status, 201, JSON.stringify(profile.body));
        const access = `/control-plane/admin/profiles/${profile.body.profile.id}/access/${user.id}`;
        assert.equal(
          (await send(access, { allowed: true }, token, "PUT")).status,
          200,
        );
        const started = await send(
          "/api/v1/threads",
          {
            ...created[index].threadInput,
            controlPlaneProfileVersionId: profile.body.version.id,
            input: [
              {
                type: "text",
                text: `BB_MESSAGE_SOURCE_${user.login.toUpperCase()}_START`,
                mentions: [],
              },
            ],
          },
          token,
        );
        assert.equal(started.status, 201, JSON.stringify(started.body));
        await wait(
          () =>
            db
              .prepare("SELECT status FROM threads WHERE id=?")
              .get(started.body.id)?.status === "idle",
          `message source ${user.login} ready`,
        );
        const stopped = await send(
          `/api/v1/threads/${started.body.id}/stop`,
          {},
          token,
        );
        assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
        sources.push({ threadId: started.body.id, access });
      }
      const targetResponse = await send(
        "/api/v1/threads",
        {
          ...created[0].threadInput,
          input: [
            {
              type: "text",
              text: "BB_MESSAGE_SOURCE_TARGET_START",
              mentions: [],
            },
          ],
        },
        token,
      );
      assert.equal(
        targetResponse.status,
        201,
        JSON.stringify(targetResponse.body),
      );
      const target = targetResponse.body.id;
      await wait(
        () =>
          db.prepare("SELECT status FROM threads WHERE id=?").get(target)
            ?.status === "idle",
        "queue target ready",
      );
      const path = `/api/v1/threads/${target}`;
      const count = () =>
        db
          .prepare(
            "SELECT count(*) AS n FROM events WHERE thread_id=? AND type='client/turn/requested'",
          )
          .get(target).n;
      const before = count();
      const foreign = await send(
        `${path}/queued-messages`,
        {
          input: [
            { type: "text", text: "BB_MESSAGE_SOURCE_FOREIGN", mentions: [] },
          ],
          senderThreadId: sources[1].threadId,
        },
        token,
      );
      assert.equal(foreign.status, 403, JSON.stringify(foreign.body));
      assert.equal(foreign.body.code, "message_source_not_authorized");
      const queued = await send(
        `${path}/send`,
        {
          input: [
            { type: "text", text: "BB_MESSAGE_SOURCE_RESTART", mentions: [] },
          ],
          senderThreadId: sources[0].threadId,
          mode: "queue-if-active",
          sendAt: Date.now() + 3600000,
        },
        token,
      );
      assert.equal(queued.status, 200, JSON.stringify(queued.body));
      assert.equal(queued.body.delivery, "queued");
      const rowId = queued.body.queuedMessage.id;
      const stoppedTarget = await send(`${path}/stop`, {}, token);
      assert.equal(
        stoppedTarget.status,
        200,
        JSON.stringify(stoppedTarget.body),
      );
      const row = db
        .prepare("SELECT * FROM queued_thread_messages WHERE id=?")
        .get(rowId);
      assert.equal(row.sender_thread_id, sources[0].threadId);
      assert.equal(
        (await send(sources[0].access, { allowed: false }, token, "PUT"))
          .status,
        200,
      );
      const deliver = () =>
        send(`${path}/queued-messages/${rowId}/send`, { mode: "auto" }, token);
      const denied = await deliver();
      assert.equal(denied.status, 403, JSON.stringify(denied.body));
      assert.equal(denied.body.code, "message_source_not_authorized");
      assert.equal(count(), before);
      const retained = db
        .prepare("SELECT * FROM queued_thread_messages WHERE id=?")
        .get(rowId);
      assert.equal(retained.content, row.content);
      assert.equal(retained.claim_token, null);
      assert.equal(retained.failure_count, row.failure_count);
      assert.equal(calls.has("BB_MESSAGE_SOURCE_FOREIGN"), false);
      assert.equal(calls.has("BB_MESSAGE_SOURCE_RESTART"), false);
      saved = {
        send,
        wait,
        path,
        rowId,
        row,
        source: sources[0],
        target,
        before,
      };
      return {
        managedQueueForeignSenderDenied: true,
        managedQueueSourceGrantRecheckedBeforeConsumption: true,
      };
    },
    async afterRestart(token) {
      assert.ok(saved);
      const { send, wait, path, rowId, row, source, target, before } = saved;
      const count = () =>
        db
          .prepare(
            "SELECT count(*) AS n FROM events WHERE thread_id=? AND type='client/turn/requested'",
          )
          .get(target).n;
      const denied = await send(
        `${path}/queued-messages/${rowId}/send`,
        { mode: "auto" },
        token,
      );
      assert.equal(denied.status, 403, JSON.stringify(denied.body));
      assert.equal(denied.body.code, "message_source_not_authorized");
      const retained = db
        .prepare("SELECT * FROM queued_thread_messages WHERE id=?")
        .get(rowId);
      assert.equal(retained.sender_thread_id, source.threadId);
      assert.equal(retained.content, row.content);
      assert.equal(retained.claim_token, null);
      assert.equal(count(), before);
      assert.equal(calls.has("BB_MESSAGE_SOURCE_RESTART"), false);
      assert.equal(
        (await send(source.access, { allowed: true }, token, "PUT")).status,
        200,
      );
      const delivered = await send(
        `${path}/queued-messages/${rowId}/send`,
        { mode: "auto" },
        token,
      );
      assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
      assert.equal(delivered.body.delivery, "sent");
      await wait(
        () =>
          calls.get("BB_MESSAGE_SOURCE_RESTART") === 1 &&
          db.prepare("SELECT status FROM threads WHERE id=?").get(target)
            ?.status === "idle",
        "authorized source message after restart",
      );
      assert.equal(
        db
          .prepare("SELECT id FROM queued_thread_messages WHERE id=?")
          .get(rowId),
        undefined,
      );
      assert.equal(count(), before + 1);
      assert.equal((await send(`${path}/stop`, {}, token)).status, 200);
      return {
        managedQueueSourceSurvivesRestart: true,
        managedQueueRegrantDeliversSavedInputOnce: true,
      };
    },
  };
}
