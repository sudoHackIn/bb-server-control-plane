import assert from "node:assert/strict";
import { readFile, writeFile, chown } from "node:fs/promises";
export async function verifyWebhooks({
  published,
  send,
  userRequest,
  userCommand,
  sendAdmin,
  adminToken,
  wait,
  fixture,
  db,
}) {
  const saved = [];
  for (const item of published) {
    const { user, project, profile } = item.subject;
    for (const strategy of ["conversation", "workflow"]) {
      const version =
        strategy === "conversation"
          ? profile.body.version.id
          : item.workflowAgent.version.id;
      const created = await userCommand(user.login, [
        "webhooks",
        "create",
        project.projectId,
        "--profile-version",
        version,
        "--name",
        `Webhook ${strategy} ${user.login}`,
        "--input-field",
        "task",
        "--json",
      ]);
      assert.ok(created.secret.startsWith("whk_"));
      const path = created.webhook.deliveryPath;
      const body = {
        task: `BB_PERSONAL_webhook-${strategy}-${user.login}`,
        projectId: "untrusted",
        ownerUserId: "untrusted",
        profileVersionId: "untrusted",
      };
      const options = {
        method: "POST",
        token: created.secret,
        headers: { "x-bb-delivery-id": "source-event" },
        body,
      };
      assert.equal(
        (await send(path, { ...options, token: undefined })).status,
        401,
      );
      const results = await Promise.all([
        send(path, options),
        send(path, options),
      ]);
      for (const result of results)
        assert.equal(result.status, 202, JSON.stringify(result.body));
      assert.equal(results[0].body.id, results[1].body.id);
      assert.equal(results[0].body.runId, results[1].body.runId);
      const delivery = results[0].body;
      await wait(async () => {
        const result = await userRequest(
          user.login,
          `/control-plane/user/agent-runs/${delivery.runId}/result`,
        );
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(result.body.run.source, "webhook");
        return (
          result.body.text ===
          `Personal webhook-${strategy}-${user.login} completed`
        );
      }, `webhook native ${strategy} ${user.login}`);
      assert.deepEqual(
        JSON.parse(
          await readFile(
            `${user.home}/bb-personal-webhook-${strategy}-${user.login}.json`,
            "utf8",
          ),
        ),
        { uid: user.uid, home: user.home, cwd: project.cwd },
      );
      const other = user.login === "alice" ? "bob" : "alice";
      for (const suffix of ["", "/history"])
        assert.equal(
          (
            await userRequest(
              other,
              `/control-plane/user/webhooks/${created.webhook.id}${suffix}`,
            )
          ).status,
          404,
        );
      assert.equal(
        (
          await userRequest(
            other,
            `/control-plane/user/agent-runs/${delivery.runId}/result`,
          )
        ).status,
        404,
      );
      assert.equal(
        (await send(path, { ...options, body: { task: "changed" } })).status,
        409,
      );
      const invalid = await send(path, {
        ...options,
        headers: { "x-bb-delivery-id": "invalid-input" },
        body: { task: 42 },
      });
      assert.equal(invalid.status, 422);
      assert.equal(invalid.body.error, "invalid_webhook_input");
      await userCommand(user.login, [
        "webhooks",
        "disable",
        created.webhook.id,
        "--json",
      ]);
      assert.equal((await send(path, options)).status, 409);
      const rotated = await userCommand(user.login, [
        "webhooks",
        "rotate",
        created.webhook.id,
        "--json",
      ]);
      await userCommand(user.login, [
        "webhooks",
        "enable",
        created.webhook.id,
        "--json",
      ]);
      assert.equal((await send(path, options)).status, 401);
      options.token = rotated.secret;
      const payloadFile = `/tmp/webhook-${strategy}-${user.login}.json`;
      await writeFile(payloadFile, JSON.stringify(body), { mode: 0o600 });
      await chown(payloadFile, 1000, 1000);
      const cli = await userCommand(
        user.login,
        [
          "webhooks",
          "deliver",
          created.webhook.id,
          "--delivery-id",
          "source-event",
          "--payload-file",
          payloadFile,
          "--secret-stdin",
          "--json",
        ],
        rotated.secret,
      );
      assert.equal(cli.runId, delivery.runId);
      const history = await userCommand(user.login, [
        "webhooks",
        "history",
        created.webhook.id,
        "--json",
      ]);
      assert.equal(history.deliveries.length, 2);
      assert.equal(JSON.stringify(history).includes(rotated.secret), false);
      const profileId =
        strategy === "conversation"
          ? profile.body.profile.id
          : item.workflowAgent.profile.id;
      const access = `/control-plane/admin/profiles/${profileId}/access/${user.id}`;
      assert.equal(
        (await sendAdmin(access, { allowed: false }, adminToken, "PUT")).status,
        200,
      );
      const denied = await send(path, {
        ...options,
        headers: { "x-bb-delivery-id": "revoked" },
      });
      assert.equal(denied.status, 422);
      assert.equal(denied.body.state, "failed");
      assert.equal(
        (await sendAdmin(access, { allowed: true }, adminToken, "PUT")).status,
        200,
      );
      if (strategy === "conversation")
        await fixture("webhook-lost-reply", { id: delivery.id });
      saved.push({ login: user.login, path, options, delivery });
    }
  }
  return {
    async afterRestart() {
      for (const row of saved) {
        const result = await send(row.path, row.options);
        assert.equal(result.status, 202, JSON.stringify(result.body));
        assert.equal(result.body.id, row.delivery.id);
        assert.equal(result.body.runId, row.delivery.runId);
        assert.equal(result.body.createdAt, row.delivery.createdAt);
        const count = db
          .prepare(
            "SELECT count(*) AS count FROM control_plane_threads WHERE run_idempotency_key=?",
          )
          .get(`webhook:${row.delivery.id}`).count;
        if (row.delivery.runId.startsWith("thr_")) assert.equal(count, 1);
      }
      return { webhookDeliveryIdentityAndLostReplyRecoveryAfterRestart: true };
    },
  };
}
