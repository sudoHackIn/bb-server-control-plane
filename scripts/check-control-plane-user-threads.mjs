import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request } from "node:https";

export function createUserThreadFixture({ db, users }) {
  const calls = new Set();
  let resumed = false;
  let saved;
  const sessions = new Map();
  function handle(body, res) {
    const marker = JSON.stringify(body.messages).match(
      /BB_PERSONAL_([a-z-]+)/u,
    )?.[1];
    if (
      !marker ||
      !body.tools?.some((tool) => tool.function?.name === "run_shell_command")
    )
      return false;
    assert.equal(body.model, "qwen-job-test");
    if (JSON.stringify(body.messages).includes("BB_PERSONAL_alice continue"))
      resumed = JSON.stringify(body.messages).includes(
        "BB_PERSONAL_alice first",
      );
    const first = !calls.has(marker);
    calls.add(marker);
    const code = `const fs=require("node:fs");fs.writeFileSync(process.env.HOME+"/bb-personal-${marker}.json",JSON.stringify({uid:process.getuid(),home:process.env.HOME,cwd:process.cwd()}))`;
    const delta = first
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `personal_${marker}`,
              type: "function",
              function: {
                name: "run_shell_command",
                arguments: JSON.stringify({
                  command: `/usr/local/bin/node -e '${code}'`,
                  description: "Verify personal API identity",
                  timeout: 30000,
                }),
              },
            },
          ],
        }
      : { role: "assistant", content: `Personal ${marker} completed` };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: `personal_${marker}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: `personal_${marker}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
    return true;
  }
  return {
    handle,
    async verify({
      launch,
      signal,
      wait,
      sendAdmin,
      adminToken,
      config,
      diagnostics,
    }) {
      const origin = config.publicOrigin;
      const ca = await readFile("/tmp/bb-test-certificates/ca.crt");
      const send = async (
        path,
        { token, certificate, method = "GET", body, form } = {},
      ) => {
        const key = certificate
          ? await readFile(`/tmp/bb-test-certificates/${certificate}.key`)
          : undefined;
        const cert = certificate
          ? await readFile(`/tmp/bb-test-certificates/${certificate}.crt`)
          : undefined;
        return new Promise((resolve, reject) => {
          const req = request(
            origin + path,
            {
              ca,
              key,
              cert,
              signal,
              method,
              headers: {
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...(body ? { "content-type": "application/json" } : {}),
                ...(form
                  ? {
                      origin,
                      "content-type": "application/x-www-form-urlencoded",
                    }
                  : {}),
              },
            },
            (res) => {
              let text = "";
              res.on("data", (part) => (text += part));
              res.on("error", reject);
              res.on("end", () => {
                let value;
                try {
                  value = JSON.parse(text);
                } catch {}
                resolve({ status: res.statusCode, body: value, text });
              });
            },
          );
          req.on("error", reject);
          req.end(form ?? (body ? JSON.stringify(body) : undefined));
        });
      };
      const cliBase = ["apps/cli/dist/index.js", "server", "access"];
      const command = async (name, args, input = "") => {
        const child = launch([...cliBase, ...args], {
          env: sessions.get(name).env,
        });
        let out = "",
          error = "";
        child.stdout.on("data", (part) => (out += part));
        child.stderr.on("data", (part) => (error += part));
        child.stdin.end(input);
        const [code] = await once(child, "exit", { signal });
        assert.equal(code, 0, error + diagnostics());
        return JSON.parse(out);
      };
      for (const user of users) {
        const home = `/tmp/bb-thread-client-${user.login}`;
        const env = {
          ...process.env,
          HOME: home,
          BB_SERVER_URL: origin,
          BB_CLI: "",
          BB_CLI_ERROR_LOG: "0",
          NODE_EXTRA_CA_CERTS: "/tmp/bb-test-certificates/ca.crt",
        };
        const child = launch([...cliBase, "authorize", "--json"], { env });
        const completed = once(child, "exit", { signal });
        let out = "",
          error = "";
        child.stderr.on("data", (part) => (error += part));
        const authorizationUrl = await new Promise((resolve, reject) => {
          child.stdout.on("data", (part) => {
            out += part;
            const url = out.match(
              /https:\/\/127\.0\.0\.1:8080\/control-plane\/auth\/authorize\/[0-9a-f-]{36}/u,
            )?.[0];
            if (url) resolve(url);
          });
          child.once("exit", () =>
            reject(new Error(error || "Authorization exited")),
          );
          signal.addEventListener(
            "abort",
            () => reject(new Error("Authorization timed out")),
            { once: true },
          );
        });
        const path = new URL(authorizationUrl).pathname;
        const page = await send(path, { certificate: user.login });
        assert.equal(page.status, 200);
        const csrf = page.text.match(/name="csrf" value="([^"]+)"/u)?.[1];
        assert.ok(csrf);
        assert.equal(
          (
            await send(path, {
              certificate: user.login,
              method: "POST",
              form: new URLSearchParams({
                csrf,
                decision: "approve",
              }).toString(),
            })
          ).status,
          200,
        );
        assert.equal((await completed)[0], 0, error);
        assert.doesNotMatch(out, /agt_[A-Za-z0-9_-]{43}/u);
        const session = JSON.parse(
          await readFile(
            `${home}/.bb/server-access/${createHash("sha256").update(origin).digest("hex")}.json`,
            "utf8",
          ),
        );
        sessions.set(user.login, { env, token: session.token });
      }
      const created = [];
      for (const user of users) {
        const project = await command(user.login, [
          "projects",
          "create",
          "personal-api",
          "--name",
          `Personal ${user.login}`,
          "--json",
        ]);
        assert.equal(
          db
            .prepare(
              "SELECT count(*) AS value FROM environments WHERE project_id = ?",
            )
            .get(project.projectId).value,
          0,
        );
        const profile = await sendAdmin(
          "/control-plane/admin/profiles",
          {
            slug: `personal-${user.login}`,
            name: `Personal ${user.login}`,
            definition: {
              prompt: "Personal API fixture",
              providerId: "qwen-server",
              model: "qwen-job-test",
              reasoningLevel: "none",
              permissionMode: "full",
              tools: ["run_shell_command"],
              mcpServers: [],
            },
          },
          adminToken,
        );
        assert.equal(profile.status, 201);
        assert.equal(
          (
            await sendAdmin(
              `/control-plane/admin/profiles/${profile.body.profile.id}/access/${user.id}`,
              { allowed: true },
              adminToken,
              "PUT",
            )
          ).status,
          200,
        );
        const thread = await command(
          user.login,
          [
            "threads",
            "start",
            project.projectId,
            "--profile-version",
            profile.body.version.id,
            "--message-stdin",
            "--json",
          ],
          `BB_PERSONAL_${user.login} first`,
        );
        assert.equal(thread.profileVersionId, profile.body.version.id);
        await wait(
          () =>
            db.prepare("SELECT status FROM threads WHERE id = ?").get(thread.id)
              ?.status === "idle",
          `personal ${user.login}`,
        );
        const probe = JSON.parse(
          await readFile(`${user.home}/bb-personal-${user.login}.json`, "utf8"),
        );
        assert.deepEqual(probe, {
          uid: user.uid,
          home: user.home,
          cwd: `${user.projects_root}/personal-api`,
        });
        const result = await command(user.login, [
          "threads",
          "result",
          thread.id,
          "--json",
        ]);
        assert.match(
          result.text,
          new RegExp(`Personal ${user.login} completed`, "u"),
        );
        const page = await command(user.login, [
          "threads",
          "events",
          thread.id,
          "--limit",
          "2",
          "--json",
        ]);
        assert.equal(page.events.length, 2);
        assert.equal(page.hasMore, true);
        const next = await command(user.login, [
          "threads",
          "events",
          thread.id,
          "--after",
          String(page.cursor),
          "--json",
        ]);
        assert.ok(
          next.events.every(
            (event) => event.threadId === thread.id && event.seq > page.cursor,
          ),
        );
        assert.equal(
          JSON.stringify(next).includes(sessions.get(user.login).token),
          false,
        );
        created.push({
          user,
          project,
          profile,
          thread,
          sessionId: db
            .prepare(
              "SELECT qwen_session_id FROM control_plane_threads WHERE thread_id = ?",
            )
            .get(thread.id).qwen_session_id,
        });
      }
      const [alice, bob] = created;
      const aliceToken = sessions.get("alice").token,
        bobToken = sessions.get("bob").token;
      const base = "/control-plane/user/threads";
      for (const suffix of ["", "/events", "/result", "/interactions"])
        assert.equal(
          (
            await send(`${base}/${bob.thread.id}${suffix}`, {
              token: aliceToken,
            })
          ).status,
          404,
        );
      assert.equal(
        (
          await send(`${base}/${bob.thread.id}/stop`, {
            token: aliceToken,
            method: "POST",
          })
        ).status,
        404,
      );
      assert.equal(
        (await send("/api/v1/threads", { token: aliceToken })).status,
        401,
      );
      const count = db
        .prepare("SELECT count(*) AS value FROM threads")
        .get().value;
      assert.equal(
        (
          await send(base, {
            token: aliceToken,
            method: "POST",
            body: {
              projectId: alice.project.projectId,
              profileVersionId: alice.profile.body.version.id,
              message: "forged",
              cwd: bob.user.home,
            },
          })
        ).status,
        400,
      );
      assert.equal(
        db.prepare("SELECT count(*) AS value FROM threads").get().value,
        count,
      );
      const waiting = await sendAdmin(
        "/control-plane/admin/profiles",
        {
          slug: "personal-waiting",
          name: "Personal waiting",
          definition: {
            prompt: "Personal approval fixture",
            providerId: "qwen-server",
            model: "qwen-job-test",
            reasoningLevel: "none",
            permissionMode: "accept-edits",
            tools: ["run_shell_command"],
            mcpServers: [],
          },
        },
        adminToken,
      );
      assert.equal(waiting.status, 201);
      const waitingAccess = `/control-plane/admin/profiles/${waiting.body.profile.id}/access/${alice.user.id}`;
      assert.equal(
        (await sendAdmin(waitingAccess, { allowed: true }, adminToken, "PUT"))
          .status,
        200,
      );
      for (const marker of ["waiting", "waiting-stop"]) {
        const thread = await command("alice", [
          "threads",
          "start",
          alice.project.projectId,
          "--profile-version",
          waiting.body.version.id,
          "--message",
          `BB_PERSONAL_${marker}`,
          "--json",
        ]);
        const pending = await wait(
          async () =>
            (
              await command("alice", [
                "threads",
                "interactions",
                "list",
                thread.id,
                "--json",
              ])
            )[0],
          `personal ${marker} approval`,
        );
        assert.equal(
          (
            await send(
              `${base}/${thread.id}/interactions/${pending.id}/resolve`,
              {
                token: bobToken,
                method: "POST",
                body: { decision: "allow_once", grantedPermissions: null },
              },
            )
          ).status,
          404,
        );
        if (marker === "waiting") {
          await command("alice", [
            "threads",
            "interactions",
            "approve",
            thread.id,
            pending.id,
            "--json",
          ]);
          await wait(
            () =>
              db
                .prepare("SELECT status FROM threads WHERE id = ?")
                .get(thread.id)?.status === "idle",
            "personal approved action completion",
          );
        } else {
          assert.equal(
            (
              await sendAdmin(
                waitingAccess,
                { allowed: false },
                adminToken,
                "PUT",
              )
            ).status,
            200,
          );
          assert.equal(
            (
              await send(
                `${base}/${thread.id}/interactions/${pending.id}/resolve`,
                {
                  token: aliceToken,
                  method: "POST",
                  body: { decision: "allow_once", grantedPermissions: null },
                },
              )
            ).status,
            403,
          );
        }
        await command("alice", ["threads", "stop", thread.id, "--json"]);
        await wait(
          () =>
            db.prepare("SELECT status FROM threads WHERE id = ?").get(thread.id)
              ?.status === "idle",
          `personal ${marker} stop`,
        );
        if (marker === "waiting-stop")
          await assert.rejects(
            readFile(`${alice.user.home}/bb-personal-${marker}.json`),
            (error) => error.code === "ENOENT",
          );
        else
          assert.equal(
            JSON.parse(
              await readFile(
                `${alice.user.home}/bb-personal-${marker}.json`,
                "utf8",
              ),
            ).uid,
            alice.user.uid,
          );
      }
      const access = `/control-plane/admin/profiles/${alice.profile.body.profile.id}/access/${alice.user.id}`;
      assert.equal(
        (await sendAdmin(access, { allowed: false }, adminToken, "PUT")).status,
        200,
      );
      const before = db
        .prepare("SELECT count(*) AS value FROM events WHERE thread_id = ?")
        .get(alice.thread.id).value;
      assert.equal(
        (
          await send(`${base}/${alice.thread.id}/send`, {
            token: aliceToken,
            method: "POST",
            body: { message: "must not execute" },
          })
        ).status,
        403,
      );
      assert.equal(
        db
          .prepare("SELECT count(*) AS value FROM events WHERE thread_id = ?")
          .get(alice.thread.id).value,
        before,
      );
      assert.equal(
        (
          await command("alice", [
            "threads",
            "result",
            alice.thread.id,
            "--json",
          ])
        ).thread.id,
        alice.thread.id,
      );
      await command("alice", ["threads", "stop", alice.thread.id, "--json"]);
      await command("bob", ["threads", "stop", bob.thread.id, "--json"]);
      assert.equal(
        (await sendAdmin(access, { allowed: true }, adminToken, "PUT")).status,
        200,
      );
      const list = await command("alice", [
        "threads",
        "list",
        "--project",
        alice.project.projectId,
        "--json",
      ]);
      assert.ok(list.threads.some((thread) => thread.id === alice.thread.id));
      saved = { command, alice, wait };
      return {
        personalThreadCertificateCliAndFreshEnvironment: true,
        actualTwoUserThreadApiDispatch: true,
        personalEventsAndResults: true,
        foreignThreadsAndApprovalsDenied: true,
        personalApprovalAndRevokedStop: true,
        revokedSendDeniedBeforeEvents: true,
      };
    },
    async afterRestart() {
      const { command, alice, wait } = saved;
      assert.equal(
        (await command("alice", ["threads", "get", alice.thread.id, "--json"]))
          .id,
        alice.thread.id,
      );
      await command(
        "alice",
        ["threads", "send", alice.thread.id, "--message-stdin", "--json"],
        "BB_PERSONAL_alice continue after restart",
      );
      await wait(
        () =>
          db
            .prepare("SELECT status FROM threads WHERE id = ?")
            .get(alice.thread.id)?.status === "idle",
        "personal thread resume",
      );
      assert.equal(
        db
          .prepare(
            "SELECT qwen_session_id FROM control_plane_threads WHERE thread_id = ?",
          )
          .get(alice.thread.id).qwen_session_id,
        alice.sessionId,
      );
      assert.equal(resumed, true);
      await command("alice", ["threads", "stop", alice.thread.id, "--json"]);
      return {
        personalTokenAndThreadSurviveRestart: true,
        personalNativeQwenSessionResumedWithHistory: true,
      };
    },
  };
}
