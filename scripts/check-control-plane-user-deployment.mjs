import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { chown, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
  for (const name of await readdir(directory))
    await chown(`${directory}/${name}`, 1000, 1000);
  await chown(directory, 1000, 1000);
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
  const send = async (path, { user, body, method, headers = {} } = {}) => {
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
          method: method ?? (body ? "POST" : "GET"),
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
          res.once("end", () =>
            complete({ status: res.statusCode, text, headers: res.headers }),
          );
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
      env: { ...process.env, HOME: "/home/node", BB_APP_URL: origin },
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
  let browserVerification;
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
    const child = launch([...cli, "authorize", "--json"], { env });
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
    const authorizationEvents = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      authorizationEvents.map((event) => event.status),
      ["pending", "authorized"],
    );
    assert.equal(authorizationEvents[1].role, "user");
    assert.equal(
      JSON.parse(await command([...cli, "status", "--json"], "", { env })).user
        .login,
      "alice",
    );
    assert.match(await command([...cli, "status"], "", { env }), /alice/);
    assert.equal(
      JSON.parse(
        await command([...cli, "environment", "--provision"], "", { env }),
      ).status,
      "ready",
    );
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
        await send("/control-plane/user/environment", {
          headers: { authorization: `Bearer ${bobToken}` },
          body: {},
        })
      ).status,
      200,
    );
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
      for (const user of users) {
        const other = users.find((candidate) => candidate.id !== user.id);
        const result = JSON.parse(
          await command(
            [
              `--reuid=${user.uid}`,
              `--regid=${user.gid}`,
              "--clear-groups",
              "--no-new-privs",
              "--",
              process.execPath,
              "-e",
              `
            const fs = require("node:fs");
            const assert = require("node:assert/strict");
            const [home, otherHome, project] = process.argv.slice(1);
            assert.equal(process.getuid(), Number(process.env.EXPECTED_UID));
            assert.deepEqual(process.getgroups(), [process.getgid()]);
            fs.writeFileSync(home + "/private-probe", "private");
            fs.writeFileSync(project + "/project-probe", "project");
            assert.equal(fs.readFileSync(home + "/private-probe", "utf8"), "private");
            assert.throws(() => fs.readdirSync(otherHome), (error) => error.code === "EACCES");
            assert.throws(() => fs.readdirSync("/srv/agent-users"), (error) => error.code === "EACCES");
            assert.throws(() => fs.readdirSync(otherHome.replace(/home$/, "projects/default")), (error) => error.code === "EACCES");
            assert.throws(() => fs.readFileSync("/srv/bb/bb.db"), (error) => error.code === "EACCES");
            assert.throws(() => fs.readdirSync("/var/lib/bb-agent-launcher"), (error) => error.code === "EACCES");
            console.log(JSON.stringify({ uid: process.getuid(), homeWritable: true, projectWritable: true, foreignHomeDenied: true, serviceDataDenied: true }));
          `,
              user.home,
              other.home,
              `${user.projects_root}/default`,
            ],
            "",
            {
              file: "/usr/bin/setpriv",
              uid: 0,
              gid: 0,
              env: {
                ...process.env,
                HOME: user.home,
                EXPECTED_UID: String(user.uid),
              },
            },
          ),
        );
        assert.equal(result.uid, user.uid);
      }
      const alice = users[0];
      const bob = users[1];
      const adminEnv = { ...env, HOME: "/tmp/bb-profile-admin" };
      const adminCliSession = JSON.parse(
        await command(
          [
            ...cli,
            "login",
            "--login",
            "operator",
            "--password-stdin",
            "--json",
          ],
          password,
          { env: adminEnv },
        ),
      );
      assert.equal(adminCliSession.role, "admin");
      assert.deepEqual(Object.keys(adminCliSession).sort(), [
        "expiresAt",
        "login",
        "role",
      ]);
      const adminProfiles = (args, input = "") =>
        command([...cli, "profiles", ...args], input, { env: adminEnv });
      const definition = {
        prompt: "Approved review instructions",
        providerId: "qwen-server",
        model: "catalog-test-model",
        reasoningLevel: "none",
        permissionMode: "full",
        tools: ["read_file"],
        mcpServers: ["approved-mcp"],
      };
      const profile = JSON.parse(
        await adminProfiles(
          ["create", "review", "--name", "Review", "--definition-stdin"],
          JSON.stringify(definition),
        ),
      );
      assert.equal(profile.version.version, 1);
      assert.deepEqual(
        JSON.parse(await command([...cli, "profiles", "list"], "", { env }))
          .profiles,
        [],
      );
      await adminProfiles(["grant", profile.profile.id, alice.id]);
      assert.equal(
        JSON.parse(
          await command([...cli, "profiles", "get", profile.profile.id], "", {
            env,
          }),
        ).version.id,
        profile.version.id,
      );
      await assert.rejects(
        command([...cli, "profiles", "grant", profile.profile.id, bob.id], "", {
          env,
        }),
        /401/u,
      );
      assert.equal(
        (
          await send(`/control-plane/user/profiles/${profile.profile.id}`, {
            headers: { authorization: `Bearer ${bobToken}` },
          })
        ).status,
        404,
      );
      const revised = JSON.parse(
        await adminProfiles(
          ["publish", profile.profile.id, "--definition-stdin"],
          JSON.stringify({
            ...definition,
            model: "catalog-next-model",
            tools: [],
          }),
        ),
      );
      assert.equal(revised.version.version, 2);
      assert.equal(
        JSON.parse(
          await command(
            [
              ...cli,
              "profiles",
              "get",
              profile.profile.id,
              "--version",
              profile.version.id,
            ],
            "",
            { env },
          ),
        ).version.definition.model,
        definition.model,
      );
      const profilePage = JSON.parse(
        await command(
          [...cli, "profiles", "versions", profile.profile.id, "--limit", "1"],
          "",
          { env },
        ),
      );
      assert.equal(profilePage.nextCursor, 2);
      assert.equal(
        JSON.parse(
          await command(
            [
              ...cli,
              "profiles",
              "versions",
              profile.profile.id,
              "--cursor",
              "2",
            ],
            "",
            { env },
          ),
        ).versions[0].version,
        1,
      );
      await adminProfiles([
        "disable",
        profile.profile.id,
        "--version",
        revised.version.id,
      ]);
      assert.equal(
        JSON.parse(
          await command([...cli, "profiles", "get", profile.profile.id], "", {
            env,
          }),
        ).version.version,
        1,
      );
      assert.equal(
        (
          await send(
            `/control-plane/user/profiles/${profile.profile.id}/versions/${revised.version.id}`,
            { headers: aliceHeaders },
          )
        ).status,
        404,
      );
      await adminProfiles([
        "enable",
        profile.profile.id,
        "--version",
        revised.version.id,
      ]);
      await adminProfiles(["disable", profile.profile.id]);
      assert.equal(
        (
          await send(`/control-plane/user/profiles/${profile.profile.id}`, {
            headers: aliceHeaders,
          })
        ).status,
        404,
      );
      await adminProfiles(["enable", profile.profile.id]);
      assert.deepEqual(
        JSON.parse(
          await adminProfiles(["access", profile.profile.id]),
        ).users.map((user) => user.userId),
        [alice.id],
      );
      const projectHostId = "host_control_plane_deployment";
      db.prepare(
        "INSERT INTO hosts(id,name,type,created_at,updated_at) VALUES(?,?,?,?,?)",
      ).run(
        projectHostId,
        "Offline project fixture",
        "persistent",
        Date.now(),
        Date.now(),
      );
      await writeFile("/srv/bb/host-id", projectHostId + "\n", { mode: 0o600 });
      await chown("/srv/bb/host-id", 1000, 1000);
      const aliceProject = JSON.parse(
        await command(
          [...cli, "projects", "create", "app", "--name", "Alice app"],
          "",
          { env },
        ),
      );
      assert.equal(aliceProject.cwd, `${alice.projects_root}/app`);
      assert.equal(aliceProject.hostId, projectHostId);
      assert.equal(
        JSON.parse(
          await command(
            [...cli, "projects", "create", "app", "--name", "Alice app"],
            "",
            { env },
          ),
        ).projectId,
        aliceProject.projectId,
      );
      const bobHeaders = { authorization: `Bearer ${bobToken}` };
      const bobCreated = await send("/control-plane/user/projects", {
        headers: bobHeaders,
        body: { slug: "app", name: "Bob app" },
      });
      assert.equal(bobCreated.status, 201);
      const bobProject = JSON.parse(bobCreated.text);
      assert.notEqual(bobProject.projectId, aliceProject.projectId);
      assert.equal(bobProject.cwd, `${bob.projects_root}/app`);
      assert.deepEqual(
        JSON.parse(
          await command([...cli, "projects", "list"], "", { env }),
        ).projects.map((project) => project.projectId),
        [aliceProject.projectId],
      );
      assert.equal(
        JSON.parse(
          await command(
            [...cli, "projects", "get", aliceProject.projectId],
            "",
            { env },
          ),
        ).projectId,
        aliceProject.projectId,
      );
      const foreign = launch(
        [...cli, "projects", "get", bobProject.projectId],
        { env },
      );
      foreign.stdout.resume();
      let foreignError = "";
      foreign.stderr.on("data", (data) => (foreignError += data));
      assert.notEqual((await once(foreign, "exit", { signal }))[0], 0);
      assert.match(foreignError, /404/u);
      assert.equal(
        (
          await send("/control-plane/user/projects", {
            headers: aliceHeaders,
            body: {
              name: "Forged",
              slug: "other",
              uid: bob.uid,
              hostId: projectHostId,
              cwd: bob.home,
            },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await send("/control-plane/user/projects", {
            headers: aliceHeaders,
            body: { name: "Invalid", slug: "../bob" },
          })
        ).status,
        400,
      );
      const adminLogin = await send("/control-plane/login", {
        body: { login: "operator", password },
      });
      assert.equal(adminLogin.status, 200);
      const native = await send("/api/v1/projects", {
        headers: {
          authorization: `Bearer ${JSON.parse(adminLogin.text).token}`,
        },
      });
      assert.equal(native.status, 200);
      assert.deepEqual(
        JSON.parse(native.text)
          .map((project) => project.id)
          .sort(),
        [aliceProject.projectId, bobProject.projectId].sort(),
      );
      db.prepare(
        "INSERT INTO control_plane_project_access(project_id,user_id,role) VALUES(?,?,?)",
      ).run(aliceProject.projectId, bob.id, "viewer");
      const shared = await send(
        `/control-plane/user/projects/${aliceProject.projectId}`,
        { headers: bobHeaders },
      );
      assert.equal(shared.status, 200);
      assert.equal(JSON.parse(shared.text).canRun, false);
      db.prepare(
        "DELETE FROM control_plane_project_access WHERE project_id=? AND user_id=?",
      ).run(aliceProject.projectId, bob.id);
      assert.equal(
        (
          await send(`/control-plane/user/projects/${aliceProject.projectId}`, {
            headers: bobHeaders,
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await send("/control-plane/user/environment", {
            headers: aliceHeaders,
            body: { uid: bob.uid, home: bob.home },
          })
        ).status,
        400,
      );
      for (const [actor, args] of [
        [1000, ["provision", alice.id, String(bob.uid)]],
        [
          1000,
          [
            "provision",
            "33333333-3333-4333-8333-333333333333",
            String(alice.uid),
          ],
        ],
        [1000, ["launch", alice.id, String(alice.uid)]],
        [alice.uid, ["provision", alice.id, String(alice.uid)]],
      ]) {
        const rejected = launch(
          ["-n", "--", "/opt/bb-control-plane/launcher/helper.py", ...args],
          { file: "/usr/bin/sudo", uid: actor, gid: actor },
        );
        rejected.stdout.resume();
        rejected.stderr.resume();
        assert.notEqual((await once(rejected, "exit", { signal }))[0], 0);
      }
      const browser = await verifyBrowserDeployment({
        send,
        origin,
        password,
        aliceProject,
        bobProject,
      });
      assert.deepEqual(
        JSON.parse(await command([...cli, "browser", "--json"], "", { env })),
        { url: origin + "/control-plane/user/login" },
      );
      const bootstrap = JSON.parse(
        await command([...cli, "bootstrap", "--json"], "", { env }),
      );
      const browserContext = JSON.parse(
        await command([...cli, "browser-context", "--json"], "", { env }),
      );
      assert.equal(browserContext.mode, "user");
      assert.equal(browserContext.identity, bootstrap.session.user.id);

      assert.equal(bootstrap.session.user.login, "alice");
      assert.equal(
        bootstrap.projects.projects.some(
          (project) => project.projectId === bobProject.projectId,
        ),
        false,
      );
      const asAlice = { file: "/usr/bin/setpriv", uid: 0, gid: 0 };
      const aliceCommand = [
        `--reuid=${alice.uid}`,
        `--regid=${alice.gid}`,
        "--clear-groups",
        "--no-new-privs",
        "--",
        process.execPath,
        "-e",
      ];
      await command(
        [
          ...aliceCommand,
          'const fs=require("node:fs");fs.renameSync(process.argv[1]+"/default",process.argv[1]+"/saved-default");fs.symlinkSync(process.argv[2],process.argv[1]+"/default")',
          alice.projects_root,
          bob.home,
        ],
        "",
        asAlice,
      );
      assert.equal(
        (
          await send("/control-plane/user/environment", {
            headers: aliceHeaders,
            body: {},
          })
        ).status,
        503,
      );
      await command(
        [
          ...aliceCommand,
          'const fs=require("node:fs");fs.unlinkSync(process.argv[1]+"/default");fs.renameSync(process.argv[1]+"/saved-default",process.argv[1]+"/default")',
          alice.projects_root,
        ],
        "",
        asAlice,
      );
      assert.equal(
        (
          await send("/control-plane/user/environment", {
            headers: aliceHeaders,
            body: {},
          })
        ).status,
        200,
      );
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
      await browser.afterRestart();
      browserVerification = browser.verification;
      assert.equal(
        (await send("/control-plane/user", { headers: aliceHeaders })).status,
        200,
      );
      assert.equal(
        JSON.parse(
          await command([...cli, "profiles", "get", profile.profile.id], "", {
            env,
          }),
        ).version.version,
        2,
      );
      assert.equal(
        JSON.parse(
          await command(
            [
              ...cli,
              "profiles",
              "get",
              profile.profile.id,
              "--version",
              profile.version.id,
            ],
            "",
            { env },
          ),
        ).version.definition.prompt,
        definition.prompt,
      );
      await command(
        [...cli, "login", "--login", "operator", "--password-stdin"],
        password,
        { env: adminEnv },
      );
      await adminProfiles(["revoke", profile.profile.id, alice.id]);
      assert.deepEqual(
        JSON.parse(await command([...cli, "profiles", "list"], "", { env }))
          .profiles,
        [],
      );
      assert.equal(
        (
          await send(
            `/control-plane/user/profiles/${profile.profile.id}/versions/${profile.version.id}`,
            { headers: aliceHeaders },
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await send(`/control-plane/user/projects/${aliceProject.projectId}`, {
            headers: aliceHeaders,
          })
        ).status,
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
      assert.deepEqual(
        JSON.parse(await command([...cli, "logout", "--json"], "", { env })),
        { ok: true },
      );
      assert.equal(
        (await send("/control-plane/user", { headers: aliceHeaders })).status,
        401,
      );
    } finally {
      db.close();
    }
    return {
      certificatePkce: true,
      ...browserVerification,
      realUserCli: true,
      distinctUserUidHomes: true,
      homeDirectoriesProvisioned: true,
      numericUidFilesystemIsolation: true,
      uidReassignmentDenied: true,
      symlinkReplacementDenied: true,
      persistedUserSessions: true,
      revokedUserDenied: true,
      userCannotUseRawBbApi: true,
      personalNativeProjects: true,
      immutableAgentProfileVersions: true,
      realAdminAndUserProfileCli: true,
      profileGrantAndVersionRevocation: true,
      profileCatalogSurvivesRestart: true,
      foreignProjectIdsDenied: true,
      sharedReadGrantRevocation: true,
      projectHostFixtureOffline: true,
    };
  } finally {
    server.kill("SIGTERM");
    if (server.exitCode === null) await once(server, "exit", { signal });
  }
}

async function verifyBrowserDeployment({
  send,
  origin,
  password,
  aliceProject,
  bobProject,
}) {
  const path = "/control-plane/user/login";
  const cookie = (response, name) => {
    const value = response.headers["set-cookie"]?.find((value) =>
      value.startsWith(name + "="),
    );
    assert.ok(value, "Missing browser credential");
    return { value: value.split(";")[0], attributes: value };
  };
  assert.equal(
    (
      await send(path, {
        headers: { "x-user-id": "alice", "x-ssl-client-s-dn": "CN=alice" },
      })
    ).status,
    403,
  );
  assert.equal((await send(path, { user: "alice" })).status, 200);
  assert.equal(
    (await send(path, { user: "alice", method: "POST" })).status,
    403,
  );
  assert.equal(
    (
      await send(path, {
        user: "alice",
        method: "POST",
        headers: { origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await send(path, {
        user: "alice",
        method: "POST",
        headers: { origin },
        body: { login: "bob" },
      })
    ).status,
    400,
  );
  const operator = await send("/control-plane/login", {
    body: { login: "operator", password },
  });
  const oldAdmin = cookie(operator, "bb_admin_session").value;
  assert.deepEqual(
    JSON.parse((await send("/control-plane/browser-context")).text),
    { mode: "anonymous" },
  );
  const adminContext = JSON.parse(
    (
      await send("/control-plane/browser-context", {
        headers: { cookie: oldAdmin },
      })
    ).text,
  );
  assert.equal(adminContext.mode, "admin");
  assert.equal(adminContext.identity, "operator");
  assert.match(adminContext.cacheEpoch, /^[a-f0-9]{64}$/u);
  assert.equal(
    (
      await send("/api/v1/projects", {
        headers: { cookie: oldAdmin, "x-bb-client-session": "0".repeat(64) },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await send("/api/v1/projects", {
        headers: {
          cookie: oldAdmin,
          "x-bb-client-session": adminContext.cacheEpoch,
        },
      })
    ).status,
    200,
  );

  assert.equal(
    (
      await send("/api/v1/projects", {
        headers: { cookie: oldAdmin, "x-bb-client-identity": "user:stale" },
      })
    ).status,
    403,
  );

  assert.equal(
    (await send("/api/v1/projects", { headers: { cookie: oldAdmin } })).status,
    200,
  );
  const login = await send(path, {
    user: "alice",
    method: "POST",
    headers: { origin, cookie: oldAdmin, authorization: "Bearer unrelated" },
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.location, "/control-plane/app");
  assert.equal(login.headers["clear-site-data"], '"cache", "storage"');
  const alice = cookie(login, "bb_user_session");
  const identity = JSON.parse(
    (await send("/control-plane/user", { headers: { cookie: alice.value } }))
      .text,
  ).user;
  const personalContext = JSON.parse(
    (
      await send("/control-plane/browser-context", {
        headers: { cookie: alice.value },
      })
    ).text,
  );
  assert.equal(personalContext.mode, "user");
  assert.equal(personalContext.identity, identity.id);
  assert.equal(personalContext.login, "alice");
  assert.match(personalContext.cacheEpoch, /^[a-f0-9]{64}$/u);
  assert.equal(
    (
      await send("/control-plane/user/bootstrap", {
        headers: { cookie: alice.value, "x-bb-client-session": "0".repeat(64) },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await send("/control-plane/user/bootstrap", {
        headers: {
          cookie: alice.value,
          "x-bb-client-session": personalContext.cacheEpoch,
        },
      })
    ).status,
    200,
  );

  assert.equal(
    (
      await send("/control-plane/user/bootstrap", {
        headers: {
          cookie: alice.value,
          "x-bb-client-identity": "admin:operator",
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await send("/control-plane/user/bootstrap", {
        headers: {
          cookie: alice.value,
          "x-bb-client-identity": encodeURIComponent(`user:${identity.id}`),
        },
      })
    ).status,
    200,
  );

  for (const flag of [
    "Secure",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=86400",
    "Path=/",
  ])
    assert.ok(alice.attributes.includes(flag));
  assert.equal(login.text.includes("agt_"), false);
  assert.equal(
    (await send("/api/v1/projects", { headers: { cookie: oldAdmin } })).status,
    401,
  );
  for (const path of ["/api/v1/projects", "/api/v1/threads"])
    assert.equal(
      (await send(path, { headers: { cookie: alice.value } })).status,
      401,
    );
  assert.equal(
    (
      await send("/control-plane/user", {
        headers: { cookie: alice.value, authorization: "Bearer invalid" },
      })
    ).status,
    401,
  );
  const shell = await send("/control-plane/app", {
    headers: { cookie: alice.value },
  });
  assert.equal(shell.status, 200);
  assert.match(shell.text, /<div id="root"><\/div>/u);
  assert.ok(
    !shell.headers["content-security-policy"]?.includes("default-src 'none'"),
  );
  for (const path of [
    "/projects/direct-project",
    "/projects/direct-project/threads/direct-thread",
    "/threads/direct-thread",
  ]) {
    const direct = await send(path, { headers: { cookie: alice.value } });
    assert.equal(direct.status, 200);
    assert.equal(direct.text, shell.text);
  }
  const asset = /src="(\/assets\/[^"]+\.js)"/u.exec(shell.text)?.[1];
  assert.ok(asset, "Missing compiled native entry");
  const entry = await send(asset, { headers: { cookie: alice.value } });
  assert.equal(entry.status, 200);
  const personalChunk = /personal-main-[A-Za-z0-9_-]+\.js/u.exec(
    entry.text,
  )?.[0];
  assert.ok(personalChunk, "Missing separate personal entry");
  const personal = await send(`/assets/${personalChunk}`, {
    headers: { cookie: alice.value },
  });
  assert.equal(personal.status, 200);
  assert.ok(personal.text.includes("Your workspace"));
  assert.equal((await send(asset)).status, 401);
  assert.equal(
    (await send("/assets/private.js", { headers: { cookie: alice.value } }))
      .status,
    404,
  );
  assert.equal(
    (
      await send("/plugins/composer/app.js", {
        headers: { cookie: alice.value },
      })
    ).status,
    401,
  );
  const bootstrap = await send("/control-plane/user/bootstrap", {
    headers: { cookie: alice.value },
  });
  assert.equal(bootstrap.status, 200);
  const data = JSON.parse(bootstrap.text);
  assert.equal(data.session.user.login, "alice");
  assert.ok(
    data.projects.projects.some(
      (project) => project.projectId === aliceProject.projectId,
    ),
  );
  assert.equal(
    data.projects.projects.some(
      (project) => project.projectId === bobProject.projectId,
    ),
    false,
  );
  assert.deepEqual(data.capabilities, {
    canCreateProjects: true,
    canInstallPlugins: false,
    canUseTerminals: false,
  });
  assert.equal(
    (
      await send("/control-plane/user/environment", {
        method: "POST",
        headers: { cookie: alice.value },
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await send("/control-plane/user/environment", {
        method: "POST",
        headers: { cookie: alice.value, origin },
        body: {},
      })
    ).status,
    200,
  );
  const bobLogin = await send(path, {
    user: "bob",
    method: "POST",
    headers: { origin, cookie: alice.value },
  });
  const bob = cookie(bobLogin, "bb_user_session").value;
  assert.equal(
    (await send("/control-plane/user", { headers: { cookie: alice.value } }))
      .status,
    401,
  );
  assert.equal(
    JSON.parse(
      (await send("/control-plane/user", { headers: { cookie: bob } })).text,
    ).user.login,
    "bob",
  );
  const administrator = await send("/control-plane/login", {
    body: { login: "operator", password },
    headers: { cookie: bob },
  });
  assert.equal(
    (await send("/control-plane/user", { headers: { cookie: bob } })).status,
    401,
  );
  assert.equal(
    (
      await send("/api/v1/projects", {
        headers: { cookie: cookie(administrator, "bb_admin_session").value },
      })
    ).status,
    200,
  );
  const logoutCookie = cookie(
    await send(path, { user: "alice", method: "POST", headers: { origin } }),
    "bb_user_session",
  ).value;
  assert.equal(
    (
      await send("/control-plane/user/logout", {
        method: "POST",
        headers: { cookie: logoutCookie },
      })
    ).status,
    403,
  );
  const loggedOut = await send("/control-plane/user/logout", {
    method: "POST",
    headers: { cookie: logoutCookie, origin },
  });
  assert.equal(loggedOut.status, 200);
  assert.equal(loggedOut.headers["clear-site-data"], '"cache", "storage"');
  assert.equal(
    (await send("/control-plane/user", { headers: { cookie: logoutCookie } }))
      .status,
    401,
  );
  const persisted = cookie(
    await send(path, { user: "alice", method: "POST", headers: { origin } }),
    "bb_user_session",
  ).value;
  const persistedContext = JSON.parse(
    (
      await send("/control-plane/browser-context", {
        headers: { cookie: persisted },
      })
    ).text,
  );
  assert.notEqual(persistedContext.cacheEpoch, personalContext.cacheEpoch);
  return {
    verification: {
      browserContextAndExpectedIdentityHeader: true,
      personalDeepLinkShellsUseSameProtectedProductionBundle: true,
      browserCacheEpochBoundToCredential: true,
      certificateBrowserSession: true,
      cookieWriteOriginRequired: true,
      browserRoleSwitchRevokesPriorSessions: true,
      personalBrowserBootstrapScoped: true,
      browserLogoutRevokesCredential: true,
      browserSessionSurvivesRestart: true,
      userBrowserCannotUseNativeApiOrPlugins: true,
      personalShellAndCompiledAssets: true,
      realBrowserUrlAndBootstrapCli: true,
    },
    async afterRestart() {
      assert.equal(
        JSON.parse(
          (
            await send("/control-plane/browser-context", {
              headers: { cookie: persisted },
            })
          ).text,
        ).cacheEpoch,
        persistedContext.cacheEpoch,
      );
      assert.equal(
        JSON.parse(
          (
            await send("/control-plane/user", {
              headers: { cookie: persisted },
            })
          ).text,
        ).user.login,
        "alice",
      );
      assert.equal(
        (
          await send("/control-plane/user/bootstrap", {
            headers: { cookie: persisted },
          })
        ).status,
        200,
      );
    },
  };
}
