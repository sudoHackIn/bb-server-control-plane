import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

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
    return { page, context };
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
          .filter({ hasText: /^cancelled(?: ·|$)/u }),
      );
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
    return {
      productionBrowserRenderingVerified: true,
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
              JSON.stringify({ pageErrors, requests }, null, 2),
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
    assert.deepEqual(
      JSON.parse(
        await page.getByLabel("Workflow result", { exact: true }).textContent(),
      ),
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
