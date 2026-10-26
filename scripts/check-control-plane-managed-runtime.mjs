import { createProjectMcpFixture } from "./check-control-plane-project-mcp.mjs";
import { createProviderLifecycleFixture } from "./check-control-plane-provider-lifecycle.mjs";
import { createWorkspaceFixture } from "./check-control-plane-workspace.mjs";
import { createMessageSourceFixture } from "./check-control-plane-message-sources.mjs";
import { createDaemonRequestFixture } from "./check-control-plane-daemon-requests.mjs";
import assert from "node:assert/strict";
import { createUserThreadFixture } from "./check-control-plane-user-threads.mjs";
import { createApprovalFixture } from "./check-control-plane-approvals.mjs";
import { createServer } from "node:http";
import { request } from "node:https";
import { once } from "node:events";
import { readFile, writeFile, readdir, unlink } from "node:fs/promises";
import Database from "better-sqlite3";
import WebSocket from "ws";

export async function verifyManagedRuntime({ launch, signal, password }) {
  const startedAt = Date.now();
  const stage = (name) =>
    console.log(
      JSON.stringify({
        controlPlaneStage: name,
        elapsedMs: Date.now() - startedAt,
      }),
    );
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
  const mcp = createProjectMcpFixture({ db, users, config });
  const workspace = createWorkspaceFixture({ db, users });
  const providers = createProviderLifecycleFixture({ db, users });
  const approvals = createApprovalFixture({ db, users });
  const personal = createUserThreadFixture({ db, users });
  const daemonRequests = createDaemonRequestFixture({ db });
  const messageSources = createMessageSourceFixture({ db, users });
  let messageSourceVerification, messageSourceRestartVerification;
  let daemonRequestVerification;
  let personalVerification, personalRestartVerification;
  let approvalVerification;
  let workspaceVerification, workspaceRestartVerification;
  let providerVerification, providerRestartVerification;
  let mcpVerification,
    mcpRestartVerification,
    mcpRuntimeVerification,
    mcpRuntimeRestartVerification;
  const toolCalls = new Map();
  const delegatedResults = new Set();
  let resumedWithHistory = false;
  const backend = createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    const body = text ? JSON.parse(text) : {};
    if (mcp.handleRemote(req, res, body)) return;
    if (
      mcp.handleModel(body, res) ||
      messageSources.handle(body, res) ||
      daemonRequests.handle(body, res) ||
      approvals.handle(body, res) ||
      personal.handle(body, res)
    )
      return;
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
    const count = toolCalls.get(marker) ?? 0;
    toolCalls.set(marker, count + 1);
    const first = count < 2;
    const delegated = body.tools?.find(
      (entry) => entry.function?.name === "mcp__bb__approved_server_probe",
    );
    assert.ok(
      delegated,
      `Approved MCP tool was not offered: ${JSON.stringify(body.tools?.map((entry) => entry.function?.name))}`,
    );
    assert.equal(
      body.tools.some((entry) =>
        entry.function?.name.includes("forbidden_server_probe"),
      ),
      false,
    );
    if (count >= 2 && !delegatedResults.has(marker)) {
      const result = body.messages
        .filter((message) => message.role === "tool")
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content),
        )
        .find((content) => content.includes("delegatedProbe"));
      assert.ok(result, "Missing actual delegated server tool result");
      const decode = (value) => {
        if (typeof value === "string") {
          try {
            return decode(JSON.parse(value));
          } catch {
            return undefined;
          }
        }
        if (!value || typeof value !== "object") return undefined;
        if (value.delegatedProbe === true) return value;
        return Object.values(value).map(decode).find(Boolean);
      };
      const probe = decode(result);
      assert.ok(probe, "Missing structured delegated probe");
      assert.equal(probe.unscopedSdkDenied, true);
      assert.equal(probe.backgroundApiDenied, true);
      const binding = db
        .prepare(
          "SELECT t.project_id, o.owner_user_id FROM threads t JOIN control_plane_threads o ON o.thread_id = t.id WHERE t.id = ?",
        )
        .get(probe.threadId);
      assert.equal(
        binding?.owner_user_id,
        users.find((user) => user.login === marker)?.id,
      );
      assert.equal(binding?.project_id, probe.projectId);
      delegatedResults.add(marker);
    }
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
              id: `managed_${marker}_${count}`,
              type: "function",
              function: {
                name:
                  count === 0 ? tool.function.name : delegated.function.name,
                arguments: JSON.stringify(
                  count === 0
                    ? {
                        command: `/usr/local/bin/node -e '${code}'`,
                        description: "Verify managed identity",
                        timeout: 30000,
                      }
                    : {
                        userId: "forged",
                        threadId: "foreign",
                        projectId: "foreign",
                      },
                ),
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
  const send = (
    path,
    body,
    token,
    method = body === undefined ? "GET" : "POST",
  ) =>
    new Promise((resolve, reject) => {
      const req = request(
        config.publicOrigin + path,
        {
          ca,
          method,
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
      if (error.code === "ENOENT" || error.code === "ESRCH") return null;
      throw error;
    }
  };
  let log = "";
  const wait = async (check, label, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    while (!signal.aborted && Date.now() < deadline) {
      assert.equal(
        child?.exitCode,
        null,
        `Server exited during ${label}; exit=${child?.exitCode},signal=${child?.signalCode}`,
      );
      assert.equal(
        child?.signalCode,
        null,
        `Server killed during ${label}; exit=${child?.exitCode},signal=${child?.signalCode}`,
      );
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
    const installed = await send(
      "/api/v1/plugins/install",
      { source: "path:/srv/bb-tool-fixture" },
      token,
    );
    assert.equal(installed.status, 200, JSON.stringify(installed.body) + log);
    assert.equal(
      installed.body.plugin.status,
      "running",
      JSON.stringify(installed.body),
    );
    await workspace.prepare();
    const created = [];
    for (const user of users) {
      const approved = await send(
        "/control-plane/admin/profiles",
        {
          slug: `execution-${user.login}`,
          name: `Execution ${user.login}`,
          definition: {
            prompt: "Managed fixture",
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
      assert.equal(approved.status, 201);
      assert.equal(
        (
          await send(
            `/control-plane/admin/profiles/${approved.body.profile.id}/access/${user.id}`,
            { allowed: true },
            token,
            "PUT",
          )
        ).status,
        200,
      );
      const project = db
        .prepare(
          "SELECT * FROM control_plane_projects WHERE owner_user_id = ? AND slug = 'app'",
        )
        .get(user.id);
      const environment = db
        .prepare("SELECT * FROM environments WHERE project_id = ? AND path = ?")
        .get(project.project_id, project.cwd);
      const threadInput = {
        projectId: project.project_id,
        controlPlaneProfileVersionId: approved.body.version.id,
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
      };
      const beforeRejected = db
        .prepare("SELECT count(*) AS value FROM threads")
        .get().value;
      assert.equal(
        (
          await send(
            "/api/v1/threads",
            { ...threadInput, controlPlaneProfileVersionId: undefined },
            token,
          )
        ).status,
        404,
      );
      if (created[0])
        assert.equal(
          (
            await send(
              "/api/v1/threads",
              {
                ...threadInput,
                controlPlaneProfileVersionId: created[0].profileVersionId,
              },
              token,
            )
          ).status,
          404,
        );
      assert.equal(
        db.prepare("SELECT count(*) AS value FROM threads").get().value,
        beforeRejected,
      );
      const result = await send("/api/v1/threads", threadInput, token);
      assert.equal(result.status, 201, JSON.stringify(result.body) + log);
      const threadId = result.body.id;
      await wait(() => {
        const row = db
          .prepare("SELECT status FROM threads WHERE id = ?")
          .get(threadId);
        if (row?.status === "error")
          throw new Error(
            `Managed thread failed: ${JSON.stringify(db.prepare("SELECT data FROM events WHERE thread_id = ? ORDER BY sequence DESC LIMIT 6").all(threadId))} ${log}`,
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
      assert.equal(owner.profile_version_id, approved.body.version.id);
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
      assert.equal(delegatedResults.has(user.login), true);
      for (const name of [
        "bb",
        "mcp",
        "hook",
        "extension",
        "discovery",
        "call",
      ])
        await assert.rejects(
          readFile(`${user.home}/unapproved-${name}`),
          (error) => error.code === "ENOENT",
        );
      created.push({
        threadInput,
        threadId,
        sessionId: owner.qwen_session_id,
        profileId: approved.body.profile.id,
        profileVersionId: approved.body.version.id,
      });
    }
    daemonRequestVerification = await daemonRequests.verify({
      send,
      wait,
      token,
      created,
    });
    messageSourceVerification = await messageSources.verify({
      send,
      wait,
      token,
      created,
    });
    stage("message-sources-complete");
    stage("native-dispatch-complete");
    workspaceVerification = await workspace.verify({ send, token, wait });
    stage("workspace-complete");
    providerVerification = await providers.verify({ send, token, wait });
    stage("provider-lifecycle-complete");
    mcpVerification = await mcp.verify({ send, token });
    stage("project-mcp-configuration-complete");
    mcpRuntimeVerification = await mcp.verifyRuntime({
      send,
      token,
      created,
      wait,
    });
    stage("project-mcp-native-complete");
    approvalVerification = await approvals.verify({ send, wait, token });
    personalVerification = await personal.verify({
      launch,
      signal,
      wait,
      sendAdmin: send,
      adminToken: token,
      config,
      diagnostics: () => log,
      password,
    });
    assert.equal(
      (
        await send(
          `/control-plane/admin/profiles/${created[0].profileId}/access/${users[0].id}`,
          { allowed: false },
          token,
          "PUT",
        )
      ).status,
      200,
    );
    const eventCount = db
      .prepare("SELECT count(*) AS value FROM events WHERE thread_id = ?")
      .get(created[0].threadId).value;
    const revoked = await send(
      `/api/v1/threads/${created[0].threadId}/send`,
      {
        input: [
          {
            type: "text",
            text: "Must not execute after revocation",
            mentions: [],
          },
        ],
        mode: "start",
      },
      token,
    );
    assert.equal(revoked.status, 403);
    assert.equal(revoked.body.code, "execution_not_authorized");
    assert.equal(
      db
        .prepare("SELECT count(*) AS value FROM events WHERE thread_id = ?")
        .get(created[0].threadId).value,
      eventCount,
    );
    assert.equal(
      (
        await send(
          `/control-plane/admin/profiles/${created[0].profileId}/access/${users[0].id}`,
          { allowed: true },
          token,
          "PUT",
        )
      ).status,
      200,
    );
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
    stage("personal-and-browser-complete");
    const cronHold = "/srv/bb/shutdown-cron-hold";
    const cronEntered = "/srv/bb/shutdown-cron-entered";
    const cronPast = Date.now() - 60000;
    await writeFile(cronHold, "hold", { mode: 0o644 });
    const cronDb = new Database("/srv/bb/bb.db");
    try {
      for (const [name, at] of [
        ["shutdown-first", cronPast - 1],
        ["shutdown-second", cronPast],
      ]) {
        const changed = cronDb
          .prepare(
            "UPDATE plugin_schedules SET next_run_at=?,last_run_at=NULL,last_status=NULL,last_error=NULL WHERE plugin_id=? AND name=?",
          )
          .run(at, "control-plane-tool-fixture", name);
        assert.equal(changed.changes, 1);
      }
    } finally {
      cronDb.close();
    }
    await wait(
      async () => (await readFile(cronEntered, "utf8")) === "entered",
      "in-flight native plugin cron sweep",
    );
    await personal.beforeRestart();
    const shutdownHold = "/srv/bb/shutdown-admission-hold";
    const shutdownReady = "/srv/bb/shutdown-admission-ready";
    await writeFile(
      shutdownHold,
      JSON.stringify({ threadId: created[0].threadId }),
      { mode: 0o644 },
    );
    const shutdownExit = once(child, "exit", { signal });
    child.kill("SIGTERM");
    try {
      await wait(async () => {
        const proof = JSON.parse(await readFile(shutdownReady, "utf8"));
        assert.deepEqual(proof.refused, [true, true]);
        return true;
      }, "shutdown admission barrier");
      const before = db.prepare("SELECT count(*) AS n FROM threads").get().n;
      for (const [path, body] of [
        [
          "/api/v1/threads",
          {
            ...created[0].threadInput,
            title: "Must not create while stopping",
          },
        ],
        [
          `/api/v1/threads/${created[0].threadId}/send`,
          {
            input: [{ type: "text", text: "must not send", mentions: [] }],
            mode: "start",
          },
        ],
        [
          `/api/v1/threads/${created[0].threadId}/queued-messages`,
          { input: [{ type: "text", text: "must not queue", mentions: [] }] },
        ],
      ]) {
        const denied = await send(path, body, token);
        assert.equal(denied.status, 503, JSON.stringify(denied.body));
        assert.equal(denied.body.code, "server_stopping");
      }
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM threads").get().n,
        before,
      );
      await personal.duringShutdown();
      await daemonRequests.duringShutdown();
      await unlink(cronHold);
      await wait(
        () =>
          db
            .prepare(
              "SELECT last_status FROM plugin_schedules WHERE plugin_id=? AND name=?",
            )
            .get("control-plane-tool-fixture", "shutdown-first")
            ?.last_status === "ok",
        "admitted cron callback settles after shutdown",
      );
      assert.deepEqual(
        db
          .prepare(
            "SELECT next_run_at,last_run_at,last_status FROM plugin_schedules WHERE plugin_id=? AND name=?",
          )
          .get("control-plane-tool-fixture", "shutdown-second"),
        { next_run_at: cronPast, last_run_at: null, last_status: null },
      );
    } finally {
      await unlink(cronHold).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      await unlink(cronEntered);
      await unlink(shutdownHold);
      await unlink(shutdownReady);
    }
    await shutdownExit;
    await personal.afterShutdown();
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
    workspaceRestartVerification = await workspace.afterRestart({
      send,
      token,
    });
    providerRestartVerification = await providers.afterRestart();
    mcpRestartVerification = await mcp.afterRestart({ send, token });
    personalRestartVerification = await personal.afterRestart();
    messageSourceRestartVerification = await messageSources.afterRestart(token);
    stage("message-sources-restart-complete");
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
    mcpRuntimeRestartVerification = await mcp.resumeRuntime({
      send,
      token,
      wait,
    });
    stage("restart-complete");
    await personal.beforeCrash(child.pid);
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
    const workflowProcesses = [];
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
    for (const [pid, info] of processTree) {
      const argv = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(
        () => "",
      );
      if (
        argv
          .split("\0")
          .includes("/opt/bb-control-plane/workflow-evaluator.mjs")
      )
        workflowProcesses.push({ pid, start: info.start });
    }
    assert.ok(
      workflowProcesses.length >= 2,
      "Expected both UID-isolated workflow evaluators before crash",
    );
    assert.ok(
      qwenProcesses.length > 0,
      "Expected actual namespaced Qwen processes before parent death",
    );
    const supervised = [
      ...leases,
      ...qwenProcesses,
      ...workflowProcesses,
      ...descendants,
    ];
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
    await personal.afterCrashShutdown();
    token = await start();
    const workflowCrash = await personal.afterCrash();
    stage("crash-recovery-complete");
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
      ...approvalVerification,
      ...personalVerification,
      ...personalRestartVerification,
      ...workflowCrash,
      workflowEvaluatorProcessesExitAfterParentCrash: true,
      trustedPluginSdkRealtimeEvents: true,
      staleContextReclaimedAfterCrash: true,
      localDaemonApiDisabled: true,
      privateMachineBootstrap: true,
      realBbThreadDispatch: true,
      approvedBbToolInvokedThroughNativeQwenMcp: true,
      foreignBbToolNotOffered: true,
      unapprovedPluginBackgroundAuthorityApiDenied: true,
      homeConfiguredBbMcpCannotOverrideBridge: true,
      nativeUidHomeTools: true,
      nativeTimeline: true,
      ...mcpVerification,
      ...mcpRuntimeVerification,
      ...mcpRuntimeRestartVerification,
      ...mcpRestartVerification,
      ...providerVerification,
      ...providerRestartVerification,
      ...workspaceVerification,
      ...workspaceRestartVerification,
      ...daemonRequestVerification,
      ...messageSourceVerification,
      ...messageSourceRestartVerification,
      managedDaemonShutdownRefusesToolsAndApprovals: true,
      quiescenceDoesNotClaimNextDuePluginSchedule: true,
      managedShutdown: true,
      coreShutdownAdmissionRejectsCreateSendAndQueue: true,
      trustedPluginSdkCannotAdmitExecutionDuringShutdown: true,
      personalShutdownAdmissionAndReadStopVerified: true,
      persistedDaemonIdentity: true,
      resumedThreadAfterRestart: true,
      immutableProfileBoundBeforeCreation: true,
      missingAndForeignProfileCreationDenied: true,
      revokedProfileResumeDeniedBeforeEvents: true,
      parentDeathStopsDaemonAndQwen: true,
      daemonDescendantsExitAfterParentDeath: true,
      crashRecoveryRetainsIdentityAndThreads: true,
      userThreadApi: true,
      userLiveTimelineStream: true,
    };
  } catch (error) {
    const memoryEvents = await readFile(
      "/sys/fs/cgroup/memory.events",
      "utf8",
    ).catch(() => "unavailable");
    const processState = {
      exitCode: child?.exitCode,
      signalCode: child?.signalCode,
    };
    const daemonLog = await readFile(
      "/srv/bb/logs/host-daemon.1.log",
      "utf8",
    ).catch(() => "unavailable");
    throw new Error(
      `Managed runtime check failed: ${error instanceof Error ? error.message : String(error)}\nServer state: ${JSON.stringify(processState)}; memory events: ${memoryEvents}\nServer log: ${log}\nDaemon log: ${daemonLog.slice(-24000)}`,
      { cause: error },
    );
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill(signal.aborted ? "SIGKILL" : "SIGTERM");
      await exited;
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
