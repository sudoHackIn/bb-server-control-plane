import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import Database from "better-sqlite3";

const exec = promisify(execFile);
export function createProjectMcpFixture({ db, users, config }) {
  let connector;
  const subjects = [];
  const remoteCalls = [];
  const modelCalls = new Set();
  const remoteThreads = [];
  let remoteConnector;
  const remoteToken = (subject) =>
    "remote-private-" + subject.user.login + "-fixture";
  const handleRemote = (req, res, body) => {
    if (req.url !== "/mcp") return false;
    const subject = subjects.find(
      (entry) => req.headers.authorization === `Bearer ${remoteToken(entry)}`,
    );
    if (!subject) {
      res.writeHead(401).end();
      return true;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return true;
    }
    if (body.id === undefined) {
      res.writeHead(202).end();
      return true;
    }
    let result;
    if (body.method === "initialize")
      result = {
        protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "remote-fixture", version: "1.0.0" },
      };
    else if (body.method === "tools/list")
      result = {
        tools: [
          {
            name: "lookup",
            description: "Personal lookup",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
          {
            name: "forbidden",
            description: "Must not be offered",
            inputSchema: { type: "object" },
          },
        ],
      };
    else if (body.method === "tools/call") {
      assert.equal(body.params.name, "lookup");
      assert.equal(body.params.arguments.value, subject.user.login);
      remoteCalls.push(subject.user.login);
      result = {
        content: [
          { type: "text", text: "REMOTE_MCP_ACTOR_" + subject.user.login },
        ],
      };
    } else {
      res.writeHead(400).end();
      return true;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    return true;
  };
  const handleModel = (body, res) => {
    const markers = [
      ...JSON.stringify(body.messages).matchAll(
        /BB_REMOTE_MCP_(alice|bob)_(first|resume|shared)/gu,
      ),
    ];
    const marker = markers.at(-1);
    if (!marker || !body.tools?.length) return false;
    const tool = body.tools.find((entry) =>
      /^mcp__bb__project_mcp_[a-f0-9]{40}$/u.test(entry.function?.name),
    );
    assert.ok(
      tool,
      "Native Qwen did not receive project MCP tool: " +
        JSON.stringify(body.tools.map((entry) => entry.function?.name)),
    );
    assert.equal(
      body.tools.filter((entry) =>
        entry.function?.name.startsWith("mcp__bb__project_mcp_"),
      ).length,
      1,
    );
    assert.equal(JSON.stringify(body).includes("remote-private-"), false);
    const first = !modelCalls.has(marker[0]);
    modelCalls.add(marker[0]);
    if (!first) {
      assert.ok(
        body.messages.some(
          (message) =>
            message.role === "tool" &&
            JSON.stringify(message.content).includes(
              "REMOTE_MCP_ACTOR_" + marker[1],
            ),
        ),
        "Missing real remote MCP result in Qwen history",
      );
      assert.ok(remoteCalls.includes(marker[1]));
    }
    const delta = first
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "remote_" + marker[1] + "_" + marker[2],
              type: "function",
              function: {
                name: tool.function.name,
                arguments: JSON.stringify({ value: marker[1] }),
              },
            },
          ],
        }
      : {
          role: "assistant",
          content: "Remote MCP completed " + marker[1] + " " + marker[2],
        };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: "remote_fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "remote_fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
    return true;
  };
  const completed = async (entry, wait) => {
    await wait(() => {
      const status = db
        .prepare("SELECT status FROM threads WHERE id=?")
        .get(entry.threadId)?.status;
      if (status === "error")
        throw new Error(
          "Remote MCP native thread failed: " +
            JSON.stringify(
              db
                .prepare(
                  "SELECT data FROM events WHERE thread_id=? ORDER BY sequence DESC LIMIT 8",
                )
                .all(entry.threadId),
            ),
        );
      return status === "idle";
    }, "native remote MCP " + entry.subject.user.login);
    const timeline = JSON.stringify(
      db
        .prepare("SELECT data FROM events WHERE thread_id=?")
        .all(entry.threadId),
    );
    assert.ok(
      timeline.includes("REMOTE_MCP_ACTOR_" + entry.subject.user.login),
    );
    assert.equal(timeline.includes("remote-private-"), false);
  };
  const cli = async (identity, args, body, expectedFailure = false) => {
    const home = "/tmp/bb-mcp-client-" + identity.user.login;
    const origin = config.publicOrigin;
    const directory = home + "/.bb/server-access";
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      directory +
        "/" +
        createHash("sha256").update(origin).digest("hex") +
        ".json",
      JSON.stringify({
        origin,
        token: identity.token,
        expiresAt: Date.now() + 3600000,
      }),
      { mode: 0o600 },
    );
    const child = spawn(
      process.execPath,
      ["apps/cli/dist/index.js", "server", "access", "mcp", ...args],
      {
        env: {
          ...process.env,
          HOME: home,
          BB_SERVER_URL: origin,
          BB_CLI: "",
          BB_CLI_ERROR_LOG: "0",
          NODE_EXTRA_CA_CERTS: config.users.tls.clientCaFile,
        },
        stdio: "pipe",
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (part) => {
      stdout += part;
      if (stdout.length > 1048576) child.kill();
    });
    child.stderr.setEncoding("utf8").on("data", (part) => {
      stderr += part;
      if (stderr.length > 1048576) child.kill();
    });
    const done = once(child, "exit");
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdin.end(
      typeof body === "string" ? body : body ? JSON.stringify(body) : "",
    );
    let code;
    try {
      [code] = await done;
    } finally {
      clearTimeout(timer);
    }
    for (const identity of subjects)
      assert.equal(
        (stdout + stderr).includes(identity.secret),
        false,
        "Credential appeared in CLI output",
      );
    if (expectedFailure) {
      assert.notEqual(code, 0, "Malformed secret input was accepted");
      assert.ok(stderr.includes("Invalid MCP JSON input"));
      return { rejected: true };
    }
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout);
  };
  const resolve = async (subject) => {
    const result = await exec(
      "/usr/bin/setpriv",
      [
        "--reuid=1000",
        "--regid=1000",
        "--clear-groups",
        "--no-new-privs",
        "--",
        process.execPath,
        "mcp-credential-check.mjs",
        JSON.stringify({
          userId: subject.user.id,
          connectorId: connector.id,
          connectorRevision: 1,
          digest: createHash("sha256").update(subject.secret).digest("hex"),
        }),
      ],
      { timeout: 15000, maxBuffer: 65536 },
    );
    assert.equal(JSON.parse(result.stdout).verified, true);
  };
  return {
    handleRemote,
    handleModel,
    async verifyRuntime({ send, token, created, wait }) {
      const response = await send(
        "/control-plane/admin/mcp/connectors",
        {
          slug: "remote",
          name: "Remote runtime fixture",
          endpoint: "http://127.0.0.1:38888/mcp",
        },
        token,
      );
      assert.equal(response.status, 201, JSON.stringify(response.body));
      remoteConnector = response.body;
      for (const [index, subject] of subjects.entries()) {
        assert.equal(
          (
            await send(
              `/control-plane/admin/mcp/connectors/${remoteConnector.id}/access/${subject.user.id}`,
              { allowed: true },
              token,
              "PUT",
            )
          ).status,
          200,
        );
        const credential = await send(
          `/control-plane/user/mcp/connectors/${remoteConnector.id}/credential`,
          {
            token: remoteToken(subject),
            connectorRevision: 1,
            expectedRevision: 0,
          },
          subject.token,
          "PUT",
        );
        assert.equal(credential.status, 200, JSON.stringify(credential.body));
        const connection = await cli(
          subject,
          ["configure", subject.projectId, "--connection-stdin"],
          {
            connectorId: remoteConnector.id,
            connectorRevision: 1,
            expectedRevision: 0,
            enabled: true,
          },
        );
        assert.equal(connection.executionState, "enabled");
        const profile = await send(
          "/control-plane/admin/profiles",
          {
            slug: "remote-" + subject.user.login,
            name: "Remote " + subject.user.login,
            definition: {
              prompt: "Remote MCP fixture",
              providerId: "qwen-server",
              model: "qwen-job-test",
              reasoningLevel: "none",
              permissionMode: "full",
              tools: ["mcp:remote:lookup"],
              mcpServers: ["project"],
            },
          },
          token,
        );
        assert.equal(profile.status, 201, JSON.stringify(profile.body));
        subject.remoteProfileVersionId = profile.body.version.id;
        assert.equal(
          (
            await send(
              `/control-plane/admin/profiles/${profile.body.profile.id}/access/${subject.user.id}`,
              { allowed: true },
              token,
              "PUT",
            )
          ).status,
          200,
        );
        const result = await send(
          "/api/v1/threads",
          {
            ...created[index].threadInput,
            controlPlaneProfileVersionId: profile.body.version.id,
            title: "Remote MCP " + subject.user.login,
            input: [
              {
                type: "text",
                text: "BB_REMOTE_MCP_" + subject.user.login + "_first",
                mentions: [],
              },
            ],
          },
          token,
        );
        assert.equal(result.status, 201, JSON.stringify(result.body));
        const entry = { subject, threadId: result.body.id };
        remoteThreads.push(entry);
        await completed(entry, wait);
        assert.equal(
          remoteCalls.filter((actor) => actor === subject.user.login).length,
          1,
        );
        const row = db
          .prepare(
            "SELECT qwen_session_id FROM control_plane_threads WHERE thread_id=?",
          )
          .get(entry.threadId);
        entry.sessionId = row.qwen_session_id;
        const released = await send(
          `/api/v1/threads/${entry.threadId}/stop`,
          {},
          token,
        );
        assert.equal(released.status, 200, JSON.stringify(released.body));
        assert.equal(
          db
            .prepare(
              "SELECT qwen_session_id FROM control_plane_threads WHERE thread_id=?",
            )
            .get(entry.threadId).qwen_session_id,
          entry.sessionId,
        );
      }
      if (process.env.BB_CONTROL_PLANE_BROWSER_TEST === "1") {
        const browser = await send(
          "/control-plane/admin/mcp/connectors",
          {
            slug: "browser",
            name: "Browser integration",
            endpoint: "https://mcp.example.invalid/browser",
          },
          token,
        );
        assert.equal(browser.status, 201);
        for (const user of users)
          assert.equal(
            (
              await send(
                `/control-plane/admin/mcp/connectors/${browser.body.id}/access/${user.id}`,
                { allowed: true },
                token,
                "PUT",
              )
            ).status,
            200,
          );
      }
      return {
        projectMcpIdleRuntimeReleasedWithSessionRetained: true,
        projectMcpNativeQwenRoundTrip: true,
        projectMcpNativePersonalCredentials: true,
        projectMcpProfileToolSelection: true,
        projectMcpSecretsAbsentFromNativeTimeline: true,
      };
    },
    async verifySharedRuntime({ send, wait, projectId }) {
      const alice = subjects.find((subject) => subject.user.login === "alice");
      const bob = subjects.find((subject) => subject.user.login === "bob");
      if (!alice?.remoteProfileVersionId || !bob || bob.projectId !== projectId)
        throw new Error("Missing shared project MCP fixture");
      const beforeAlice = remoteCalls.filter(
        (actor) => actor === "alice",
      ).length;
      const beforeBob = remoteCalls.filter((actor) => actor === "bob").length;
      const started = await send(
        "/control-plane/user/threads",
        {
          projectId,
          profileVersionId: alice.remoteProfileVersionId,
          message: "BB_REMOTE_MCP_alice_shared",
        },
        alice.token,
      );
      assert.equal(started.status, 201, JSON.stringify(started.body));
      await completed({ subject: alice, threadId: started.body.id }, wait);
      assert.equal(
        remoteCalls.filter((actor) => actor === "alice").length,
        beforeAlice + 1,
      );
      assert.equal(
        remoteCalls.filter((actor) => actor === "bob").length,
        beforeBob,
      );
      const owner = db
        .prepare(
          "SELECT owner_user_id FROM control_plane_threads WHERE thread_id=?",
        )
        .get(started.body.id);
      assert.equal(owner.owner_user_id, alice.user.id);
      assert.equal(
        (
          await send(
            `/control-plane/user/threads/${started.body.id}`,
            undefined,
            bob.token,
          )
        ).status,
        404,
      );
      return {
        sharedProjectMcpUsesRunnerCredentialAndKeepsThreadPrivate: true,
      };
    },
    async resumeRuntime({ send, token, wait }) {
      const entry = remoteThreads[1];
      const result = await send(
        `/api/v1/threads/${entry.threadId}/send`,
        {
          mode: "start",
          input: [
            { type: "text", text: "BB_REMOTE_MCP_bob_resume", mentions: [] },
          ],
        },
        token,
      );
      assert.equal(result.status, 200, JSON.stringify(result.body));
      await completed(entry, wait);
      assert.equal(remoteCalls.filter((actor) => actor === "bob").length, 2);
      assert.equal(
        db
          .prepare(
            "SELECT qwen_session_id FROM control_plane_threads WHERE thread_id=?",
          )
          .get(entry.threadId).qwen_session_id,
        entry.sessionId,
      );
      return { projectMcpNativeResumeAfterRestart: true };
    },
    async verify({ send, token }) {
      const guide = await exec(
        process.execPath,
        ["apps/cli/dist/index.js", "guide", "machines"],
        {
          env: { ...process.env, BB_CLI: "", BB_CLI_ERROR_LOG: "0" },
          timeout: 15000,
          maxBuffer: 1048576,
        },
      );
      assert.ok(
        guide.stdout.includes("bb server access mcp") &&
          guide.stdout.includes("mcp get"),
        "Built CLI guide omitted MCP commands",
      );
      const created = await send(
        "/control-plane/admin/mcp/connectors",
        {
          slug: "jira",
          name: "Jira fixture",
          endpoint: "https://mcp.example.invalid/jira",
        },
        token,
      );
      assert.equal(created.status, 201, JSON.stringify(created.body));
      connector = created.body;
      const writer = new Database("/srv/bb/bb.db");
      try {
        for (const user of users) {
          const personalToken = "agt_" + randomBytes(32).toString("base64url");
          writer
            .prepare(
              "INSERT INTO control_plane_user_sessions (digest,user_id,expires_at) VALUES (?,?,?)",
            )
            .run(
              createHash("sha256").update(personalToken).digest("hex"),
              user.id,
              Date.now() + 3600000,
            );
          const project = db
            .prepare(
              "SELECT project_id FROM control_plane_projects WHERE owner_user_id=? AND slug='app'",
            )
            .get(user.id);
          const subject = {
            user,
            token: personalToken,
            projectId: project.project_id,
            secret: "mcp-private-" + user.login + "-fixture",
          };
          subjects.push(subject);
          const grant = await send(
            `/control-plane/admin/mcp/connectors/${connector.id}/access/${user.id}`,
            { allowed: true },
            token,
            "PUT",
          );
          assert.equal(grant.status, 200);
          await cli(
            subject,
            ["credential-set", connector.id, "--credential-stdin"],
            subject.secret,
            true,
          );
          const listed = await cli(subject, ["list"]);
          assert.equal(listed.connectors[0].id, connector.id);
          assert.equal(
            (await cli(subject, ["get", connector.id])).id,
            connector.id,
          );
          const metadata = await cli(
            subject,
            ["credential-set", connector.id, "--credential-stdin"],
            {
              connectorRevision: 1,
              expectedRevision: 0,
              token: subject.secret,
            },
          );
          assert.equal(metadata.configured, true);
          await resolve(subject);
          const connection = await cli(
            subject,
            ["configure", subject.projectId, "--connection-stdin"],
            {
              connectorId: connector.id,
              connectorRevision: 1,
              expectedRevision: 0,
            },
          );
          assert.equal(connection.enabled, false);
          assert.equal(connection.executionState, "not_activated");
          assert.equal(connection.readiness, "configured");
        }
        const [alice, bob] = subjects;
        writer
          .prepare(
            "INSERT INTO control_plane_project_access (project_id,user_id,role) VALUES (?,?,?)",
          )
          .run(alice.projectId, bob.user.id, "viewer");
        const shared = await send(
          `/control-plane/user/projects/${alice.projectId}/mcp`,
          undefined,
          bob.token,
        );
        assert.equal(shared.status, 200);
        assert.equal(
          shared.body.connections.find(
            (row) => row.connectorId === connector.id,
          )?.readiness,
          "configured",
        );
        const denied = await send(
          `/control-plane/user/projects/${alice.projectId}/mcp`,
          {
            connectorId: connector.id,
            connectorRevision: 1,
            expectedRevision: 1,
          },
          bob.token,
          "PUT",
        );
        assert.equal(denied.status, 403);
        writer
          .prepare(
            "DELETE FROM control_plane_project_access WHERE project_id=? AND user_id=?",
          )
          .run(alice.projectId, bob.user.id);
      } finally {
        writer.close();
      }
      for (const subject of subjects) {
        const row = db
          .prepare(
            "SELECT ciphertext FROM control_plane_mcp_credentials WHERE connector_id=? AND user_id=?",
          )
          .get(connector.id, subject.user.id);
        assert.equal(row.ciphertext.includes(subject.secret), false);
        const foreign = await send(
          `/control-plane/user/mcp/connectors/${connector.id}/credential`,
          {
            connectorRevision: 1,
            expectedRevision: 1,
            token: "spoof",
            userId: subjects.find((row) => row !== subject).user.id,
          },
          subject.token,
          "PUT",
        );
        assert.equal(foreign.status, 400);
        const activation = await send(
          `/control-plane/user/projects/${subject.projectId}/mcp`,
          {
            connectorId: connector.id,
            connectorRevision: 1,
            expectedRevision: 1,
            command: "/bin/sh",
          },
          subject.token,
          "PUT",
        );
        assert.equal(activation.status, 400);
        const raw = await send("/api/v1/projects", undefined, subject.token);
        assert.equal(raw.status, 401);
      }
      return {
        projectMcpCatalogAndCredentialCli: true,
        projectMcpBuiltCliGuideVerified: true,
        projectMcpMalformedSecretInputNotLogged: true,
        projectMcpSecretsEncryptedAndIdentityBound: true,
        projectMcpSharedMetadataUsesOwnCredentials: true,
        projectMcpForeignMutationDenied: true,
        projectMcpUnsupportedConnectionFieldsRejected: true,
      };
    },
    async afterRestart({ send, token }) {
      for (const subject of subjects) {
        await resolve(subject);
        const list = await cli(subject, ["connections", subject.projectId]);
        assert.equal(
          list.connections.find((row) => row.connectorId === connector.id)
            ?.readiness,
          "configured",
        );
      }
      const [alice, bob] = subjects;
      const revoked = await cli(alice, [
        "credential-revoke",
        connector.id,
        "--revision",
        "1",
      ]);
      assert.equal(revoked.revision, 2);
      assert.equal(revoked.configured, false);
      await resolve(bob);
      const grant = await send(
        `/control-plane/admin/mcp/connectors/${connector.id}/access/${alice.user.id}`,
        { allowed: false },
        token,
        "PUT",
      );
      assert.equal(grant.status, 200);
      const denied = await send(
        `/control-plane/user/mcp/connectors/${connector.id}/credential`,
        { token: "rejected", connectorRevision: 1, expectedRevision: 2 },
        alice.token,
        "PUT",
      );
      assert.equal(denied.status, 404);
      const response = await send(
        `/control-plane/user/projects/${alice.projectId}/mcp`,
        undefined,
        alice.token,
      );
      assert.equal(
        response.body.connections.find(
          (row) => row.connectorId === connector.id,
        )?.readiness,
        "access_denied",
      );
      return {
        projectMcpEncryptedCredentialsSurviveRestart: true,
        projectMcpRevocationDoesNotAffectOtherUser: true,
      };
    },
  };
}
