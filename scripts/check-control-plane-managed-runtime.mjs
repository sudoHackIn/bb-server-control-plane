import assert from "node:assert/strict";
import { createServer } from "node:http";
import { request } from "node:https";
import { once } from "node:events";
import { readFile, writeFile, readdir } from "node:fs/promises";
import Database from "better-sqlite3";
import WebSocket from "ws";

export async function verifyManagedRuntime({ launch, signal, password }) {
  const config = JSON.parse(
    await readFile("/srv/bb/control-plane.json", "utf8"),
  );
  config.runtime = {
    daemonEntrypoint: "/opt/bb/apps/host-daemon/dist/control-plane.js",
    cliDirectory: "/opt/bb/apps/cli/dist",
  };
  await writeFile("/srv/bb/control-plane.json", JSON.stringify(config), {
    mode: 0o600,
  });
  const ca = await readFile(config.users.tls.clientCaFile);
  const db = new Database("/srv/bb/bb.db", { readonly: true });
  const users = db
    .prepare("SELECT * FROM control_plane_users ORDER BY uid")
    .all();
  const toolCalls = new Set();
  let resumedWithHistory = false;
  const backend = createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    const body = JSON.parse(text);
    const marker = JSON.stringify(body.messages).includes("BB_MANAGED_ALICE")
      ? "alice"
      : "bob";
    const tool = body.tools?.find(
      (entry) => entry.function?.name === "run_shell_command",
    );
    if (!tool) {
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "managed_aux",
            object: "chat.completion",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "Fixture auxiliary response",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          `data: ${JSON.stringify({ id: "managed_aux", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "Fixture auxiliary response" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
      }
      return;
    }
    if (JSON.stringify(body.messages).includes("continue after restart"))
      resumedWithHistory = JSON.stringify(body.messages).includes(
        "BB_MANAGED_ALICE first",
      );
    const first = !toolCalls.has(marker);
    toolCalls.add(marker);
    const code =
      'const fs=require("node:fs");fs.writeFileSync(process.env.HOME+"/bb-managed-' +
      marker +
      '.json",JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),home:process.env.HOME,cwd:process.cwd(),machineKeyInEnvironment:!!process.env.BB_HOST_ENROLL_KEY}));console.log("managed-probe-written")';
    const delta = first
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `managed_${marker}`,
              type: "function",
              function: {
                name: tool.function.name,
                arguments: JSON.stringify({
                  command: `/usr/local/bin/node -e '${code}'`,
                  description: "Verify managed identity",
                  timeout: 30000,
                }),
              },
            },
          ],
        }
      : { role: "assistant", content: `Managed ${marker} probe completed` };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: `managed_${marker}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: `managed_${marker}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise((resolve) => backend.listen(38888, "127.0.0.1", resolve));
  const send = (path, body, token) =>
    new Promise((resolve, reject) => {
      const req = request(
        config.publicOrigin + path,
        {
          ca,
          method: body === undefined ? "GET" : "POST",
          signal,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (part) => {
            text += part;
          });
          res.once("error", reject);
          res.once("end", () => {
            try {
              resolve({ status: res.statusCode, body: JSON.parse(text) });
            } catch {
              reject(
                new Error(
                  `Non-JSON response (${res.statusCode}): ${text.slice(-1000)}`,
                ),
              );
            }
          });
        },
      );
      req.once("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  let child;
  let observer;
  let verified = false;
  const processInfo = async (pid) => {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return {
        parent: Number(fields[1]),
        start: fields[19],
        state: fields[0],
      };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  let log = "";
  const wait = async (check, label) => {
    const deadline = Date.now() + 30000;
    while (!signal.aborted && Date.now() < deadline) {
      assert.equal(child?.exitCode, null, log);
      try {
        const value = await check();
        if (value) return value;
      } catch (error) {
        if (error.code !== "ECONNREFUSED" && error.code !== "ENOENT")
          throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Managed runtime timed out (${label}): ${log}`);
  };
  const start = async () => {
    child = launch(["apps/server/dist/index.js"], {
      env: {
        ...process.env,
        HOME: "/home/node",
        BB_APP_URL: config.publicOrigin,
        NODE_EXTRA_CA_CERTS: config.users.tls.clientCaFile,
        QWEN_SERVER_BASE_URL: `http://127.0.0.1:${backend.address().port}/v1`,
        QWEN_SERVER_MODEL: "qwen-job-test",
        NEURALDEAP_KEY: "local-test-only",
      },
    });
    const collect = (part) => {
      log = (log + part).slice(-18000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    await wait(
      async () => (await send("/health")).status === 200,
      "HTTPS server",
    );
    const session = await send("/control-plane/login", {
      login: "operator",
      password,
    });
    assert.equal(session.status, 200, JSON.stringify(session.body));
    return session.body.token;
  };
  const connected = () =>
    db
      .prepare(
        "SELECT * FROM host_daemon_sessions WHERE status = 'active' AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get();
  try {
    let token = await start();
    const firstSession = await wait(
      connected,
      "daemon enrollment and connection",
    );
    await assert.rejects(
      fetch("http://127.0.0.1:38887/health", { signal }),
      (error) => error.cause?.code === "ECONNREFUSED",
    );
    const enabled = await send(
      "/api/v1/plugins/provider-qwen-server/enable",
      {},
      token,
    );
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    const created = [];
    for (const user of users) {
      const project = db
        .prepare(
          "SELECT * FROM control_plane_projects WHERE owner_user_id = ? AND slug = 'app'",
        )
        .get(user.id);
      const environment = db
        .prepare("SELECT * FROM environments WHERE project_id = ? AND path = ?")
        .get(project.project_id, project.cwd);
      const result = await send(
        "/api/v1/threads",
        {
          projectId: project.project_id,
          providerId: "qwen-server",
          origin: "app",
          model: "qwen-configured-default",
          reasoningLevel: "none",
          permissionMode: "full",
          title: `Managed ${user.login}`,
          input: [
            {
              type: "text",
              text: `BB_MANAGED_${user.login.toUpperCase()} first`,
              mentions: [],
            },
          ],
          environment: { type: "reuse", environmentId: environment.id },
        },
        token,
      );
      assert.equal(result.status, 201, JSON.stringify(result.body) + log);
      const threadId = result.body.id;
      await wait(() => {
        const row = db
          .prepare("SELECT status FROM threads WHERE id = ?")
          .get(threadId);
        if (row?.status === "error")
          throw new Error(
            `Managed thread failed: ${JSON.stringify(db.prepare("SELECT data FROM events WHERE thread_id = ? ORDER BY seq DESC LIMIT 6").all(threadId))} ${log}`,
          );
        return row?.status === "idle";
      }, `Qwen ${user.login} turn`);
      const probe = JSON.parse(
        await readFile(`${user.home}/bb-managed-${user.login}.json`, "utf8"),
      );
      assert.deepEqual(probe, {
        uid: user.uid,
        gid: user.uid,
        groups: [user.uid],
        home: user.home,
        cwd: project.cwd,
        machineKeyInEnvironment: false,
      });
      const owner = db
        .prepare("SELECT * FROM control_plane_threads WHERE thread_id = ?")
        .get(threadId);
      assert.equal(owner.owner_user_id, user.id);
      assert.match(owner.qwen_session_id, /^[0-9a-f-]{36}$/u);
      const timeline = await send(
        `/api/v1/threads/${threadId}/timeline`,
        undefined,
        token,
      );
      assert.equal(timeline.status, 200);
      assert.match(
        JSON.stringify(timeline.body),
        new RegExp(`Managed ${user.login} probe completed`, "u"),
      );
      created.push({ threadId, sessionId: owner.qwen_session_id });
    }
    const sdkSignals = [];
    let observerReady = false;
    observer = new WebSocket(
      config.publicOrigin.replace(/^http/u, "ws") + "/ws",
      { ca, headers: { authorization: `Bearer ${token}` } },
    );
    observer.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "pong") observerReady = true;
      if (
        message.type === "plugin-signal" &&
        message.pluginId === "concurrency-limit" &&
        message.channel === "configuration-changed"
      )
        sdkSignals.push(message);
    });
    await once(observer, "open", { signal });
    observer.send(JSON.stringify({ type: "ping" }));
    await wait(() => observerReady, "administrative realtime observer");
    let daemonToRestart;
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/u.test(name)) continue;
      const info = await processInfo(Number(name));
      if (info?.parent !== child.pid) continue;
      const command = await readFile(`/proc/${name}/cmdline`, "utf8");
      if (command.split("\0").includes(config.runtime.daemonEntrypoint))
        daemonToRestart = Number(name);
    }
    assert.ok(daemonToRestart, "Missing daemon for private SDK event check");
    sdkSignals.length = 0;
    process.kill(daemonToRestart, "SIGTERM");
    await wait(() => sdkSignals.length > 0, "trusted plugin SDK host event");
    await wait(() => {
      const current = connected();
      return current && current.instance_id !== firstSession.instance_id;
    }, "supervised daemon restart");
    child.kill("SIGTERM");
    await once(child, "exit", { signal });
    assert.equal(
      connected(),
      undefined,
      "Daemon remained connected after managed server shutdown",
    );
    assert.equal(
      (await readdir("/srv/bb")).some((name) =>
        name.startsWith("qwen-execution-"),
      ),
      false,
    );
    token = await start();
    const secondSession = await wait(
      connected,
      "daemon reconnect after restart",
    );
    assert.equal(secondSession.host_id, firstSession.host_id);
    assert.notEqual(secondSession.instance_id, firstSession.instance_id);
    const resumed = await send(
      `/api/v1/threads/${created[0].threadId}/send`,
      {
        input: [
          {
            type: "text",
            text: "BB_MANAGED_ALICE continue after restart",
            mentions: [],
          },
        ],
        mode: "start",
      },
      token,
    );
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    await wait(
      () =>
        db
          .prepare("SELECT status FROM threads WHERE id = ?")
          .get(created[0].threadId)?.status === "idle" && resumedWithHistory,
      "resumed turn",
    );
    assert.equal(
      db
        .prepare(
          "SELECT qwen_session_id FROM control_plane_threads WHERE thread_id = ?",
        )
        .get(created[0].threadId).qwen_session_id,
      created[0].sessionId,
    );
    let daemonPid;
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/u.test(name)) continue;
      const info = await processInfo(Number(name));
      if (info?.parent !== child.pid) continue;
      const command = await readFile(`/proc/${name}/cmdline`, "utf8");
      if (command.split("\0").includes(config.runtime.daemonEntrypoint))
        daemonPid = Number(name);
    }
    assert.ok(daemonPid, "Managed daemon process was not found");
    const daemonInfo = await processInfo(daemonPid);
    const leases = [];
    for (const name of await readdir("/var/lib/bb-agent-launcher/jobs")) {
      const lease = JSON.parse(
        await readFile(`/var/lib/bb-agent-launcher/jobs/${name}`, "utf8"),
      );
      if (lease.pid) leases.push(lease);
    }
    assert.ok(
      leases.length > 0,
      "Expected a live Qwen session before parent death",
    );
    const qwenProcesses = [];
    const processTree = new Map();
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/u.test(name)) continue;
      const info = await processInfo(Number(name));
      if (info) processTree.set(Number(name), info);
    }
    const descendantIds = new Set([daemonPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, info] of processTree) {
        if (!descendantIds.has(pid) && descendantIds.has(info.parent)) {
          descendantIds.add(pid);
          changed = true;
        }
      }
    }
    const descendants = [...descendantIds].flatMap((pid) => {
      const info = processTree.get(pid);
      return info ? [{ pid, start: info.start }] : [];
    });
    for (const entry of descendants) {
      const argv = await readFile(`/proc/${entry.pid}/cmdline`, "utf8").catch(
        () => "",
      );
      if (
        argv
          .split("\0")
          .includes("/opt/bb/node_modules/@qwen-code/sdk/dist/cli/cli.js") &&
        argv.split("\0")[0] === "/usr/local/bin/node"
      )
        qwenProcesses.push(entry);
    }
    assert.ok(
      qwenProcesses.length > 0,
      "Expected actual namespaced Qwen processes before parent death",
    );
    const supervised = [...leases, ...qwenProcesses, ...descendants];
    const exited = once(child, "exit", { signal });
    child.kill("SIGKILL");
    await exited;
    const cleanupDeadline = Date.now() + 20000;
    let cleaned = false;
    while (!signal.aborted && Date.now() < cleanupDeadline) {
      const currentDaemon = await processInfo(daemonPid);
      const leaseStates = await Promise.all(
        supervised.map(async (lease) => {
          const info = await processInfo(lease.pid);
          return !info || info.start !== lease.start || info.state === "Z";
        }),
      );
      cleaned =
        (!currentDaemon ||
          currentDaemon.start !== daemonInfo.start ||
          currentDaemon.state === "Z") &&
        leaseStates.every(Boolean);
      if (cleaned) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(
      cleaned,
      "Parent death left a live daemon or Qwen job supervisor: " +
        JSON.stringify({
          daemon: await processInfo(daemonPid),
          leases: await Promise.all(
            supervised.map(async (lease) => ({
              pid: lease.pid,
              info: await processInfo(lease.pid),
            })),
          ),
        }) +
        log.slice(-2000),
    );
    token = await start();
    const recovered = await wait(() => {
      const row = connected();
      return row && row.instance_id !== secondSession.instance_id ? row : null;
    }, "daemon recovery after parent crash");
    assert.equal(recovered.host_id, firstSession.host_id);
    assert.notEqual(recovered.instance_id, secondSession.instance_id);
    const recoveredThread = await send(
      `/api/v1/threads/${created[0].threadId}`,
      undefined,
      token,
    );
    assert.equal(recoveredThread.status, 200);
    verified = true;
    return {
      realDaemonEnrollment: true,
      trustedPluginSdkRealtimeEvents: true,
      staleContextReclaimedAfterCrash: true,
      localDaemonApiDisabled: true,
      privateMachineBootstrap: true,
      realBbThreadDispatch: true,
      nativeUidHomeTools: true,
      nativeTimeline: true,
      managedShutdown: true,
      persistedDaemonIdentity: true,
      resumedThreadAfterRestart: true,
      parentDeathStopsDaemonAndQwen: true,
      daemonDescendantsExitAfterParentDeath: true,
      crashRecoveryRetainsIdentityAndThreads: true,
      userThreadApi: false,
    };
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit", { signal });
    }
    observer?.terminate();
    const remainingContexts = (await readdir("/srv/bb")).filter((name) =>
      name.startsWith("qwen-execution-"),
    );
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
    db.close();
    if (verified)
      assert.deepEqual(
        remainingContexts,
        [],
        "Stale context directories remain after crash recovery",
      );
  }
}
