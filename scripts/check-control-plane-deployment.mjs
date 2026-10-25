import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, readFile } from "node:fs/promises";
import WebSocket from "ws";
import { verifyUserDeployment } from "./check-control-plane-user-deployment.mjs";
import { verifyQwenJobs } from "./check-control-plane-qwen-jobs.mjs";
import { verifyManagedRuntime } from "./check-control-plane-managed-runtime.mjs";

const origin = "http://127.0.0.1:8080";
const password = "deployment-check-admin-password";
const controller = new AbortController();
const deadline = setTimeout(
  () => controller.abort(),
  process.env.BB_CONTROL_PLANE_BROWSER_TEST === "1" ? 390000 : 360000,
);
const children = new Set();
const status = await readFile("/proc/self/status", "utf8");
assert.equal(
  BigInt(`0x${status.match(/^CapEff:\s+(\w+)/mu)[1]}`) & (1n << 21n),
  0n,
  "Deployment must not have CAP_SYS_ADMIN",
);

function launch(args, extra = {}) {
  const { file = process.execPath, ...options } = extra;
  const child = spawn(file, args, {
    uid: 1000,
    gid: 1000,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: "/home/node", BB_APP_URL: origin },
    ...options,
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function command(args, input = "", extra = {}) {
  const child = launch(args, extra);
  let output = "";
  let error = "";
  child.stdout.setEncoding("utf8").on("data", (data) => (output += data));
  child.stderr.setEncoding("utf8").on("data", (data) => (error += data));
  child.stdin.end(input);
  const [code] = await once(child, "exit", { signal: controller.signal });
  assert.equal(code, 0, error);
  return output;
}

async function request(path, init) {
  return fetch(`${origin}${path}`, {
    redirect: "manual",
    signal: controller.signal,
    ...init,
  });
}

async function start() {
  const child = launch(["apps/server/dist/index.js"]);
  let log = "";
  const collect = (data) => (log = (log + data).slice(-16000));
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  while (!controller.signal.aborted) {
    assert.equal(child.exitCode, null, log);
    try {
      if ((await request("/health")).ok) return child;
    } catch {}
    await new Promise((complete) => setTimeout(complete, 100));
  }
  throw new Error(`Server startup timed out: ${log}`);
}

async function login() {
  const response = await request("/control-plane/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: "operator", password }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(typeof result.token, "string");
  return result.token;
}

try {
  await command(
    [
      "configure.mjs",
      "--data-dir",
      "/srv/bb",
      "--origin",
      origin,
      "--login",
      "operator",
    ],
    password,
  );
  let server = await start();
  assert.equal((await request("/api/v1/projects")).status, 401);
  assert.equal(
    (await request("/", { headers: { accept: "text/html" } })).status,
    303,
  );
  const token = await login();
  const headers = { authorization: `Bearer ${token}` };
  const page = await request("/", { headers });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<html/);
  const asset = html.match(/(?:src|href)="(\/assets\/[^" ]+\.js)"/u)?.[1];
  assert.ok(asset, "Native BB UI must reference its built JavaScript");
  assert.equal((await request(asset)).status, 401);
  assert.equal((await request(asset, { headers })).status, 200);
  assert.equal((await request("/api/v1/projects", { headers })).status, 200);
  assert.equal(
    (
      await request("/api/v1/projects", {
        headers: { "x-user-id": "operator" },
      })
    ).status,
    401,
  );
  const cli = ["apps/cli/dist/index.js", "server", "access"];
  const env = {
    ...process.env,
    HOME: "/tmp/bb-cli-check",
    BB_SERVER_URL: origin,
    BB_CLI: "",
    BB_CLI_ERROR_LOG: "0",
  };
  await command(
    [...cli, "login", "--login", "operator", "--password-stdin"],
    password,
    { env },
  );
  assert.match(await command([...cli, "status"], "", { env }), /operator/);
  await command(["apps/cli/dist/index.js", "project", "list"], "", { env });
  await command([...cli, "logout"], "", { env });
  const socket = new WebSocket(`ws://127.0.0.1:8080/ws`, { headers });
  await once(socket, "open", { signal: controller.signal });
  const closed = once(socket, "close", { signal: controller.signal });
  assert.equal(
    (await request("/control-plane/logout", { method: "POST", headers }))
      .status,
    200,
  );
  const [code] = await closed;
  assert.equal(code, 4401);
  const restartToken = await login();
  server.kill("SIGTERM");
  await once(server, "exit", { signal: controller.signal });
  server = await start();
  assert.equal(
    (
      await request("/api/v1/projects", {
        headers: { authorization: `Bearer ${restartToken}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/v1/projects", {
        headers: { authorization: `Bearer ${await login()}` },
      })
    ).status,
    200,
  );
  await access("/srv/bb/bb.db");
  server.kill("SIGTERM");
  await once(server, "exit", { signal: controller.signal });
  const users = await verifyUserDeployment({
    launch,
    command,
    signal: controller.signal,
    password,
  });
  const qwen = await verifyQwenJobs({
    command,
    launch,
    signal: controller.signal,
  });
  const managedRuntime = await verifyManagedRuntime({
    launch,
    signal: controller.signal,
    password,
  });
  process.stdout.write(
    JSON.stringify({
      deployedServer: true,
      nativeUi: true,
      sqlite: true,
      cli: true,
      anonymousDenied: true,
      assetsProtected: true,
      logoutClosesSocket: true,
      restartRevokesSessions: true,
      users,
      qwen,
      managedRuntime,
    }) + "\n",
  );
} finally {
  clearTimeout(deadline);
  for (const child of children) child.kill("SIGKILL");
}
