import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
const exec = promisify(execFile);
export async function verifyMaintenanceQueue({
  db,
  created,
  send,
  token,
  wait,
}) {
  const threadId = created[0].threadId;
  const operationId = randomUUID();
  const path = `/api/v1/threads/${threadId}`;
  const service = async (action) =>
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
            JSON.stringify({
              mode: "native-maintenance",
              action,
              threadId,
              operationId,
            }),
          ],
          { cwd: "/opt/bb", timeout: 35000, maxBuffer: 65536 },
        )
      ).stdout,
    );
  const session = db
    .prepare(
      "SELECT qwen_session_id FROM control_plane_threads WHERE thread_id=?",
    )
    .get(threadId).qwen_session_id;
  assert.ok(session);
  const first = await service("begin");
  assert.equal(first.intent.phase, "blocked");
  const count = () =>
    db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE thread_id=? AND type='client/turn/requested'",
      )
      .get(threadId).n;
  const before = count();
  const row = () =>
    db
      .prepare("SELECT * FROM queued_thread_messages WHERE id=?")
      .get(first.queuedId);
  const saved = row();
  assert.ok(saved);
  for (let i = 0; i < 4; i++) {
    const result = await send(
      `${path}/queued-messages/${first.queuedId}/send`,
      { mode: "auto" },
      token,
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.delivery, "queued");
    assert.equal(result.body.queuedMessage.id, first.queuedId);
    const current = row();
    for (const field of [
      "content",
      "sender_thread_id",
      "failure_count",
      "failure_reason",
      "next_attempt_at",
      "send_at",
      "waiting_on",
      "claim_token",
      "claimed_at",
    ])
      assert.deepEqual(current[field], saved[field], field);
    assert.equal(count(), before);
  }
  const owned = db
    .prepare(
      "SELECT t.id FROM threads t JOIN control_plane_threads o ON o.thread_id=t.id WHERE o.owner_user_id=(SELECT owner_user_id FROM control_plane_threads WHERE thread_id=?) AND t.deleted_at IS NULL ORDER BY t.id",
    )
    .all(threadId);
  for (const entry of owned) {
    const stopped = await send(`/api/v1/threads/${entry.id}/stop`, {}, token);
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  }
  assert.equal(row().content, saved.content);
  assert.equal(row().failure_count, saved.failure_count);
  const finished = await service("finish");
  assert.equal(finished.phase, "idle");
  assert.equal(finished.generation, first.intent.generation);
  const delivered = await send(
    `${path}/queued-messages/${first.queuedId}/send`,
    { mode: "auto" },
    token,
  );
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  await wait(
    () =>
      !row() &&
      db.prepare("SELECT status FROM threads WHERE id=?").get(threadId)
        .status === "idle",
    "maintenance queue native completion",
  );
  assert.equal(count(), before + 1);
  assert.equal(
    db
      .prepare(
        "SELECT qwen_session_id FROM control_plane_threads WHERE thread_id=?",
      )
      .get(threadId).qwen_session_id,
    session,
  );
  const released = await send(`${path}/stop`, {}, token);
  assert.equal(released.status, 200);
  return {
    managedMaintenanceQueuedInputAndRetryBudgetPreserved: true,
    managedMaintenanceRepeatedExplicitSendDoesNotCreateEvents: true,
    managedMaintenanceQueueDeliversOnceAfterRelease: true,
    managedMaintenanceQueueResumesSameNativeQwenSession: true,
    managedMaintenanceQueueUsesAdvancedUidGeneration: true,
  };
}
