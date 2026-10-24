import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { request } from "node:https";
import Database from "better-sqlite3";

export async function verifyUserDeployment({
  launch,
  command,
  signal,
  password,
}) {
  const origin = "https://127.0.0.1:8080";
  const directory = "/tmp/bb-test-certificates";
  await mkdir(directory, { mode: 0o700 });
  const openssl = (...args) =>
    promisify(execFile)("openssl", args, { cwd: directory, signal });
  await openssl(
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-days",
    "1",
    "-subj",
    "/CN=BB deployment test CA",
  );
  for (const name of ["server", "alice", "bob"]) {
    await openssl(
      "req",
      "-new",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
      "-subj",
      `/CN=${name}`,
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-addext",
      `extendedKeyUsage=${name === "server" ? "serverAuth" : "clientAuth"}`,
    );
    await openssl(
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      `${name}.crt`,
      "-days",
      "1",
      "-copy_extensions",
      "copy",
    );
  }
  await command(
    [
      "configure.mjs",
      "--data-dir",
      "/tmp/bb-personal-config",
      "--origin",
      origin,
      "--login",
      "operator",
      "--users-root",
      "/srv/agent-users",
      "--tls-key",
      `${directory}/server.key`,
      "--tls-cert",
      `${directory}/server.crt`,
      "--client-ca",
      `${directory}/ca.crt`,
    ],
    password,
  );
  await writeFile(
    "/srv/bb/control-plane.json",
    await readFile("/tmp/bb-personal-config/control-plane.json"),
    {
      mode: 0o600,
    },
  );
  const ca = await readFile(`${directory}/ca.crt`);
  const send = async (path, { user, body, headers = {} } = {}) => {
    const key = user ? await readFile(`${directory}/${user}.key`) : undefined;
    const cert = user ? await readFile(`${directory}/${user}.crt`) : undefined;
    return new Promise((complete, reject) => {
      const req = request(
        `${origin}${path}`,
        {
          ca,
          key,
          cert,
          signal,
          method: body ? "POST" : "GET",
          headers: {
            ...(body && typeof body !== "string"
              ? { "content-type": "application/json" }
              : {}),
            ...headers,
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8").on("data", (part) => (text += part));
          res.once("end", () => complete({ status: res.statusCode, text }));
        },
      );
      req.once("error", reject);
      req.end(
        body
          ? typeof body === "string"
            ? body
            : JSON.stringify(body)
          : undefined,
      );
    });
  };
  const start = async () => {
    const child = launch(["apps/server/dist/index.js"], {
      env: { ...process.env, BB_APP_URL: origin },
    });
    let log = "";
    child.stdout.on("data", (data) => (log = (log + data).slice(-8000)));
    child.stderr.on("data", (data) => (log = (log + data).slice(-8000)));
    while (!signal.aborted) {
      assert.equal(child.exitCode, null, log);
      try {
        if ((await send("/health")).status === 200) return child;
      } catch {}
      await new Promise((complete) => setTimeout(complete, 100));
    }
    throw new Error("TLS server startup timed out");
  };
  const approve = async (path, user) => {
    assert.equal(
      (
        await send(path, {
          headers: { "x-user-id": user, "x-ssl-client-s-dn": `CN=${user}` },
        })
      ).status,
      401,
    );
    const page = await send(path, { user });
    assert.equal(page.status, 200);
    const csrf = page.text.match(/name="csrf" value="([^"]+)"/u)?.[1];
    assert.ok(csrf);
    assert.equal(
      (
        await send(path, {
          user: user === "alice" ? "bob" : "alice",
          body: new URLSearchParams({ csrf, decision: "approve" }).toString(),
          headers: {
            origin,
            "content-type": "application/x-www-form-urlencoded",
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await send(path, {
          user,
          body: new URLSearchParams({ csrf, decision: "approve" }).toString(),
          headers: {
            origin,
            "content-type": "application/x-www-form-urlencoded",
          },
        })
      ).status,
      200,
    );
  };
  let server = await start();
  try {
    const env = {
      ...process.env,
      HOME: "/tmp/bb-personal-client",
      BB_SERVER_URL: origin,
      BB_CLI: "",
      BB_CLI_ERROR_LOG: "0",
      NODE_EXTRA_CA_CERTS: `${directory}/ca.crt`,
    };
    const cli = ["apps/cli/dist/index.js", "server", "access"];
    const child = launch([...cli, "authorize"], { env });
    const completed = once(child, "exit", { signal });
    let output = "";
    let error = "";
    child.stderr.on("data", (data) => (error += data));
    const authorizationUrl = await new Promise((complete, reject) => {
      child.stdout.on("data", (data) => {
        output += data;
        const url = output.match(
          /https:\/\/127\.0\.0\.1:8080\/control-plane\/auth\/authorize\/[0-9a-f-]{36}/u,
        )?.[0];
        if (url) complete(url);
      });
      child.once("exit", () =>
        reject(new Error(error || "CLI exited before authorization")),
      );
      signal.addEventListener(
        "abort",
        () => reject(new Error("Authorization timed out")),
        { once: true },
      );
    });
    await approve(new URL(authorizationUrl).pathname, "alice");
    assert.equal((await completed)[0], 0, error);
    assert.doesNotMatch(output, /agt_[A-Za-z0-9_-]{43}/u);
    assert.match(await command([...cli, "status"], "", { env }), /alice/);
    const sessionDirectory = `${env.HOME}/.bb/server-access`;
    const session = JSON.parse(
      await readFile(
        `${sessionDirectory}/${(await readdir(sessionDirectory))[0]}`,
        "utf8",
      ),
    );
    const aliceHeaders = { authorization: `Bearer ${session.token}` };
    assert.equal(
      (await send("/api/v1/projects", { headers: aliceHeaders })).status,
      401,
    );
    const verifier = randomBytes(32).toString("base64url");
    const flowResponse = await send("/control-plane/auth/start", {
      body: {
        clientName: "Bob deployment client",
        challenge: createHash("sha256").update(verifier).digest("base64url"),
      },
    });
    assert.equal(flowResponse.status, 200);
    const flow = JSON.parse(flowResponse.text);
    await approve(new URL(flow.authorizationUrl).pathname, "bob");
    assert.equal(
      (
        await send("/control-plane/auth/exchange", {
          body: {
            flowId: flow.flowId,
            verifier: randomBytes(32).toString("base64url"),
          },
        })
      ).status,
      403,
    );
    const exchanged = await send("/control-plane/auth/exchange", {
      body: { flowId: flow.flowId, verifier },
    });
    assert.equal(exchanged.status, 200);
    const bobToken = JSON.parse(exchanged.text).accessToken;
    assert.equal(
      (
        await send("/control-plane/auth/exchange", {
          body: { flowId: flow.flowId, verifier },
        })
      ).status,
      409,
    );
    const db = new Database("/srv/bb/bb.db");
    try {
      const users = db
        .prepare("SELECT * FROM control_plane_users ORDER BY uid")
        .all();
      assert.deepEqual(
        users.map((user) => [user.login, user.uid]),
        [
          ["alice", 200000],
          ["bob", 200001],
        ],
      );
      for (const user of users)
        assert.equal(user.home, `/srv/agent-users/${user.id}/home`);
      assert.equal(
        db
          .prepare(
            "SELECT digest FROM control_plane_user_sessions WHERE digest=?",
          )
          .get(session.token),
        undefined,
      );
      server.kill("SIGTERM");
      await once(server, "exit", { signal });
      server = await start();
      assert.equal(
        (await send("/control-plane/user", { headers: aliceHeaders })).status,
        200,
      );
      assert.equal(
        (
          await send("/control-plane/user", {
            headers: { authorization: `Bearer ${bobToken}` },
          })
        ).status,
        200,
      );
      assert.equal(
        db.prepare("SELECT count(*) AS value FROM control_plane_users").get()
          .value,
        2,
      );
      db.prepare(
        "UPDATE control_plane_users SET enabled=0 WHERE login='bob'",
      ).run();
      assert.equal(
        (
          await send("/control-plane/user", {
            headers: { authorization: `Bearer ${bobToken}` },
          })
        ).status,
        401,
      );
      await command([...cli, "logout"], "", { env });
      assert.equal(
        (await send("/control-plane/user", { headers: aliceHeaders })).status,
        401,
      );
    } finally {
      db.close();
    }
    return {
      certificatePkce: true,
      realUserCli: true,
      distinctUserUidHomes: true,
      persistedUserSessions: true,
      revokedUserDenied: true,
      userCannotUseRawBbApi: true,
    };
  } finally {
    server.kill("SIGTERM");
    if (server.exitCode === null) await once(server, "exit", { signal });
  }
}
