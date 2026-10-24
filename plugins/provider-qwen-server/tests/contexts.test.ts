import { test, vi } from "vitest";
import { createSdkMcpServer } from "@qwen-code/sdk";
import { serverQuery } from "../src/server-query.js";
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
    profile: {
      versionId: randomUUID(),
      definition: {
        prompt: "Approved",
        providerId: "qwen-server",
        model: "approved-model",
        reasoningLevel: "none",
        permissionMode: "full",
        tools: ["read_file"],
        mcpServers: [],
      },
    },
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
    const previousSocket = process.env.QWEN_SERVER_CONTEXT_SOCKET;
    const mcp = createSdkMcpServer({ name: "unverified", tools: [] });
    const connect = vi.spyOn(mcp.instance, "connect");
    process.env.QWEN_SERVER_CONTEXT_SOCKET = socket;
    const blocked = serverQuery({
      threadId: "thr_test",
      prompt: (async function* () {})(),
      options: { cwd: context.cwd, sessionId, mcpServers: { unverified: mcp } },
    });
    try {
      await assert.rejects(blocked.initialized, /Unverified SDK MCP/);
      assert.equal(connect.mock.calls.length, 0);
      await blocked.close();
      const cancelled = serverQuery({
        threadId: "thr_test",
        prompt: (async function* () {})(),
        options: { cwd: context.cwd, sessionId },
      });
      const stopping = cancelled.close();
      await assert.rejects(cancelled.initialized, /closed before launch/);
      await stopping;
    } finally {
      connect.mockRestore();
      if (previousSocket === undefined)
        delete process.env.QWEN_SERVER_CONTEXT_SOCKET;
      else process.env.QWEN_SERVER_CONTEXT_SOCKET = previousSocket;
    }
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
