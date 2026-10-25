import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { request } from "node:https";
import Database from "/opt/bb/node_modules/better-sqlite3/lib/index.js";

const origin = "https://127.0.0.1:8086";
const certificates = "/srv/bb/demo-certificates";
const password = "demo-local-operator-password";
await chmod("/srv/bb", 0o700);
const ca = await readFile(`${certificates}/ca.crt`);
const configFile = "/srv/bb/control-plane.json";
try {
  await access(configFile);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const configure = spawn(
    process.execPath,
    [
      "configure.mjs",
      "--data-dir",
      "/srv/bb",
      "--origin",
      origin,
      "--login",
      "operator",
      "--users-root",
      "/srv/agent-users",
      "--tls-key",
      `${certificates}/server.key`,
      "--tls-cert",
      `${certificates}/server.crt`,
      "--client-ca",
      `${certificates}/ca.crt`,
      "--daemon-entrypoint",
      "/opt/bb/apps/host-daemon/dist/control-plane.js",
      "--cli-directory",
      "/opt/bb/apps/cli/dist",
    ],
    { uid: 1000, gid: 1000, stdio: ["pipe", "inherit", "inherit"] },
  );
  configure.stdin.end(password);
  assert.equal((await once(configure, "exit"))[0], 0);
}

const backend = createServer(async (req, res) => {
  try {
    let input = "";
    for await (const part of req) {
      input += part;
      if (input.length > 2097152) throw new Error("Demo input limit");
    }
    const body = JSON.parse(input);
    const last = body.messages?.findLast((message) => message.role === "user");
    const text = typeof last?.content === "string" ? last.content : "сообщение";
    const content = `Демонстрационный ответ: ${text.slice(0, 1000)}\n\nQwen запущен в изолированном окружении. Этот стенд использует тестовую модель без внешнего API.`;
    const common = {
      id: "demo",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
    };
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ...common,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    }
  } catch {
    res.writeHead(400);
    res.end("Invalid demo request");
  }
});
await new Promise((resolve) => backend.listen(38888, "127.0.0.1", resolve));
const server = spawn(process.execPath, ["apps/server/dist/index.js"], {
  uid: 1000,
  gid: 1000,
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    HOME: "/home/node",
    BB_APP_URL: origin,
    NODE_EXTRA_CA_CERTS: `${certificates}/ca.crt`,
    QWEN_SERVER_BASE_URL: "http://127.0.0.1:38888/v1",
    NEURALDEAP_KEY: "local-demo-only",
  },
});
server.once("exit", (code) => {
  backend.close();
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.kill(signal));

async function send(path, { method = "GET", body, token, cookie, user } = {}) {
  const identity = user
    ? {
        cert: await readFile(`${certificates}/${user}.crt`),
        key: await readFile(`${certificates}/${user}.key`),
      }
    : {};
  return new Promise((resolve, reject) => {
    const req = request(
      origin + path,
      {
        ca,
        ...identity,
        method,
        headers: {
          origin,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(cookie ? { cookie } : {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (part) => {
          text += part;
        });
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          resolve({
            status: res.statusCode,
            body: parsed,
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function wait(check, label) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null)
      throw new Error("Demo server exited");
    try {
      if (await check()) return;
    } catch (error) {
      if (error.code !== "ECONNREFUSED") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Demo startup timeout: ${label}`);
}
await wait(async () => (await send("/health")).status === 200, "health");
const session = await send("/control-plane/login", {
  method: "POST",
  body: { login: "operator", password },
});
assert.equal(session.status, 200);
const token = session.body.token;
const db = new Database("/srv/bb/bb.db", { readonly: true });
await wait(
  () =>
    db
      .prepare(
        "SELECT id FROM host_daemon_sessions WHERE status='active' AND closed_at IS NULL",
      )
      .get(),
  "daemon",
);
for (const id of ["provider-qwen-server", "workflows", "automations"]) {
  const enabled = await send(`/api/v1/plugins/${id}/enable`, {
    method: "POST",
    body: {},
    token,
  });
  assert.equal(
    enabled.status,
    200,
    `Enable ${id}: ${JSON.stringify(enabled.body)}`,
  );
}
const ready = [];
for (const login of ["alice", "bob"]) {
  const auth = await send("/control-plane/user/login", {
    method: "POST",
    user: login,
  });
  assert.equal(auth.status, 303);
  const cookie = auth.headers["set-cookie"]
    .map((value) => value.split(";")[0])
    .join("; ");
  const provision = await send("/control-plane/user/environment", {
    method: "POST",
    body: {},
    cookie,
  });
  assert.equal(provision.status, 200, JSON.stringify(provision.body));
  const user = db
    .prepare("SELECT id FROM control_plane_users WHERE login=?")
    .get(login);
  const project = await send("/control-plane/user/projects", {
    method: "POST",
    body: { slug: "demo", name: `Demo ${login}` },
    cookie,
  });
  assert.ok([200, 201].includes(project.status), JSON.stringify(project.body));
  let profile = (
    await send("/control-plane/admin/profiles", { token })
  ).body.profiles.find((entry) => entry.slug === `demo-${login}`);
  let versionId;
  if (!profile) {
    const created = await send("/control-plane/admin/profiles", {
      method: "POST",
      token,
      body: {
        slug: `demo-${login}`,
        name: `Demo ${login}`,
        definition: {
          prompt: "Demo agent. Reply in Russian.",
          providerId: "qwen-server",
          model: "qwen-job-test",
          reasoningLevel: "none",
          permissionMode: "full",
          tools: ["run_shell_command"],
          mcpServers: [],
        },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    profile = created.body.profile;
    versionId = created.body.version.id;
  } else versionId = profile.latestVersionId;
  const grant = await send(
    `/control-plane/admin/profiles/${profile.id}/access/${user.id}`,
    { method: "PUT", token, body: { allowed: true } },
  );
  assert.equal(grant.status, 200);
  const projectId = project.body.projectId;
  const existing = await send(
    `/control-plane/user/threads?projectId=${projectId}`,
    { cookie },
  );
  if (!existing.body?.threads?.length) {
    const thread = await send("/control-plane/user/threads", {
      method: "POST",
      cookie,
      body: {
        projectId,
        profileVersionId: versionId,
        title: `Добро пожаловать, ${login}`,
        message: "Привет! Это проверка демонстрационного стенда.",
      },
    });
    assert.equal(thread.status, 201, JSON.stringify(thread.body));
  }
  ready.push({ login, projectId });
}
db.close();
console.log(
  `BB_DEMO_READY ${JSON.stringify({ origin, users: ready, model: "local deterministic fixture" })}`,
);
