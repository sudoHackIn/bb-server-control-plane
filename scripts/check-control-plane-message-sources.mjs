import { promisify } from "node:util";
import { execFile } from "node:child_process";
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
      if (marker === "BB_MESSAGE_SOURCE_LEGACY_FRESH")
        assert.equal(
          JSON.stringify(body.messages).includes(
            "BB_MESSAGE_SOURCE_LEGACY_UNKNOWN",
          ),
          false,
        );
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
      const prepared = await promisify(execFile)(process.execPath, [
        "inherited-source-check.mjs",
        JSON.stringify({
          sourceThreadId: sources[0].threadId,
          profileVersionId: created[0].profileVersionId,
        }),
      ]);
      const { threadId: deferredThreadId } = JSON.parse(prepared.stdout);
      assert.equal(
        db
          .prepare("SELECT status FROM threads WHERE id=?")
          .get(deferredThreadId)?.status,
        "error",
      );
      assert.equal(calls.has("BB_MESSAGE_SOURCE_DEFERRED_SEED"), false);
      const seed = db
        .prepare(
          "SELECT request_id FROM control_plane_turn_sources WHERE thread_id=?",
        )
        .get(deferredThreadId);
      assert.ok(seed);
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
      const deferredPath = `/api/v1/threads/${deferredThreadId}/send`;
      const deferredInput = {
        input: [
          {
            type: "text",
            text: "BB_MESSAGE_SOURCE_DEFERRED_TURN",
            mentions: [],
          },
        ],
        mode: "start",
      };
      const deferredDenied = await send(deferredPath, deferredInput, token);
      assert.equal(
        deferredDenied.status,
        403,
        JSON.stringify(deferredDenied.body),
      );
      assert.equal(deferredDenied.body.code, "message_source_not_authorized");
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS n FROM control_plane_turn_sources WHERE thread_id=?",
          )
          .get(deferredThreadId).n,
        1,
      );
      assert.equal(
        (await send(sources[0].access, { allowed: true }, token, "PUT")).status,
        200,
      );
      const deferredSent = await send(deferredPath, deferredInput, token);
      assert.equal(deferredSent.status, 200, JSON.stringify(deferredSent.body));
      await wait(
        () =>
          calls.has("BB_MESSAGE_SOURCE_DEFERRED_TURN") &&
          db
            .prepare("SELECT status FROM threads WHERE id=?")
            .get(deferredThreadId)?.status === "idle",
        "derived source native Qwen turn",
      );
      const inherited = db
        .prepare(
          "SELECT request_id,source_request_id FROM control_plane_turn_sources WHERE thread_id=? AND source_request_id IS NOT NULL",
        )
        .all(deferredThreadId);
      assert.equal(inherited.length, 1);
      assert.equal(inherited[0].source_request_id, seed.request_id);
      assert.equal(
        (await send(`/api/v1/threads/${deferredThreadId}/stop`, {}, token))
          .status,
        200,
      );
      assert.equal(
        (await send(sources[0].access, { allowed: false }, token, "PUT"))
          .status,
        200,
      );
      const legacyPrepared = await promisify(execFile)(process.execPath, [
        "inherited-source-check.mjs",
        JSON.stringify({
          sourceThreadId: sources[0].threadId,
          profileVersionId: created[0].profileVersionId,
          mode: "legacy",
        }),
      ]);
      const legacyId = JSON.parse(legacyPrepared.stdout).threadId;
      const legacyDenied = await send(
        `/api/v1/threads/${legacyId}/retry`,
        {},
        token,
      );
      assert.equal(legacyDenied.status, 403, JSON.stringify(legacyDenied.body));
      assert.equal(legacyDenied.body.code, "message_source_not_authorized");
      assert.equal(calls.has("BB_MESSAGE_SOURCE_LEGACY_UNKNOWN"), false);
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS n FROM control_plane_turn_sources WHERE thread_id=?",
          )
          .get(legacyId).n,
        0,
      );
      const freshLegacy = await send(
        `/api/v1/threads/${legacyId}/send`,
        {
          input: [
            {
              type: "text",
              text: "BB_MESSAGE_SOURCE_LEGACY_FRESH",
              mentions: [],
            },
          ],
          mode: "start",
        },
        token,
      );
      assert.equal(freshLegacy.status, 200, JSON.stringify(freshLegacy.body));
      await wait(
        () =>
          calls.has("BB_MESSAGE_SOURCE_LEGACY_FRESH") &&
          db.prepare("SELECT status FROM threads WHERE id=?").get(legacyId)
            ?.status === "idle",
        "fresh owner input after legacy retry denial",
      );
      assert.equal(
        (await send(`/api/v1/threads/${legacyId}/stop`, {}, token)).status,
        200,
      );
      saved = {
        send,
        wait,
        path,
        rowId,
        row,
        source: sources[0],
        target,
        before,
        inherited: { threadId: deferredThreadId, ...inherited[0] },
      };
      return {
        managedUnmarkedLegacyRetryDenied: true,
        managedFreshInputAfterLegacyDenialRunsNativeQwen: true,
        managedDeferredSourceRevocationDenied: true,
        managedDeferredSourceNativeTurnPreservesRequestReference: true,
        managedQueueForeignSenderDenied: true,
        managedQueueSourceGrantRecheckedBeforeConsumption: true,
      };
    },
    async afterRestart(token) {
      assert.ok(saved);
      assert.equal(
        db
          .prepare(
            "SELECT source_request_id FROM control_plane_turn_sources WHERE thread_id=? AND request_id=?",
          )
          .get(saved.inherited.threadId, saved.inherited.request_id)
          ?.source_request_id,
        saved.inherited.source_request_id,
      );
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
        managedInheritedRequestReferenceSurvivesRestart: true,
        managedQueueSourceSurvivesRestart: true,
        managedQueueRegrantDeliversSavedInputOnce: true,
      };
    },
  };
}
