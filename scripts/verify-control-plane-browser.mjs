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
    assert.equal(await locator.isVisible(), true);
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
