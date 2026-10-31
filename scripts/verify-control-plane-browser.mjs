import { verifyPersonalSurface } from "./verify-control-plane-browser-ui.mjs";
import { verifyBrowserProjectMcp } from "./verify-control-plane-browser-mcp.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { verifyBrowserAutomations } from "./verify-control-plane-browser-automations.mjs";
import {
  readLimitedCli,
  verifyForeignCliDenied,
} from "./verify-control-plane-browser-cli.mjs";

export async function verifyControlPlaneBrowser({ name, ready }) {
  assert.equal(ready.origin, "https://127.0.0.1:8080");
  assert.equal(ready.users.length, 2);
  for (const user of ready.users) {
    assert.ok(["alice", "bob"].includes(user.login));
    assert.match(user.projectId, /^[A-Za-z0-9_-]{1,200}$/u);
    assert.match(user.threadId, /^[A-Za-z0-9_-]{1,200}$/u);
    assert.equal(typeof user.title, "string");
    assert.ok(Number.isSafeInteger(user.messageSeq) && user.messageSeq >= 0);
  }
  const command = promisify(execFile);
  async function certificate(login, extension) {
    try {
      const { stdout } = await command("docker", [
        "exec",
        name,
        "cat",
        `/tmp/bb-test-certificates/${login}.${extension}`,
      ]);
      return Buffer.from(stdout);
    } catch {
      throw new Error("Could not read temporary browser certificate");
    }
  }
  const browser = await chromium.launch({
    channel: process.env.BB_TEST_BROWSER_CHANNEL || "chrome",
    headless: true,
  });
  const contexts = [];
  const pageErrors = [];
  const requests = [];
  const identityRequests = [];
  async function actor(login) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
      clientCertificates: [
        {
          origin: ready.origin,
          cert: await certificate(login, "crt"),
          key: await certificate(login, "key"),
        },
      ],
    });
    contexts.push(context);
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === ready.origin
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) =>
      requests.push({ login, path: new URL(request.url()).pathname }),
    );
    page.on("requestfailed", (request) => {
      if (new URL(request.url()).pathname === "/control-plane/browser-context")
        identityRequests.push({
          login,
          kind: "failed",
          failure: request.failure()?.errorText,
          time: Date.now(),
        });
    });
    page.on("response", (response) => {
      if (
        new URL(response.url()).pathname === "/control-plane/browser-context"
      ) {
        void response.json().then(
          (body) =>
            identityRequests.push({
              login,
              kind: "response",
              status: response.status(),
              mode: body?.mode,
              epochType: typeof body?.cacheEpoch,
              time: Date.now(),
            }),
          () =>
            identityRequests.push({
              login,
              kind: "unreadable",
              status: response.status(),
              time: Date.now(),
            }),
        );
      }
    });
    return { login, page, context };
  }
  async function visible(locator) {
    await locator.waitFor({ state: "visible" });
  }
  async function login(page, user) {
    const path = `/projects/${user.projectId}/threads/${user.threadId}#msg=${user.messageSeq}`;
    await page.goto(ready.origin + path);
    await visible(
      page.getByRole("button", { name: `Войти как ${user.login}` }),
    );
    await page.getByRole("button", { name: `Войти как ${user.login}` }).click();
    await page.waitForURL(ready.origin + path);
    await visible(page.getByRole("heading", { name: user.title, exact: true }));
    await visible(page.getByRole("textbox", { name: "Message your agent…" }));
    assert.equal(
      await page.getByRole("button", { name: "Sign out" }).count(),
      1,
    );
    assert.equal(
      await page
        .getByRole("button", { name: /terminal|settings|plugins/iu })
        .count(),
      0,
    );
    assert.equal(
      await page.getByRole("tablist", { name: "Right panel views" }).count(),
      0,
    );
    assert.equal(
      await page.getByRole("button", { name: "Show right panel" }).count(),
      0,
    );
    assert.equal(await page.locator('[data-sidebar="sidebar"]').count(), 1);
    await page.reload();
    await visible(page.getByRole("heading", { name: user.title, exact: true }));
    assert.equal(new URL(page.url()).hash, `#msg=${user.messageSeq}`);
  }
  try {
    const aliceUser = ready.users.find((user) => user.login === "alice");
    const bobUser = ready.users.find((user) => user.login === "bob");
    assert.ok(aliceUser && bobUser);
    const alice = await actor("alice");
    const bob = await actor("bob");
    await login(alice.page, aliceUser);
    await login(bob.page, bobUser);
    const bobAgentResponse = await bob.context.request.get(
      `${ready.origin}/control-plane/user/threads/${bobUser.threadId}/profile`,
    );
    assert.equal(bobAgentResponse.status(), 200);
    const bobAgent = await bobAgentResponse.json();
    assert.equal(
      await alice.page
        .getByRole("button", { name: "Personal bob", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await bob.page
        .getByRole("button", { name: "Personal alice", exact: true })
        .count(),
      0,
    );
    assert.equal(
      (
        await bob.context.request.get(
          `${ready.origin}/control-plane/user/projects/${aliceUser.projectId}`,
        )
      ).status(),
      404,
    );
    assert.equal(
      (
        await alice.context.request.get(
          `${ready.origin}/control-plane/user/projects/${bobUser.projectId}`,
        )
      ).status(),
      404,
    );
    assert.equal(
      (
        await alice.context.request.get(
          `${ready.origin}/control-plane/user/profiles/${bobAgent.profile.id}`,
        )
      ).status(),
      404,
    );
    await visible(
      alice.page.getByRole("button", { name: "Personal alice", exact: true }),
    );
    await alice.page
      .getByRole("button", { name: "Personal alice", exact: true })
      .click();
    await alice.page.waitForURL(
      `${ready.origin}/projects/${aliceUser.projectId}`,
    );
    await alice.page
      .getByRole("button", { name: "Agents", exact: true })
      .click();
    await visible(
      alice.page.getByRole("heading", { name: "Agents", exact: true }),
    );
    const agentCatalog = alice.page.getByRole("list", {
      name: "Agent catalog",
    });
    assert.equal(
      await agentCatalog.getByRole("button", { name: /Personal bob/u }).count(),
      0,
    );
    await agentCatalog.getByRole("button", { name: /Personal alice/u }).click();
    await visible(alice.page.getByText("Help alice with project diagrams."));
    await alice.page.getByText("Agent configuration", { exact: true }).click();
    await visible(
      alice.page.getByText("run_shell_command, read_file", { exact: true }),
    );
    await visible(
      alice.page.getByRole("button", { name: "Start conversation" }),
    );
    await verifyPersonalSurface(
      alice.page,
      "Available agents",
      "agents",
      "All agents",
    );
    await alice.page
      .getByRole("textbox", { name: "Background task" })
      .fill("BB_PERSONAL_browser-alice");
    const browserRunResponse = alice.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/control-plane/user/agent-runs" &&
        response.request().method() === "POST",
    );
    await alice.page.getByRole("button", { name: "Run task" }).click();
    const browserRun = await (await browserRunResponse).json();
    assert.equal(browserRun.projectId, aliceUser.projectId);
    await visible(
      alice.page.getByRole("button", { name: "BB_PERSONAL_browser-alice" }),
    );
    await alice.page
      .getByRole("button", { name: "BB_PERSONAL_browser-alice" })
      .click();
    await visible(alice.page.getByRole("heading", { name: "Events" }));
    await visible(alice.page.getByText(`Task ${browserRun.runId}`));
    await visible(alice.page.getByText("Personal browser-alice completed"));
    const agentUrl = alice.page.url();
    await alice.page
      .getByRole("button", { name: "Schedule this agent" })
      .click();
    await alice.page
      .getByLabel("Automation name", { exact: true })
      .fill("Browser pinned schedule");
    await alice.page
      .getByLabel("Agent task", { exact: true })
      .fill("BB_PERSONAL_browser-schedule-alice");
    const scheduleArtifacts =
      process.env.BB_CONTROL_PLANE_BROWSER_ARTIFACTS ??
      process.env.BB_THREAD_STORAGE;
    if (scheduleArtifacts) {
      await mkdir(scheduleArtifacts, { recursive: true, mode: 0o700 });
      await alice.page
        .getByRole("form", { name: "Automation editor" })
        .screenshot({
          path: join(scheduleArtifacts, "published-agent-schedule.png"),
        });
    }
    const scheduleResponse = alice.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/control-plane/user/automations" &&
        response.request().method() === "POST",
    );
    await alice.page
      .getByRole("button", { name: "Create automation", exact: true })
      .click();
    const scheduleReply = await scheduleResponse;
    assert.equal(scheduleReply.status(), 201, await scheduleReply.text());
    const schedule = await scheduleReply.json();
    assert.equal(schedule.createdByThreadId, null);
    assert.equal(schedule.projectId, aliceUser.projectId);
    assert.equal(schedule.target.input, "BB_PERSONAL_browser-schedule-alice");
    assert.equal(
      (
        await bob.page
          .context()
          .request.get(
            `${ready.origin}/control-plane/user/automations/${schedule.id}`,
          )
      ).status(),
      404,
    );
    await alice.page
      .getByRole("link", { name: "Manage schedules and history" })
      .click();
    await alice.page
      .getByRole("button", { name: /Browser pinned schedule/u })
      .click();
    await visible(alice.page.getByRole("heading", { name: "Run history" }));
    assert.equal(
      await alice.page
        .getByRole("button", { name: "Open origin conversation" })
        .count(),
      0,
    );
    await alice.page
      .getByRole("button", { name: "Pause automation", exact: true })
      .click();
    await visible(
      alice.page.getByRole("button", {
        name: "Resume automation",
        exact: true,
      }),
    );
    await alice.page.goto(agentUrl);
    await alice.page
      .getByRole("list", { name: "Agent catalog" })
      .getByRole("button", { name: /Workflow agent alice/u })
      .click();
    await visible(alice.page.getByRole("button", { name: "Run task" }));
    assert.equal(
      await alice.page
        .getByRole("button", { name: "Start conversation" })
        .count(),
      0,
    );
    assert.equal(
      await alice.page
        .getByRole("button", { name: "Schedule this agent" })
        .count(),
      0,
    );
    await alice.page
      .getByRole("textbox", { name: "Background task" })
      .fill("Browser workflow task");
    const workflowAgentReply = alice.page.waitForResponse(
      (reply) =>
        new URL(reply.url()).pathname === "/control-plane/user/agent-runs" &&
        reply.request().method() === "POST",
    );
    await alice.page.getByRole("button", { name: "Run task" }).click();
    const workflowAgentResponse = await workflowAgentReply;
    assert.equal(
      workflowAgentResponse.status(),
      201,
      await workflowAgentResponse.text(),
    );
    const workflowAgentRun = await workflowAgentResponse.json();
    assert.equal(workflowAgentRun.strategy, "workflow");
    assert.equal(workflowAgentRun.threadId, null);
    await alice.page
      .getByRole("button", { name: "Browser workflow task", exact: true })
      .click();
    await visible(alice.page.getByText(`Task ${workflowAgentRun.runId}`));
    await visible(alice.page.getByText("edited-source", { exact: true }));
    assert.equal(
      await alice.page.getByRole("heading", { name: "Events" }).count(),
      0,
    );
    assert.equal(
      (
        await bob.context.request.get(
          `${ready.origin}/control-plane/user/agent-runs/${workflowAgentRun.runId}/result`,
        )
      ).status(),
      404,
    );
    await verifyPersonalSurface(
      alice.page,
      "Available agents",
      "workflow-agent",
      "All agents",
    );
    await alice.page.getByRole("link", { name: "Inspect execution" }).click();
    await visible(alice.page.getByRole("region", { name: "Run inspection" }));
    await visible(alice.page.getByRole("heading", { name: "Run output" }));
    await verifyPersonalSurface(
      alice.page,
      "Run inspection",
      "workflow-inspection-summary",
    );
    const inspection = aliceUser.inspection;
    assert.ok(
      inspection?.runId && inspection?.callId && inspection?.childThreadId,
    );
    const inspectionUrl = `${agentUrl}&inspectRun=${encodeURIComponent(inspection.runId)}`;
    await alice.page.goto(inspectionUrl);
    await visible(
      alice.page.getByRole("list", { name: "Recorded agent calls" }),
    );
    await alice.page
      .getByRole("list", { name: "Recorded agent calls" })
      .getByRole("button")
      .first()
      .click();
    await visible(alice.page.getByRole("heading", { name: "Step input" }));
    await visible(alice.page.getByRole("heading", { name: "Step output" }));
    await verifyPersonalSurface(
      alice.page,
      "Run inspection",
      "workflow-inspection-step",
    );
    await alice.page
      .getByRole("button", {
        name: new RegExp(`^${inspection.childThreadId}(?: · archived)?$`, "u"),
      })
      .click();
    await visible(
      alice.page.getByText(`${inspection.childThreadId} · Read only`, {
        exact: true,
      }),
    );
    await visible(
      alice.page.getByText("Personal workflow-published-alice completed", {
        exact: true,
      }),
    );
    assert.equal(await alice.page.getByRole("textbox").count(), 0);
    await alice.page
      .getByRole("button", { name: "Back to step", exact: true })
      .click();
    await visible(alice.page.getByRole("heading", { name: "Step input" }));
    await alice.page
      .getByRole("button", { name: "Back to run", exact: true })
      .click();
    await visible(
      alice.page.getByRole("list", { name: "Recorded agent calls" }),
    );
    for (const suffix of ["inspection", `calls/${inspection.callId}`]) {
      assert.equal(
        (
          await bob.context.request.get(
            `${ready.origin}/control-plane/user/workflows/${inspection.runId}/${suffix}`,
          )
        ).status(),
        404,
      );
    }
    await alice.page.goto(agentUrl);
    await alice.page
      .getByRole("list", { name: "Agent catalog" })
      .getByRole("button", { name: /Personal alice/u })
      .click();
    await alice.page
      .getByRole("button", { name: "Start conversation" })
      .click();
    await alice.page.waitForURL(
      `${ready.origin}/projects/${aliceUser.projectId}?agent=*`,
    );
    const unauthorizedRequests = requests.filter(
      (request) =>
        request.path.startsWith("/api/") ||
        request.path === "/ws" ||
        request.path.startsWith("/plugins/"),
    );
    assert.deepEqual(unauthorizedRequests, []);
    await alice.page
      .getByRole("button", { name: "New conversation", exact: true })
      .click();
    await visible(alice.page.getByRole("combobox", { name: "Agent profile" }));
    await alice.page.getByRole("combobox", { name: "Agent profile" }).click();
    assert.equal(
      await alice.page
        .getByRole("option", { name: "Personal bob", exact: true })
        .count(),
      0,
    );
    await alice.page
      .getByRole("option", { name: "Personal alice", exact: true })
      .click();
    const editor = alice.page.getByRole("textbox", {
      name: "Message your agent…",
    });
    await editor.fill(
      "BB_PERSONAL_browser first production browser conversation",
    );
    const created = alice.page.waitForResponse(
      (response) =>
        response.url() === ready.origin + "/control-plane/user/threads" &&
        response.request().method() === "POST",
    );
    await editor.press("Enter");
    const response = await created;
    assert.equal(response.status(), 201);
    const thread = await response.json();
    assert.equal(thread.projectId, aliceUser.projectId);
    const chosenAgentResponse = await alice.context.request.get(
      `${ready.origin}/control-plane/user/threads/${thread.id}/profile`,
    );
    assert.equal(chosenAgentResponse.status(), 200);
    const chosenAgent = await chosenAgentResponse.json();
    assert.equal(chosenAgent.profile.name, "Personal alice");
    assert.equal(chosenAgent.version.id, thread.profileVersionId);
    assert.equal(
      (
        await bob.context.request.get(
          `${ready.origin}/control-plane/user/profiles/${chosenAgent.profile.id}`,
        )
      ).status(),
      404,
    );
    for (const [actor, foreignProjectId, foreignProfileId] of [
      [alice, bobUser.projectId, bobAgent.profile.id],
      [bob, aliceUser.projectId, chosenAgent.profile.id],
    ]) {
      for (const [path, privateId] of [
        ["projects", foreignProjectId],
        ["profiles", foreignProfileId],
      ]) {
        const response = await actor.context.request.get(
          `${ready.origin}/control-plane/user/${path}`,
        );
        assert.equal(response.status(), 200);
        assert.equal(
          JSON.stringify(await response.json()).includes(privateId),
          false,
        );
      }
    }
    for (const [login, projectId, profileId, threadId] of [
      ["alice", bobUser.projectId, bobAgent.profile.id, bobUser.threadId],
      ["bob", aliceUser.projectId, chosenAgent.profile.id, thread.id],
    ]) {
      for (const path of ["projects", "profiles"]) {
        const page = await readLimitedCli({
          command,
          container: name,
          origin: ready.origin,
          login,
          args: [path, "list"],
        });
        assert.equal(
          JSON.stringify(page).includes(
            path === "projects" ? projectId : profileId,
          ),
          false,
        );
      }
      for (const args of [
        ["projects", "get", projectId],
        ["profiles", "get", profileId],
        ["threads", "get", threadId],
        ["threads", "result", threadId],
      ])
        await verifyForeignCliDenied({
          command,
          container: name,
          origin: ready.origin,
          login,
          args,
          privateText: "Personal browser completed",
        });
    }
    await alice.page.waitForURL(
      `${ready.origin}/projects/${thread.projectId}/threads/${thread.id}`,
    );
    await visible(
      alice.page.getByText("Personal browser completed", { exact: true }),
    );
    const sendResponse = alice.page.waitForResponse(
      (response) =>
        response.url().endsWith(`/threads/${thread.id}/send`) &&
        response.request().method() === "POST",
    );
    await editor.fill("BB_PERSONAL_browser follow-up through native editor");
    await editor.press("Enter");
    assert.equal((await sendResponse).status(), 200);
    await visible(
      alice.page.getByText(
        "BB_PERSONAL_browser follow-up through native editor",
        { exact: true },
      ),
    );
    await verifyBrowserAutomations({
      page: alice.page,
      foreign: bob,
      user: aliceUser,
      origin: ready.origin,
      visible,
      command,
      container: name,
      expectedOriginThreadId: thread.id,
    });
    const projectMcp = await verifyBrowserProjectMcp({
      actors: [
        { actor: alice, user: aliceUser },
        { actor: bob, user: bobUser },
      ],
      origin: ready.origin,
      command,
      container: name,
      visible,
    });
    const browserWorkflowIds = [];
    for (const [actor, user] of [
      [alice, aliceUser],
      [bob, bobUser],
    ]) {
      const page = actor.page;
      await page
        .getByRole("button", { name: "Workflows", exact: true })
        .click();
      await visible(
        page.getByRole("heading", { name: "Workflows", exact: true }),
      );
      assert.equal(
        await page
          .getByRole("textbox", { name: "Message your agent…" })
          .count(),
        0,
      );
      if (user.login === "alice") {
        await page.goto(
          `${ready.origin}/projects/${user.projectId}?view=workflows`,
        );
        const selector = page.getByRole("combobox", {
          name: "Execution agent",
        });
        await visible(selector);
        await page
          .getByRole("option", { name: /Personal alice/ })
          .waitFor({ state: "attached" });
        const version = await page
          .getByRole("option", { name: /Personal alice/ })
          .getAttribute("value");
        assert.ok(version);
        await selector.selectOption(version);
      }
      const source = page.getByRole("textbox", {
        name: "Workflow source",
        exact: true,
      });
      await source.fill(
        `export const meta={name:"browser-workflow-${user.login}",description:"Personal browser agent"}; return await agent("BB_PERSONAL_workflow-agent-${user.login}");`,
      );
      await page
        .getByRole("textbox", {
          name: "Workflow arguments (JSON)",
          exact: true,
        })
        .fill(JSON.stringify({ owner: user.login }));
      if (
        user.login === "alice" &&
        process.env.BB_CONTROL_PLANE_BROWSER_ARTIFACTS
      ) {
        await mkdir(process.env.BB_CONTROL_PLANE_BROWSER_ARTIFACTS, {
          recursive: true,
          mode: 0o700,
        });
        await page
          .locator("form")
          .filter({
            has: page.getByRole("combobox", { name: "Execution agent" }),
          })
          .screenshot({
            path: join(
              process.env.BB_CONTROL_PLANE_BROWSER_ARTIFACTS,
              "project-workflow-form.png",
            ),
          });
      }
      const started = page.waitForResponse(
        (reply) =>
          reply.url().endsWith("/control-plane/user/workflows") &&
          reply.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Run workflow", exact: true })
        .click();
      const startedResponse = await started;
      assert.equal(startedResponse.status(), 201);
      const workflow = await startedResponse.json();
      assert.equal(workflow.projectId, user.projectId);
      if (user.login === "alice") assert.equal(workflow.originThreadId, null);
      browserWorkflowIds.push(workflow.id);
      await visible(page.getByText(`Run ${workflow.id}`, { exact: true }));
      await visible(page.getByLabel("Workflow result", { exact: true }));
      await visible(
        page
          .getByLabel("Workflow agent calls", { exact: true })
          .getByText(/succeeded/u),
      );
      await page
        .getByRole("button", { name: "Prepare replay", exact: true })
        .click();
      const resumed = page.waitForResponse(
        (reply) =>
          reply.url().endsWith("/control-plane/user/workflows") &&
          reply.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Resume workflow", exact: true })
        .click();
      const resumedResponse = await resumed;
      assert.equal(resumedResponse.status(), 201);
      assert.equal(
        resumedResponse.request().postDataJSON().resumeRunId,
        workflow.id,
      );
      const replay = await resumedResponse.json();
      assert.notEqual(replay.id, workflow.id);
      await visible(page.getByText(`Run ${replay.id}`, { exact: true }));
      await visible(page.getByLabel("Workflow result", { exact: true }));
      if (process.env.BB_CONTROL_PLANE_BROWSER_ARTIFACTS) {
        await mkdir(process.env.BB_CONTROL_PLANE_BROWSER_ARTIFACTS, {
          recursive: true,
          mode: 0o700,
        });
        await page.getByLabel("Selected workflow", { exact: true }).screenshot({
          path: join(
            process.env.BB_CONTROL_PLANE_BROWSER_ARTIFACTS,
            `personal-workflow-${user.login}.png`,
          ),
        });
      }
      if (user.login === "alice")
        await verifyPersonalSurface(
          page,
          "Personal workflows",
          "workflows",
          "All runs",
        );
      await page.reload();
      await visible(
        page.getByRole("heading", { name: "Workflows", exact: true }),
      );
      await page
        .getByText("Loading workflows…", { exact: true })
        .waitFor({ state: "hidden" });
      const completedRun = page
        .getByRole("button", {
          name: `browser-workflow-${user.login} · succeeded`,
          exact: true,
        })
        .first();
      for (let pageIndex = 0; (await completedRun.count()) === 0; pageIndex++) {
        assert.ok(
          pageIndex < 10,
          "Workflow pagination did not reach the browser run",
        );
        const next = page.waitForResponse(
          (reply) =>
            new URL(reply.url()).pathname === "/control-plane/user/workflows" &&
            reply.request().method() === "GET" &&
            new URL(reply.url()).searchParams.has("cursor"),
        );
        await page
          .getByRole("button", { name: "More workflows", exact: true })
          .click();
        assert.equal((await next).status(), 200);
        await page.waitForFunction(() => {
          const more = [...document.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "More workflows",
          );
          return !more || !more.disabled;
        });
      }
      await completedRun.click();
      await visible(page.getByLabel("Workflow result", { exact: true }));
      assert.equal(
        await page
          .getByRole("button", {
            name: `browser-workflow-${user.login === "alice" ? "bob" : "alice"} · succeeded`,
            exact: true,
          })
          .count(),
        0,
      );
      if (user.login === "alice") {
        const selector = page.getByRole("combobox", {
          name: "Execution agent",
        });
        const version = await page
          .getByRole("option", { name: /Personal alice/ })
          .getAttribute("value");
        assert.ok(version);
        await selector.selectOption(version);
      }
      await source.fill(
        `export const meta={name:"browser-cancel-${user.login}",description:"Browser cancellation"}; phase("waiting"); return await new Promise(()=>{});`,
      );
      const pending = page.waitForResponse(
        (reply) =>
          reply.url().endsWith("/control-plane/user/workflows") &&
          reply.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Run workflow", exact: true })
        .click();
      assert.equal((await pending).status(), 201);
      await visible(
        page.getByRole("button", { name: "Stop workflow", exact: true }),
      );
      const stopped = page.waitForResponse(
        (reply) =>
          reply.url().endsWith("/stop") && reply.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Stop workflow", exact: true })
        .click();
      assert.equal((await stopped).status(), 200);
      await visible(
        page
          .getByLabel("Selected workflow", { exact: true })
          .getByRole("status")
          .filter({ hasText: /^cancelled(?:\s*·|$)/u }),
      );
      if (user.login === "alice") {
        await page.goto(
          `${ready.origin}/projects/${user.projectId}/threads/${user.threadId}?view=workflows`,
        );
        await visible(
          page.getByRole("textbox", { name: "Workflow source", exact: true }),
        );
      }
      await verifyBrowserDefinitions(
        page,
        user.login === "alice" ? bob : alice,
        user,
        ready.origin,
        visible,
      );
      await page
        .getByRole("button", { name: "Conversation", exact: true })
        .click();
      await visible(page.getByRole("textbox", { name: "Message your agent…" }));
    }
    await verifyBrowserAutomations({
      page: bob.page,
      foreign: alice,
      user: bobUser,
      origin: ready.origin,
      visible,
      command,
      container: name,
      expectedOriginThreadId: bobUser.threadId,
    });
    for (const [actor, foreignId] of [
      [alice, browserWorkflowIds[1]],
      [bob, browserWorkflowIds[0]],
    ]) {
      assert.equal(
        (
          await actor.context.request.get(
            `${ready.origin}/control-plane/user/workflows/${foreignId}`,
          )
        ).status(),
        404,
      );
      assert.equal(
        (
          await actor.context.request.post(
            `${ready.origin}/control-plane/user/workflows/${foreignId}/stop`,
            { headers: { origin: ready.origin } },
          )
        ).status(),
        404,
      );
    }
    const foreign = await bob.context.request.get(
      `${ready.origin}/control-plane/user/threads/${thread.id}`,
    );
    assert.equal(foreign.status(), 404);
    assert.equal(
      (
        await alice.context.request.get(
          `${ready.origin}/control-plane/user/threads/${bobUser.threadId}`,
        )
      ).status(),
      404,
    );
    assert.equal(
      (
        await bob.context.request.get(ready.origin + "/api/v1/threads")
      ).status(),
      401,
    );
    await bob.page.goto(
      `${ready.origin}/projects/${thread.projectId}/threads/${thread.id}`,
    );
    await visible(bob.page.getByRole("alert"));
    assert.equal(await bob.page.getByRole("textbox").count(), 0);
    assert.equal(
      await bob.page
        .getByText("Personal browser completed", { exact: true })
        .count(),
      0,
    );
    await bob.page.goto(
      `${ready.origin}/projects/${bobUser.projectId}/threads/${bobUser.threadId}`,
    );
    await visible(
      bob.page.getByRole("heading", { name: bobUser.title, exact: true }),
    );
    const aliceLocation = alice.page.url();
    await alice.page.goto(
      `${ready.origin}/projects/${bobUser.projectId}/threads/${bobUser.threadId}`,
    );
    await visible(alice.page.getByRole("alert"));
    assert.equal(await alice.page.getByRole("textbox").count(), 0);
    await alice.page.goto(aliceLocation);
    const artifacts = process.env.BB_CONTROL_PLANE_BROWSER_ARTIFACTS;
    if (artifacts) {
      await mkdir(artifacts, { recursive: true, mode: 0o700 });
      await alice.page.screenshot({
        path: join(artifacts, "personal-conversation.png"),
      });
    }
    await alice.page
      .getByRole("button", { name: "Sign out", exact: true })
      .click();
    await visible(alice.page.getByRole("button", { name: "Войти как alice" }));
    assert.equal(
      (
        await alice.context.request.get(
          `${ready.origin}/control-plane/user/threads/${thread.id}`,
        )
      ).status(),
      401,
    );
    assert.equal(await alice.page.getByRole("textbox").count(), 0);
    assert.deepEqual(
      requests.filter(
        (request) =>
          request.path.startsWith("/api/") ||
          request.path === "/ws" ||
          request.path.startsWith("/plugins/"),
      ),
      [],
    );
    assert.deepEqual(pageErrors, []);
    const administration = await verifyAdministrativeDefinitions({
      browser,
      ready,
      contexts,
      pageErrors,
      command,
      name,
      visible,
    });
    assert.deepEqual(pageErrors, []);
    return {
      ...administration,
      ...projectMcp,
      personalScriptEditorSourceTimeoutReloadAndRevision: true,
      personalScriptOutputStdoutStderrAndExitRendered: true,
      personalScriptHtmlOutputRemainsText: true,
      personalScriptActualUidHomeCwdVerified: true,
      personalScriptForeignDefinitionAndOutputDenied: true,
      personalAutomationsCrudSchedulesAndRevisionEditor: true,
      personalAutomationResponsiveToolbarVerified: true,
      personalAutomationHistoryAndConversationLinks: true,
      personalAutomationSelectionSurvivesReload: true,
      personalAutomationBrowserQwenUidHomeCwdVerified: true,
      personalAutomationBrowserCancellationReapsActualCommands: true,
      personalAutomationBrowserForeignReadsAndMutationsDenied: true,
      productionBrowserRenderingVerified: true,
      publishedWorkflowAgentCatalogTaskResultBrowser: true,
      workflowInspectionBrowserNativeThreadAndNavigation: true,
      browserVersion: browser.version(),
      separateCertificateBrowserContexts: true,
      certificateLoginPreservesConversationAndMessageFragment: true,
      nativeSidebarTimelineAndComposerRendered: true,
      actualNativeEditorCreatesAndContinuesQwenConversation: true,
      liveQwenResponseRendered: true,
      personalWorkflowDefinitionsCrudAndExactRevisionRun: true,
      personalWorkflowDefinitionQwenWorkerAndDefaultArguments: true,
      personalWorkflowDefinitionForeignRequestsDeniedWhilePresent: true,
      personalWorkflowListStartProgressHistoryAndResultRendered: true,
      personalWorkflowReplayAndCancellationFromNativeUi: true,
      personalWorkflowViewSurvivesReload: true,
      personalWorkflowPaginationAfterReload: true,
      foreignWorkflowHiddenAndApiDenied: true,
      nativeDeepLinkSurvivesReload: true,
      personalUiDoesNotRequestAdministrativeApiOrPluginFrontends: true,
      foreignConversationHiddenAndApiDenied: true,
      logoutRevokesBrowserAndHidesConversation: true,
      uncaughtPageErrors: pageErrors.length,
    };
  } catch (error) {
    const artifacts = process.env.BB_CONTROL_PLANE_BROWSER_ARTIFACTS;
    if (artifacts) {
      await mkdir(artifacts, { recursive: true, mode: 0o700 });
      for (const [index, context] of contexts.entries()) {
        const page = context.pages()[0];
        if (page) {
          await page
            .screenshot({ path: join(artifacts, `failure-${index}.png`) })
            .catch(() => {});
          await writeFile(
            join(artifacts, `failure-${index}.txt`),
            (await page
              .locator("body")
              .innerText()
              .catch(() => "")) +
              "\n" +
              JSON.stringify(
                { pageErrors, requests, identityRequests },
                null,
                2,
              ),
            { mode: 0o600 },
          );
        }
      }
    }
    throw error;
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
  }
}

async function verifyAdministrativeDefinitions({
  browser,
  ready,
  contexts,
  pageErrors,
  command,
  name,
  visible,
}) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 1000 },
  });
  contexts.push(context);
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === ready.origin
      ? route.continue()
      : route.abort(),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${ready.origin}/control-plane/login`);
  await page.getByLabel("Login", { exact: true }).fill("operator");
  await page
    .getByLabel("Password", { exact: true })
    .fill("deployment-check-admin-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`${ready.origin}/`);
  await page.goto(`${ready.origin}/plugins/workflows/definitions`);
  const setup = page.getByRole("button", { name: "Skip setup", exact: true });
  try {
    await page
      .getByRole("heading", { name: "Workflow definitions", exact: true })
      .or(setup)
      .first()
      .waitFor({ state: "visible", timeout: 30000 });
  } catch (error) {
    throw new Error(
      `Administrative workflow page did not load: ${JSON.stringify({
        url: page.url(),
        headingsAndAlerts: await page
          .locator("h1, [role=alert]")
          .allTextContents(),
      })}`,
      { cause: error },
    );
  }
  if (await setup.isVisible()) await setup.click();
  await visible(
    page.getByRole("heading", { name: "Workflow definitions", exact: true }),
  );
  await visible(page.getByRole("region", { name: "Definition editor" }));
  async function response(method, click) {
    const pending = page.waitForResponse(
      (item) =>
        new URL(item.url()).pathname ===
        `/api/v1/plugins/workflows/rpc/${method}`,
    );
    await click();
    const reply = await pending;
    assert.equal(reply.status(), 200, await reply.text());
    const body = await reply.json();
    assert.equal(body.ok, true);
    return body.result;
  }
  async function waitRun(run, expected, projectId) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const { stdout } = await command("docker", [
        "exec",
        name,
        "node",
        "-e",
        "const D=require('better-sqlite3');const n=new D('/srv/bb/plugins/workflows/data.db',{readonly:true}),c=new D('/srv/bb/bb.db',{readonly:true});console.log(JSON.stringify({run:n.prepare('SELECT status,error,result_json FROM workflow_runs WHERE id=?').get(process.argv[1]),binding:c.prepare(\"SELECT b.owner_user_id,b.project_id,u.login FROM control_plane_job_bindings b JOIN control_plane_users u ON u.id=b.owner_user_id WHERE b.object_id=? AND b.kind='workflow-run'\").get(process.argv[1])}));n.close();c.close();",
        run.id,
      ]);
      const actual = JSON.parse(stdout);
      if (actual.run?.status === "failed") throw new Error(actual.run.error);
      if (actual.run?.status === "succeeded") {
        assert.deepEqual(JSON.parse(actual.run.result_json), expected);
        assert.equal(actual.binding.login, expected.owner);
        assert.equal(actual.binding.project_id, projectId);
        return actual.binding.owner_user_id;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Administrative definition run did not complete");
  }
  const saved = [];
  for (const user of ready.users) {
    await page
      .getByRole("button", { name: "New definition", exact: true })
      .click();
    await page.getByLabel("Project ID", { exact: true }).fill(user.projectId);
    await page
      .getByLabel("Origin thread ID", { exact: true })
      .fill(user.threadId);
    const title = `admin-definition-${user.login}`;
    const args = { owner: user.login, revision: 1 };
    await page
      .getByLabel("Definition source", { exact: true })
      .fill(
        `export const meta={name:${JSON.stringify(title)},description:"Administrative native definition"}; return args;`,
      );
    await page
      .getByLabel("Default arguments", { exact: true })
      .fill(JSON.stringify(args));
    const definition = await response("controlPlaneDefinitionCreate", () =>
      page
        .getByRole("button", { name: "Create definition", exact: true })
        .click(),
    );
    assert.equal(definition.revision, 1);
    assert.equal(definition.projectId, user.projectId);
    await visible(
      page.getByRole("heading", {
        name: `Loaded revision 1: ${title}`,
        exact: true,
      }),
    );
    await page
      .getByLabel("Default arguments", { exact: true })
      .fill(JSON.stringify({ ...args, revision: 2 }));
    const updated = await response("controlPlaneDefinitionUpdate", () =>
      page
        .getByRole("button", { name: "Save new revision", exact: true })
        .click(),
    );
    assert.equal(updated.revision, 2);
    await visible(
      page.getByRole("heading", {
        name: `Loaded revision 2: ${title}`,
        exact: true,
      }),
    );
    await page.getByLabel("Revision to load", { exact: true }).fill("1");
    await page
      .getByRole("button", { name: "Load revision", exact: true })
      .click();
    await visible(
      page.getByRole("heading", {
        name: `Loaded revision 1: ${title}`,
        exact: true,
      }),
    );
    await page
      .getByLabel("Default arguments", { exact: true })
      .fill('{"unsaved":true}');
    const run = await response("controlPlaneDefinitionRun", () =>
      page
        .getByRole("button", { name: "Run saved revision", exact: true })
        .click(),
    );
    const ownerUserId = await waitRun(run, args, user.projectId);
    await page
      .getByRole("button", { name: "Save new revision", exact: true })
      .click();
    await visible(page.getByRole("alert"));
    assert.match(
      await page.getByRole("alert").innerText(),
      /revision conflict/u,
    );
    await page
      .getByRole("button", { name: "Load latest revision", exact: true })
      .click();
    await visible(
      page.getByRole("heading", {
        name: `Loaded revision 2: ${title}`,
        exact: true,
      }),
    );
    await page
      .getByRole("button", { name: "Disable definition", exact: true })
      .click();
    await visible(
      page.getByRole("button", { name: "Enable definition", exact: true }),
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Run saved revision", exact: true })
        .isDisabled(),
      true,
    );
    const denied = await context.request.post(
      `${ready.origin}/api/v1/plugins/workflows/rpc/controlPlaneDefinitionRun`,
      {
        headers: { origin: ready.origin },
        data: { id: definition.id, revision: 1 },
      },
    );
    assert.equal(denied.ok(), false);
    await page
      .getByRole("button", { name: "Enable definition", exact: true })
      .click();
    await visible(
      page.getByRole("button", { name: "Disable definition", exact: true }),
    );
    saved.push({ ...definition, title, ownerUserId });
  }
  await page.reload();
  for (const item of saved) {
    await visible(page.getByRole("button", { name: item.title, exact: true }));
    const row = page.getByRole("row").filter({
      has: page.getByRole("button", { name: item.title, exact: true }),
    });
    assert.match(await row.innerText(), new RegExp(item.ownerUserId, "u"));
    assert.match(await row.innerText(), new RegExp(item.projectId, "u"));
    await row.getByRole("button", { name: item.title, exact: true }).click();
    await visible(
      page.getByRole("heading", {
        name: `Loaded revision 2: ${item.title}`,
        exact: true,
      }),
    );
    await response("controlPlaneDefinitionRemove", () =>
      page
        .getByRole("button", { name: "Delete definition", exact: true })
        .click(),
    );
    await page
      .getByRole("button", { name: item.title, exact: true })
      .waitFor({ state: "detached" });
    assert.equal(
      await page.getByRole("button", { name: item.title, exact: true }).count(),
      0,
    );
  }
  const artifacts = process.env.BB_CONTROL_PLANE_BROWSER_ARTIFACTS;
  if (artifacts)
    await page.screenshot({
      path: join(artifacts, "administrative-definitions.png"),
    });
  await page.goto(`${ready.origin}/control-plane/logout`);
  await page
    .getByRole("button", { name: "Sign out of BB administration", exact: true })
    .click();
  await page.waitForURL(`${ready.origin}/control-plane/login`);
  assert.equal(
    (
      await context.request.post(
        `${ready.origin}/api/v1/plugins/workflows/rpc/controlPlaneDefinitionInventory`,
        {
          headers: { origin: ready.origin },
          data: { cursor: null, limit: 20 },
        },
      )
    ).status(),
    401,
  );
  return {
    nativeAdministrativeDefinitionUiRendered: true,
    administrativeDefinitionsShowBothOwners: true,
    administrativeDefinitionsCrudAndImmutableRevisionRun: true,
    administrativeDefinitionRunAdoptsEachSavedOwner: true,
    administrativeUiRejectsStaleRevisionSave: true,
    administrativeUiDisableCannotBeBypassedByAdminRun: true,
    administrativeUiLogoutRevokesNativeRpc: true,
  };
}

async function verifyBrowserDefinitions(page, foreign, user, origin, visible) {
  const name = `browser-definition-${user.login}`;
  const source = page.getByRole("textbox", {
    name: "Workflow source",
    exact: true,
  });
  const args = page.getByRole("textbox", {
    name: "Workflow arguments (JSON)",
    exact: true,
  });
  await source.fill(
    `export const meta={name:"${name}",description:"Browser saved definition"}; return await agent("BB_PERSONAL_workflow-agent-${user.login}");`,
  );
  await args.fill(JSON.stringify({ saved: user.login, revision: 1 }));
  const created = page.waitForResponse(
    (reply) =>
      new URL(reply.url()).pathname ===
        "/control-plane/user/workflow-definitions" &&
      reply.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Save new definition", exact: true })
    .click();
  const response = await created;
  assert.equal(response.status(), 201);
  const definition = await response.json();
  assert.equal(definition.revision, 1);
  assert.equal(definition.projectId, user.projectId);
  const path = `/control-plane/user/workflow-definitions/${definition.id}`;
  await visible(
    page.getByText(`Definition ${definition.id} · v1 · enabled`, {
      exact: true,
    }),
  );
  assert.equal(
    (await foreign.context.request.get(origin + path)).status(),
    404,
  );
  assert.equal(
    (
      await foreign.context.request.post(origin + path + "/run", {
        headers: { origin },
        data: { revision: 1 },
      })
    ).status(),
    404,
  );
  async function runSaved(expected) {
    const pending = page.waitForResponse(
      (reply) =>
        new URL(reply.url()).pathname === path + "/run" &&
        reply.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Run saved workflow", exact: true })
      .click();
    const reply = await pending;
    assert.equal(reply.status(), 201);
    const run = await reply.json();
    await visible(page.getByText(`Run ${run.id}`, { exact: true }));
    await visible(page.getByLabel("Workflow result", { exact: true }));
    const text = await page
      .getByLabel("Workflow result", { exact: true })
      .textContent();
    assert.deepEqual(
      typeof expected === "string" ? text : JSON.parse(text),
      expected,
    );
  }
  await runSaved(`Personal workflow-agent-${user.login} completed`);
  await source.fill(
    `export const meta={name:"${name}",description:"Browser revised definition"}; return args;`,
  );
  await args.fill(JSON.stringify({ saved: user.login, revision: 2 }));
  const updating = page.waitForResponse(
    (reply) =>
      new URL(reply.url()).pathname === path &&
      reply.request().method() === "PUT",
  );
  await page
    .getByRole("button", { name: "Update saved definition", exact: true })
    .click();
  const updated = await updating;
  assert.equal(updated.status(), 200);
  assert.equal((await updated.json()).revision, 2);
  await visible(
    page.getByText(`Definition ${definition.id} · v2 · enabled`, {
      exact: true,
    }),
  );
  await runSaved({ saved: user.login, revision: 2 });
  await page
    .getByRole("button", { name: "Disable definition", exact: true })
    .click();
  await visible(
    page.getByRole("button", { name: "Enable definition", exact: true }),
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Run saved workflow", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByRole("button", { name: "Enable definition", exact: true })
    .click();
  await visible(
    page.getByText(`Definition ${definition.id} · v2 · enabled`, {
      exact: true,
    }),
  );
  await page.reload();
  await page
    .getByRole("button", { name: `Load ${name} · v2`, exact: true })
    .click();
  await visible(
    page.getByText(`Definition ${definition.id} · v2 · enabled`, {
      exact: true,
    }),
  );
  assert.deepEqual(JSON.parse(await args.inputValue()), {
    saved: user.login,
    revision: 2,
  });
  const deleting = page.waitForResponse(
    (reply) =>
      new URL(reply.url()).pathname === path &&
      reply.request().method() === "DELETE",
  );
  await page
    .getByRole("button", { name: "Delete definition", exact: true })
    .click();
  assert.equal((await deleting).status(), 200);
  await page
    .getByRole("button", { name: `Load ${name} · v2`, exact: true })
    .waitFor({ state: "hidden" });
  assert.equal((await page.context().request.get(origin + path)).status(), 404);
}
