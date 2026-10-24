import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import WebSocket from "ws";
import { z } from "zod";
import {
  createControlPlaneAccess,
  currentControlPlanePrincipal,
} from "../src/control-plane/access.js";
import { hashAdminPassword } from "../src/control-plane/credentials.js";

async function main() {
  assert.equal(
    process.getuid?.(),
    0,
    "Run this smoke in the isolated root Docker container to test another UID",
  );
  let now = Date.now();
  const password = randomBytes(24).toString("hex");
  const config = {
    version: 1 as const,
    publicOrigin: "http://127.0.0.1",
    admin: {
      login: "operator",
      passwordHash: await hashAdminPassword(password),
    },
  };
  const access = createControlPlaneAccess(config, () => now);
  const app = new Hono();
  access.install(app);
  app.get("/api/v1/probe", (context) =>
    context.json(currentControlPlanePrincipal()),
  );
  app.post("/internal/hosts/enroll-key", (context) =>
    context.json({ shouldNotBePublic: true }),
  );
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({
    app,
  });
  access.attachSockets(wss);
  app.get(
    "/ws",
    upgradeWebSocket(() => ({})),
  );
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  injectWebSocket(server);
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  config.publicOrigin = base;
  const signIn = () =>
    fetch(`${base}/control-plane/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "operator", password }),
    });
  const open = async (cookie: string) => {
    const socket = new WebSocket(base.replace("http:", "ws:") + "/ws", {
      origin: base,
      headers: { cookie },
    });
    await once(socket, "open");
    return socket;
  };
  const closed = (socket: WebSocket) =>
    new Promise<number>((resolve) =>
      socket.once("close", (code) => resolve(code)),
    );
  try {
    assert.equal((await fetch(`${base}/api/v1/probe`)).status, 401);
    assert.equal(
      (await fetch(`${base}/internal/hosts/enroll-key`, { method: "POST" }))
        .status,
      401,
    );
    const status = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const r=await fetch(${JSON.stringify(base + "/api/v1/probe")}); console.log(r.status);`,
        ],
        {
          uid: 200001,
          gid: 200001,
          cwd: "/tmp",
          env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
          encoding: "utf8",
          timeout: 10000,
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
      );
    });
    assert.equal(status, "401");
    assert.equal(
      (
        await fetch(`${base}/api/v1/probe`, {
          headers: { "x-role": "admin", "x-user-id": "operator" },
        })
      ).status,
      401,
    );
    const response = await signIn();
    assert.equal(response.status, 200);
    const body: unknown = await response.json();
    const session = z
      .object({ token: z.string(), expiresAt: z.number() })
      .parse(body);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (
        await fetch(`${base}/api/v1/probe`, {
          headers: { authorization: `Bearer ${session.token}` },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${base}/api/v1/probe`, {
          headers: { cookie, authorization: "Bearer forged" },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${base}/control-plane/logout`, {
          method: "POST",
          headers: { cookie, origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    const service = await access.dispatch(app, `${base}/api/v1/probe`);
    assert.deepEqual(await service.json(), { kind: "service" });
    const socket = await open(cookie),
      logoutClosed = closed(socket);
    assert.equal(
      (
        await fetch(`${base}/control-plane/logout`, {
          method: "POST",
          headers: { cookie, origin: base },
        })
      ).status,
      200,
    );
    assert.equal(await logoutClosed, 4401);
    assert.equal(
      (
        await fetch(`${base}/api/v1/probe`, {
          headers: { authorization: `Bearer ${session.token}` },
        })
      ).status,
      401,
    );
    const fresh = await signIn(),
      freshBody: unknown = await fresh.json();
    const freshSession = z.object({ expiresAt: z.number() }).parse(freshBody);
    const expiring = await open(fresh.headers.get("set-cookie")!.split(";")[0]),
      expiryClosed = closed(expiring);
    now = freshSession.expiresAt;
    assert.equal(await expiryClosed, 4401);
    console.log(
      JSON.stringify({
        passed: true,
        node: process.version,
        lowUid: 200001,
        lowUidHttpStatus: Number(status),
        anonymousHttpDenied: true,
        forgedIdentityDenied: true,
        administratorLogin: true,
        privateSdk: true,
        logoutRevokesSocket: true,
        expiryRevokesSocket: true,
      }),
    );
  } finally {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      wss.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const deadline = setTimeout(() => {
  console.error("Control-plane smoke timed out");
  process.exit(1);
}, 15000);
deadline.unref();
main()
  .finally(() => clearTimeout(deadline))
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Control-plane smoke failed",
    );
    process.exitCode = 1;
  });
