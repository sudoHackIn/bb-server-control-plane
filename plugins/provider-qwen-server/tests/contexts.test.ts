import { test } from "vitest";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveServiceContext } from "../src/service-context.js";
test("provider resolves numeric identity through private service socket; denies bad contexts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provider-context-"));
  const socket = join(dir, "context.sock");
  const sessionId = randomUUID();
  const context = {
    threadId: "thr_test",
    sessionId,
    id: randomUUID(),
    user: "alice",
    uid: 200000,
    gid: 200000,
    home: "/srv/users/alice/home",
    cwd: "/srv/users/alice/projects/default",
  };
  let response: unknown = context;
  let status = 200;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    assert.equal(req.url, "/resolve");
    assert.equal(req.method, "POST");
    assert.deepEqual(JSON.parse(body), {
      cwd: context.cwd,
      sessionId,
      threadId: "thr_test",
    });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    assert.deepEqual(
      await resolveServiceContext(socket, context.cwd, sessionId, "thr_test"),
      context,
    );
    for (const patch of [
      { uid: 0 },
      { gid: 200001 },
      { cwd: "/tmp" },
      { id: "alice" },
      { threadId: "thr_foreign" },
      { sessionId: randomUUID() },
    ]) {
      response = { ...context, ...patch };
      await assert.rejects(
        resolveServiceContext(socket, context.cwd, sessionId, "thr_test"),
      );
    }
    status = 403;
    response = { error: "denied" };
    await assert.rejects(
      resolveServiceContext(socket, context.cwd, sessionId, "thr_test"),
      /denied/,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});
