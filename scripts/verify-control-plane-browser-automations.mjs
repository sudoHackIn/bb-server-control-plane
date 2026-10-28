import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { verifyForeignCliDenied } from "./verify-control-plane-browser-cli.mjs";

export async function verifyBrowserAutomations({
  page,
  foreign,
  user,
  origin,
  visible,
  command,
  container,
  expectedOriginThreadId,
}) {
  await page.getByRole("button", { name: "Automations", exact: true }).click();
  await visible(
    page.getByRole("heading", { name: "Automations", exact: true }),
  );
  assert.equal(
    await page.getByRole("textbox", { name: "Message your agent…" }).count(),
    0,
  );
  await page
    .getByRole("button", { name: "New automation", exact: true })
    .click();
  const originThreadId = new URL(page.url()).pathname.split("/threads/")[1];
  assert.ok(originThreadId);
  if (expectedOriginThreadId)
    assert.equal(originThreadId, expectedOriginThreadId);
  const originProfileResponse = await page
    .context()
    .request.get(
      `${origin}/control-plane/user/threads/${originThreadId}/profile`,
    );
  assert.equal(originProfileResponse.status(), 200);
  const originProfile = await originProfileResponse.json();
  assert.match(originProfile.version.id, /^[0-9a-f-]{36}$/u);
  const title = `browser-automation-${user.login}`;
  const marker = `automation-browser-${user.login}`;
  await page.getByLabel("Automation name", { exact: true }).fill(title);
  await page
    .getByLabel("Agent task", { exact: true })
    .fill(`BB_PERSONAL_${marker}`);
  const base = "/control-plane/user/automations";
  async function operation(path, method, action, status = 200) {
    const pending = page.waitForResponse(
      (reply) =>
        new URL(reply.url()).pathname === path &&
        reply.request().method() === method,
    );
    await action();
    const reply = await pending;
    assert.equal(reply.status(), status, await reply.text());
    return reply.json();
  }
  const definition = await operation(
    base,
    "POST",
    () =>
      page
        .getByRole("button", { name: "Create automation", exact: true })
        .click(),
    201,
  );
  assert.equal(definition.projectId, user.projectId);
  assert.equal(definition.createdByThreadId, originThreadId);
  assert.equal(definition.revision, 1);
  const path = `${base}/${definition.id}`;
  await visible(page.getByText("Edit automation · v1", { exact: true }));
  for (const suffix of ["", "/definition", "/history"])
    assert.equal(
      (await foreign.context.request.get(origin + path + suffix)).status(),
      404,
    );
  const foreignAutomations = await foreign.context.request.get(origin + base);
  assert.equal(foreignAutomations.status(), 200);
  assert.equal(
    JSON.stringify(await foreignAutomations.json()).includes(definition.id),
    false,
  );
  const foreignLocation = foreign.page.url();
  await foreign.page.goto(page.url());
  await visible(foreign.page.getByRole("alert"));
  assert.equal(
    await foreign.page.getByLabel("Automation name", { exact: true }).count(),
    0,
  );
  await foreign.page.goto(foreignLocation);
  for (const args of [
    ["automations", "get", definition.id],
    ["automations", "definition", definition.id],
    ["automations", "history", definition.id],
    ["automations", "run", definition.id],
  ])
    await verifyForeignCliDenied({
      command,
      container,
      origin,
      login: foreign.login,
      args,
      privateText: title,
    });
  for (const suffix of ["/pause", "/resume", "/run"])
    assert.equal(
      (
        await foreign.context.request.post(origin + path + suffix, {
          headers: { origin },
          data: {},
        })
      ).status(),
      404,
    );
  await page
    .getByLabel("Schedule type", { exact: true })
    .selectOption("schedule");
  await page.getByLabel("Cron expression", { exact: true }).fill("0 9 * * 1-5");
  await page.getByLabel("Schedule timezone", { exact: true }).fill("UTC");
  const updated = await operation(path, "PUT", () =>
    page.getByRole("button", { name: "Save automation", exact: true }).click(),
  );
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.trigger, {
    triggerType: "schedule",
    cron: "0 9 * * 1-5",
    timezone: "UTC",
  });
  await visible(page.getByText("Edit automation · v2", { exact: true }));
  await operation(path + "/pause", "POST", () =>
    page.getByRole("button", { name: "Pause automation", exact: true }).click(),
  );
  await visible(
    page.getByRole("button", { name: "Resume automation", exact: true }),
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Run automation", exact: true })
      .isDisabled(),
    true,
  );
  await operation(path + "/resume", "POST", () =>
    page
      .getByRole("button", { name: "Resume automation", exact: true })
      .click(),
  );
  await visible(
    page.getByRole("button", { name: "Pause automation", exact: true }),
  );
  const run = await operation(
    path + "/run",
    "POST",
    () =>
      page.getByRole("button", { name: "Run automation", exact: true }).click(),
    201,
  );
  try {
    await visible(
      page.getByText(`${run.id} · succeeded · manual`, { exact: true }),
    );
  } catch (error) {
    const response = await page
      .context()
      .request.get(origin + path + "/history");
    const body = await response.json();
    const current = body.runs?.find((item) => item.id === run.id);
    console.log(
      JSON.stringify({
        browserAutomationFailure: {
          owner: user.login,
          historyStatus: response.status(),
          runId: run.id,
          status: current?.status,
          threadId: current?.threadId,
        },
      }),
    );
    throw error;
  }
  const runHistory = await page
    .context()
    .request.get(origin + path + "/history");
  assert.equal(runHistory.status(), 200);
  const completedRun = (await runHistory.json()).runs.find(
    (item) => item.id === run.id,
  );
  assert.ok(completedRun?.threadId);
  const runThread = await page
    .context()
    .request.get(
      `${origin}/control-plane/user/threads/${completedRun.threadId}`,
    );
  assert.equal(runThread.status(), 200);
  assert.equal(
    (await runThread.json()).profileVersionId,
    originProfile.version.id,
  );
  for (const suffix of ["", "/profile", "/events", "/timeline", "/result"])
    assert.equal(
      (
        await foreign.context.request.get(
          `${origin}/control-plane/user/threads/${completedRun.threadId}${suffix}`,
        )
      ).status(),
      404,
    );
  for (const method of ["get", "result", "timeline", "events"])
    await verifyForeignCliDenied({
      command,
      container,
      origin,
      login: foreign.login,
      args: ["threads", method, completedRun.threadId],
      privateText: marker,
    });
  await verifyForeignCliDenied({
    command,
    container,
    origin,
    login: foreign.login,
    args: ["automations", "stop", definition.id, run.id],
    privateText: marker,
  });
  const foreignLocationAfterRun = foreign.page.url();
  await foreign.page.goto(
    `${origin}/projects/${user.projectId}/threads/${completedRun.threadId}`,
  );
  await visible(foreign.page.getByRole("alert"));
  assert.equal(
    await foreign.page
      .getByText(`Personal ${marker} completed`, {
        exact: true,
      })
      .count(),
    0,
  );
  await foreign.page.goto(foreignLocationAfterRun);

  assert.equal(
    (
      await foreign.context.request.post(
        `${origin}${path}/runs/${run.id}/stop`,
        { headers: { origin } },
      )
    ).status(),
    404,
  );
  async function proof(marker, stopped = false) {
    const script = `const D=require("better-sqlite3"),fs=require("node:fs");const db=new D("/srv/bb/bb.db",{readonly:true});const user=db.prepare("SELECT uid,home,projects_root FROM control_plane_users WHERE login=?").get(process.argv[1]);const marker=process.argv[2],expected="bb-personal-"+marker+".json";let proof=null;try{proof=JSON.parse(fs.readFileSync(user.home+"/"+expected,"utf8"))}catch(e){if(e.code!=="ENOENT"&&!(e instanceof SyntaxError))throw e}const processes=[];for(const pid of fs.readdirSync("/proc")){if(!/^[0-9]+$/.test(pid)||Number(pid)===process.pid)continue;try{if(fs.readFileSync("/proc/"+pid+"/cmdline","utf8").includes(expected))processes.push({pid:Number(pid),uid:Number(fs.readFileSync("/proc/"+pid+"/status","utf8").match(/^Uid:\\s+(\\d+)/m)[1])})}catch(e){if(!["ENOENT","ESRCH"].includes(e.code))throw e}}console.log(JSON.stringify({user,proof,processes}));db.close();`;
    const deadline = Date.now() + 60000;
    let observed;
    while (Date.now() < deadline) {
      const { stdout } = await command("docker", [
        "exec",
        container,
        "node",
        "-e",
        script,
        user.login,
        marker,
      ]);
      const value = JSON.parse(stdout);
      observed = {
        marker,
        hasProof: Boolean(value.proof),
        matchingProcesses: value.processes.length,
        stopped,
      };
      if (
        value.proof &&
        (!marker.startsWith("worker-hang-") ||
          (stopped ? value.processes.length === 0 : value.processes.length > 0))
      ) {
        assert.deepEqual(value.proof, {
          uid: value.user.uid,
          home: value.user.home,
          cwd: `${value.user.projects_root}/personal-api`,
        });
        for (const process of value.processes)
          assert.equal(process.uid, value.user.uid);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      "Browser automation command proof or process state did not arrive: " +
        JSON.stringify(observed),
    );
  }
  await proof(marker);
  await page.reload();
  await visible(page.getByRole("heading", { name: title, exact: true }));
  assert.equal(
    new URL(page.url()).searchParams.get("automation"),
    definition.id,
  );
  assert.equal(
    await page.getByLabel("Agent task", { exact: true }).inputValue(),
    `BB_PERSONAL_${marker}`,
  );
  await page
    .getByRole("button", { name: "Open run conversation", exact: true })
    .first()
    .click();
  await visible(page.getByRole("textbox", { name: "Message your agent…" }));
  await visible(
    page.getByText(`Personal ${marker} completed`, { exact: true }).first(),
  );
  await page.goBack();
  await visible(page.getByRole("heading", { name: title, exact: true }));
  const hanging = `worker-hang-automation-browser-${user.login}`;
  await page
    .getByLabel("Agent task", { exact: true })
    .fill(`BB_PERSONAL_${hanging}`);
  const v3 = await operation(path, "PUT", () =>
    page.getByRole("button", { name: "Save automation", exact: true }).click(),
  );
  assert.equal(v3.revision, 3);
  const cancelled = await operation(
    path + "/run",
    "POST",
    () =>
      page.getByRole("button", { name: "Run automation", exact: true }).click(),
    201,
  );
  await proof(hanging);
  await operation(`${path}/runs/${cancelled.id}/stop`, "POST", () =>
    page
      .getByRole("button", { name: `Stop run ${cancelled.id}`, exact: true })
      .click(),
  );
  await visible(
    page.getByText(`${cancelled.id} · cancelled · manual`, { exact: true }),
  );
  await proof(hanging, true);
  if (process.env.BB_CONTROL_PLANE_BROWSER_ARTIFACTS) {
    await mkdir(process.env.BB_CONTROL_PLANE_BROWSER_ARTIFACTS, {
      recursive: true,
      mode: 0o700,
    });
    await page
      .getByRole("region", { name: "Personal automations" })
      .screenshot({
        path: join(
          process.env.BB_CONTROL_PLANE_BROWSER_ARTIFACTS,
          `personal-automations-${user.login}.png`,
        ),
      });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("region", { name: "Personal automations" })
    .evaluate((element) => element.scrollTo(0, 0));
  assert.equal(
    await page
      .locator("header")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
  );
  assert.equal(
    await page
      .locator("body")
      .evaluate((element) => element.scrollWidth <= window.innerWidth),
    true,
  );
  if (process.env.BB_CONTROL_PLANE_BROWSER_ARTIFACTS)
    await page.screenshot({
      path: join(
        process.env.BB_CONTROL_PLANE_BROWSER_ARTIFACTS,
        `personal-automations-mobile-${user.login}.png`,
      ),
    });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .getByRole("button", { name: "Delete automation", exact: true })
    .click();
  await visible(
    page.getByRole("group", { name: "Confirm automation deletion" }),
  );
  await operation(path, "DELETE", () =>
    page
      .getByRole("button", { name: "Confirm delete automation", exact: true })
      .click(),
  );
  await page
    .getByRole("region", { name: "Selected automation" })
    .waitFor({ state: "detached" });
  assert.equal((await page.context().request.get(origin + path)).status(), 404);
  await page
    .getByRole("button", { name: "New automation", exact: true })
    .click();
  await page
    .getByLabel("Automation type", { exact: true })
    .selectOption("script");
  const scriptMarker = `automation-browser-script-${user.login}`;
  const source = `import fs from 'node:fs';const proof={uid:process.getuid(),home:process.env.HOME,cwd:process.cwd()};fs.writeFileSync(process.env.HOME+'/bb-personal-${scriptMarker}.json',JSON.stringify(proof));console.log(JSON.stringify(proof));console.error('<script>window.scriptOutputExecuted=true</script>');`;
  await page.getByLabel("Automation name", { exact: true }).fill(scriptMarker);
  await page.getByLabel("Script source", { exact: true }).fill(source);
  await page.getByLabel("Script timeout (ms)", { exact: true }).fill("7000");
  const script = await operation(
    base,
    "POST",
    () =>
      page
        .getByRole("button", { name: "Create automation", exact: true })
        .click(),
    201,
  );
  assert.equal(script.executionMode, "script");
  const scriptPath = `${base}/${script.id}`;
  await visible(page.getByText("Edit automation · v1", { exact: true }));
  await page.reload();
  await visible(page.getByRole("heading", { name: scriptMarker, exact: true }));
  assert.equal(
    await page.getByLabel("Script source", { exact: true }).inputValue(),
    source,
  );
  assert.equal(
    await page.getByLabel("Script timeout (ms)", { exact: true }).inputValue(),
    "7000",
  );
  const scriptRun = await operation(
    scriptPath + "/run",
    "POST",
    () =>
      page.getByRole("button", { name: "Run automation", exact: true }).click(),
    201,
  );
  await visible(
    page.getByText(`${scriptRun.id} · succeeded · manual`, { exact: true }),
  );
  const output = await operation(
    `${scriptPath}/runs/${scriptRun.id}/output`,
    "GET",
    () =>
      page
        .getByRole("button", {
          name: `Show script output ${scriptRun.id}`,
          exact: true,
        })
        .click(),
  );
  assert.equal(output.status, "succeeded");
  assert.equal(output.result.exitCode, 0);
  assert.equal(
    output.result.stderr.trim(),
    "<script>window.scriptOutputExecuted=true</script>",
  );
  assert.equal(
    await page.evaluate(() => window.scriptOutputExecuted),
    undefined,
  );
  await proof(scriptMarker);
  for (const suffix of ["/definition", `/runs/${scriptRun.id}/output`])
    assert.equal(
      (
        await foreign.context.request.get(origin + scriptPath + suffix)
      ).status(),
      404,
    );
  await page
    .getByLabel("Script source", { exact: true })
    .fill(source + "\nconsole.log('revision-two');");
  const scriptUpdated = await operation(scriptPath, "PUT", () =>
    page.getByRole("button", { name: "Save automation", exact: true }).click(),
  );
  assert.equal(scriptUpdated.revision, 2);
  await visible(page.getByText("Edit automation · v2", { exact: true }));
  if (process.env.BB_CONTROL_PLANE_BROWSER_ARTIFACTS)
    await page
      .getByRole("region", { name: "Personal automations", exact: true })
      .screenshot({
        path: join(
          process.env.BB_CONTROL_PLANE_BROWSER_ARTIFACTS,
          `personal-script-automations-${user.login}.png`,
        ),
      });
  await page
    .getByRole("button", { name: "Delete automation", exact: true })
    .click();
  await operation(scriptPath, "DELETE", () =>
    page
      .getByRole("button", { name: "Confirm delete automation", exact: true })
      .click(),
  );
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await visible(page.getByRole("textbox", { name: "Message your agent…" }));
}
