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
        assert.equal(shared.body.connections[0].readiness, "configured");
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
            enabled: true,
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
        projectMcpActivationExplicitlyUnavailable: true,
      };
    },
    async afterRestart({ send, token }) {
      for (const subject of subjects) {
        await resolve(subject);
        const list = await cli(subject, ["connections", subject.projectId]);
        assert.equal(list.connections[0].readiness, "configured");
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
      assert.equal(response.body.connections[0].readiness, "access_denied");
      return {
        projectMcpEncryptedCredentialsSurviveRestart: true,
        projectMcpRevocationDoesNotAffectOtherUser: true,
      };
    },
  };
}
