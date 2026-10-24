import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, rmdir } from "node:fs/promises";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export async function verifyQwenJobs({ command, launch, signal }) {
  const db = new Database("/srv/bb/bb.db");
  db.prepare("UPDATE control_plane_users SET enabled = 1").run();
  const users = db
    .prepare("SELECT * FROM control_plane_users ORDER BY uid")
    .all();
  db.close();
  assert.equal(users.length, 2);
  const calls = new Set();
  const backend = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) {
      text += chunk;
      assert.ok(text.length < 4000000);
    }
    if (!req.url?.endsWith("/chat/completions")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = JSON.parse(text);
    const latest = [...body.messages]
      .reverse()
      .find((message) => message.role === "user");
    const latestText =
      typeof latest?.content === "string"
        ? latest.content
        : JSON.stringify(latest?.content);
    const match = latestText?.match(/BB_JOB_TEST ([a-z0-9-]+) (probe|hang)/u);
    assert.ok(match, "Missing controlled prompt marker");
    const [, marker, mode] = match;
    if (marker === "alice-resumed")
      assert.match(
        JSON.stringify(body.messages),
        /BB_JOB_TEST alice-first probe/u,
        "Native resume lost the previous conversation",
      );
    const first = !calls.has(marker);
    calls.add(marker);
    let delta;
    if (first) {
      const tool = body.tools?.find(
        (entry) => entry.function?.name === "run_shell_command",
      );
      assert.ok(
        tool,
        `Expected native shell tool, received ${JSON.stringify(body.tools?.map((entry) => entry.function?.name))}`,
      );
      const foreignHome = marker.startsWith("bob-")
        ? users[0].home
        : users[1].home;
      const permissionsProbe = `const denied=(path)=>{try{fs.readdirSync(path);return false}catch(error){return error.code==="EACCES"}};const otherHomeDenied=denied(${JSON.stringify(foreignHome)}),serviceDataDenied=denied("/srv/bb");const noNewPrivileges=/NoNewPrivs:\\s+1/.test(fs.readFileSync("/proc/self/status","utf8"));`;
      const code =
        mode === "hang"
          ? 'const fs=require("node:fs"),cp=require("node:child_process");const child=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});child.unref();fs.writeFileSync(process.env.HOME+"/' +
            marker +
            '.json",JSON.stringify({pid:process.pid,child:child.pid,uid:process.getuid(),home:process.env.HOME,cwd:process.cwd()}));setInterval(()=>{},1000)'
          : 'const fs=require("node:fs");' +
            permissionsProbe +
            'fs.writeFileSync(process.env.HOME+"/' +
            marker +
            '.json",JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),home:process.env.HOME,cwd:process.cwd(),otherHomeDenied,serviceDataDenied,noNewPrivileges}));console.log("probe-written")';
      const shellCommand = `/usr/local/bin/node -e '${code.replaceAll("'", "'\\''")}'`;
      delta = {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call_${marker}`,
            type: "function",
            function: {
              name: tool.function.name,
              arguments: JSON.stringify({
                command: shellCommand,
                description: "Verify isolated process identity",
                timeout: 300000,
              }),
            },
          },
        ],
      };
    } else delta = { role: "assistant", content: "Probe completed" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: `chat_${marker}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: `chat_${marker}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const env = {
    ...process.env,
    HOME: "/home/node",
    QWEN_SERVER_BASE_URL: `http://127.0.0.1:${backend.address().port}/v1`,
    NEURALDEAP_KEY: "local-test-only",
  };
  const config = (user, marker, extra = {}) => ({
    id: user.id,
    login: user.login,
    uid: user.uid,
    home: user.home,
    cwd: `${user.projects_root}/app`,
    marker,
    mode: "probe",
    ...extra,
  });
  try {
    const [alice, bob] = users;
    const fencedJob = randomUUID();
    const helper = "/opt/bb-control-plane/launcher/helper.py";
    await rmdir("/var/lib/bb-agent-launcher/jobs");
    await command(
      ["-n", "--", helper, "stop", alice.id, String(alice.uid), fencedJob],
      "",
      { file: "/usr/bin/sudo" },
    );
    const rejected = launch(
      [
        "-n",
        "--",
        helper,
        "launch",
        alice.id,
        String(alice.uid),
        fencedJob,
        `${alice.projects_root}/app`,
        "--",
        "--version",
      ],
      { file: "/usr/bin/sudo" },
    );
    rejected.stdout.resume();
    rejected.stderr.resume();
    await new Promise((resolve, reject) => {
      rejected.once("error", reject);
      rejected.once("exit", (code) =>
        code !== 0 ? resolve() : reject(new Error("A cancelled job launched")),
      );
    });
    const first = JSON.parse(
      await command(
        ["qwen-job-client.mjs"],
        JSON.stringify(config(alice, "alice-first")),
        { env },
      ),
    );
    await command(
      ["qwen-job-client.mjs"],
      JSON.stringify(
        config(alice, "alice-resumed", {
          threadId: first.threadId,
          sessionId: first.sessionId,
        }),
      ),
      { env },
    );
    await command(
      ["qwen-job-client.mjs"],
      JSON.stringify(config(bob, "bob-first")),
      { env },
    );
    for (const [user, marker] of [
      [alice, "alice-first"],
      [alice, "alice-resumed"],
      [bob, "bob-first"],
    ]) {
      const probe = JSON.parse(
        await readFile(`${user.home}/${marker}.json`, "utf8"),
      );
      assert.deepEqual(probe, {
        uid: user.uid,
        gid: user.uid,
        groups: [user.uid],
        home: user.home,
        cwd: `${user.projects_root}/app`,
        otherHomeDenied: true,
        serviceDataDenied: true,
        noNewPrivileges: true,
      });
    }
    const hang = (marker) => {
      const child = launch(["qwen-job-client.mjs"], { env });
      let output = "",
        error = "";
      child.stdout.on("data", (part) => (output += part));
      child.stderr.on("data", (part) => (error += part));
      child.stdin.end(JSON.stringify(config(alice, marker, { mode: "hang" })));
      const complete = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0
            ? resolve(output)
            : reject(new Error(`Qwen job check failed: ${error}`)),
        );
        signal.addEventListener(
          "abort",
          () => reject(new Error("Job check timed out")),
          { once: true },
        );
      });
      void complete.catch(() => {});
      return { child, complete };
    };
    const one = hang("alice-stop-one");
    const two = hang("alice-stop-two");
    const waitForProbe = async (marker, job) => {
      const probing = (async () => {
        while (!signal.aborted) {
          try {
            return JSON.parse(
              await readFile(`${alice.home}/${marker}.json`, "utf8"),
            );
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("Native tool startup timed out");
      })();
      return Promise.race([
        probing,
        job.complete.then(() => {
          throw new Error("Job exited before its native tool started");
        }),
      ]);
    };
    await Promise.all([
      waitForProbe("alice-stop-one", one),
      waitForProbe("alice-stop-two", two),
    ]);
    one.child.kill("SIGUSR2");
    await one.complete;
    const info = JSON.parse(
      await readFile(`${alice.home}/alice-stop-two.json`, "utf8"),
    );
    assert.ok(
      await readFile(`/proc/${info.child}/stat`, "utf8"),
      "Stopping another session killed this job",
    );
    two.child.kill("SIGUSR2");
    await two.complete;
    for (const marker of ["alice-stop-one", "alice-stop-two"]) {
      const probe = JSON.parse(
        await readFile(`${alice.home}/${marker}.json`, "utf8"),
      );
      for (const pid of [probe.pid, probe.child])
        await assert.rejects(
          readFile(`/proc/${pid}/stat`),
          (error) => error.code === "ENOENT",
        );
    }
    return {
      actualStockQwenCli: true,
      nativeShellUidHomeCwd: true,
      nativeSessionResume: true,
      stopKillsDetachedDescendants: true,
      sameUserOtherJobSurvives: true,
      cancelBeforeLaunchFenced: true,
      modelBackend: "Local deterministic OpenAI-compatible fixture",
      databaseThreadAdmissionVerified: true,
      realBbDaemonDispatchVerified: false,
    };
  } finally {
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
  }
}
