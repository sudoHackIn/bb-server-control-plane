import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";

export async function verifyBrowserProjectMcp({
  actors,
  origin,
  command,
  container,
  visible,
}) {
  const base = "/control-plane/user/mcp/connectors";
  const saved = [];
  async function operation(page, path, method, action) {
    const waiting = page.waitForResponse(
      (reply) =>
        new URL(reply.url()).pathname === path &&
        reply.request().method() === method,
    );
    await action();
    const response = await waiting;
    assert.equal(response.status(), 200, "MCP browser operation failed");
    return response.json();
  }
  for (const { actor, user } of actors) {
    const page = actor.page;
    const returnUrl = page.url();
    await page
      .getByRole("button", { name: "Integrations", exact: true })
      .click();
    await visible(
      page.getByRole("heading", { name: "Integrations", exact: true }),
    );
    assert.equal(
      await page.getByRole("textbox", { name: "Message your agent…" }).count(),
      0,
    );
    await page
      .getByLabel("Approved connector", { exact: true })
      .selectOption({ label: "Browser integration" });
    const token = page.getByLabel("Personal token", { exact: true });
    await visible(token);
    assert.equal(
      await page
        .getByRole("button", { name: "Connect to project", exact: true })
        .isDisabled(),
      true,
    );
    const secret = "browser-private-" + user.login + "-mcp-fixture";
    await token.fill(secret);
    const credentialResponse = page.waitForResponse(
      (reply) =>
        new URL(reply.url()).pathname.startsWith(base + "/") &&
        reply.url().endsWith("/credential") &&
        reply.request().method() === "PUT",
    );
    await page
      .getByRole("button", { name: "Save personal token", exact: true })
      .click();
    const response = await credentialResponse;
    assert.equal(response.status(), 200);
    const credential = await response.json();
    assert.equal(credential.revision, 1);
    assert.equal(await token.inputValue(), "");
    const connectorId = credential.connectorId;
    const path = `/control-plane/user/projects/${user.projectId}/mcp`;
    const connection = await operation(page, path, "PUT", () =>
      page
        .getByRole("button", { name: "Connect to project", exact: true })
        .click(),
    );
    assert.equal(connection.enabled, true);
    assert.equal(connection.revision, 1);
    const stale = await actor.context.request.put(origin + path, {
      headers: { origin },
      data: {
        connectorId,
        connectorRevision: 1,
        expectedRevision: 0,
        enabled: true,
      },
    });
    assert.equal(stale.status(), 409);
    const disabled = await operation(page, path, "PUT", () =>
      page
        .getByRole("button", { name: "Disable connection", exact: true })
        .click(),
    );
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.revision, 2);
    const enabled = await operation(page, path, "PUT", () =>
      page
        .getByRole("button", { name: "Update and enable", exact: true })
        .click(),
    );
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.revision, 3);
    assert.equal(
      (await page.locator("body").innerText()).includes(secret),
      false,
    );
    assert.equal(
      await page.evaluate(
        (value) =>
          [
            ...Object.values(localStorage),
            ...Object.values(sessionStorage),
          ].some((item) => item.includes(value)),
        secret,
      ),
      false,
    );
    const artifacts = process.env.BB_CONTROL_PLANE_BROWSER_ARTIFACTS;
    if (artifacts) {
      await mkdir(artifacts, { recursive: true, mode: 0o700 });
      await page.screenshot({
        path: join(artifacts, "project-integrations-" + user.login + ".png"),
      });
      if (user.login === "bob") {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        assert.equal(await page.locator("header").count(), 1);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          true,
        );
        await page.screenshot({
          path: join(artifacts, "project-integrations-mobile.png"),
        });
        await page.setViewportSize({ width: 1280, height: 900 });
      }
    }
    saved.push({
      actor,
      user,
      connectorId,
      connectionId: connection.id,
      returnUrl,
    });
  }
  const [alice, bob] = saved;
  const grant = async (allowed) => {
    const script =
      'const D=require("better-sqlite3"),db=new D("/srv/bb/bb.db");const [project,user,allowed]=process.argv.slice(1);if(allowed==="true")db.prepare("INSERT INTO control_plane_project_access(project_id,user_id,role) VALUES (?,?,?)").run(project,user,"viewer");else db.prepare("DELETE FROM control_plane_project_access WHERE project_id=? AND user_id=?").run(project,user);db.close();';
    const idScript =
      'const D=require("better-sqlite3"),db=new D("/srv/bb/bb.db",{readonly:true});console.log(db.prepare("SELECT id FROM control_plane_users WHERE login=?").get("bob").id);db.close();';
    const result = await command("docker", [
      "exec",
      "--user",
      "1000:1000",
      container,
      "node",
      "-e",
      idScript,
    ]);
    await command("docker", [
      "exec",
      "--user",
      "1000:1000",
      container,
      "node",
      "-e",
      script,
      alice.user.projectId,
      result.stdout.trim(),
      String(allowed),
    ]);
  };
  await grant(true);
  try {
    await bob.actor.page.goto(
      `${origin}/projects/${alice.user.projectId}?view=integrations`,
    );
    await visible(
      bob.actor.page.getByRole("heading", {
        name: "Integrations",
        exact: true,
      }),
    );
    await bob.actor.page
      .getByLabel("Approved connector", { exact: true })
      .selectOption({ label: "Browser integration" });
    await visible(bob.actor.page.getByLabel("Personal token", { exact: true }));
    assert.equal(
      await bob.actor.page
        .getByRole("button", {
          name: /Connect to project|Update and enable|Disable connection|Remove Browser integration/u,
        })
        .count(),
      0,
    );
    const forbidden = await bob.actor.context.request.put(
      `${origin}/control-plane/user/projects/${alice.user.projectId}/mcp`,
      {
        headers: { origin },
        data: {
          connectorId: alice.connectorId,
          connectorRevision: 1,
          expectedRevision: 3,
          enabled: false,
        },
      },
    );
    assert.equal(forbidden.status(), 403);
    const removal = await bob.actor.context.request.delete(
      `${origin}/control-plane/user/projects/${alice.user.projectId}/mcp/${alice.connectionId}`,
      { headers: { origin }, data: { expectedRevision: 3 } },
    );
    assert.equal(removal.status(), 403);
    await operation(
      bob.actor.page,
      `${base}/${bob.connectorId}/credential`,
      "DELETE",
      () =>
        bob.actor.page
          .getByRole("button", { name: "Forget personal token", exact: true })
          .click(),
    );
    const own = await alice.actor.context.request.get(
      `${origin}${base}/${alice.connectorId}/credential`,
    );
    assert.equal((await own.json()).configured, true);
    await bob.actor.page
      .getByLabel("Personal token", { exact: true })
      .fill("unsent-private-browser-draft");
  } finally {
    await grant(false);
  }
  await bob.actor.page
    .getByRole("button", { name: "Refresh integrations", exact: true })
    .click();
  await visible(bob.actor.page.getByRole("alert"));
  assert.equal(
    await bob.actor.page.getByLabel("Personal token", { exact: true }).count(),
    0,
  );
  for (const entry of saved) {
    const { page } = entry.actor;
    const cleanupUrl = new URL(entry.returnUrl);
    cleanupUrl.searchParams.set("view", "integrations");
    await page.goto(cleanupUrl.href);
    await visible(
      page.getByRole("heading", { name: "Integrations", exact: true }),
    );
    await page
      .getByLabel("Approved connector", { exact: true })
      .selectOption({ label: "Browser integration" });
    await visible(page.getByLabel("Personal token", { exact: true }));
    if (entry === alice)
      await operation(
        page,
        `${base}/${entry.connectorId}/credential`,
        "DELETE",
        () =>
          page
            .getByRole("button", { name: "Forget personal token", exact: true })
            .click(),
      );
    const path = `/control-plane/user/projects/${entry.user.projectId}/mcp`;
    await operation(page, path + "/" + entry.connectionId, "DELETE", () =>
      page
        .getByRole("button", {
          name: "Remove Browser integration",
          exact: true,
        })
        .click(),
    );
    await page
      .getByRole("button", { name: "Remove Browser integration", exact: true })
      .waitFor({ state: "hidden" });
    assert.equal(
      await page
        .getByRole("button", { name: "Connect to project", exact: true })
        .isDisabled(),
      true,
    );
    await page.goto(entry.returnUrl);
    await visible(page.getByRole("textbox", { name: "Message your agent…" }));
  }
  return {
    projectMcpBrowserTwoUserCrudAndCas: true,
    projectMcpBrowserPatClearedAndAbsentFromWebStorage: true,
    projectMcpBrowserSharedReaderCannotChangeConnections: true,
    projectMcpBrowserSharedCredentialRevocationUsesOwnIdentity: true,
    projectMcpBrowserAccessLossHidesDraftAndMetadata: true,
  };
}
