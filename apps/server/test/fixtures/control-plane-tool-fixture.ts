import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createConnection,
  createControlPlaneProfile,
  createThread,
  noopNotifier,
  requireControlPlaneThreadDispatch,
  setControlPlaneProfileAccess,
} from "@bb/db";
import { Hono } from "hono";
import {
  createControlPlaneAccess,
  currentControlPlanePrincipal,
} from "../../src/control-plane/access.js";
import {
  filterControlPlaneTools,
  withControlPlaneToolAuthority,
} from "../../src/control-plane/tool-authority.js";

export async function verifyToolFixture(threadId: string) {
  const db = createConnection("/srv/bb/bb.db");
  try {
    const source = requireControlPlaneThreadDispatch(db, threadId);
    assert.ok(source);
    const profile = createControlPlaneProfile(db, {
      slug: `tool-${randomUUID()}`,
      name: "Delegated fixture",
      definition: {
        ...source.profileVersion.definition,
        tools: ["bb:approved_fixture", "bb:update_environment_directory"],
        mcpServers: ["bb"],
      },
    });
    setControlPlaneProfileAccess(db, profile.profileId, source.user.id, true);
    const thread = createThread(db, noopNotifier, {
      projectId: source.thread.projectId,
      environmentId: source.thread.environmentId,
      providerId: "qwen-server",
      controlPlaneOwnerUserId: source.user.id,
      controlPlaneProfileVersionId: profile.versionId,
      status: "active",
    });
    assert.deepEqual(
      filterControlPlaneTools(
        db,
        thread.id,
        ["approved_fixture", "foreign_tool", "update_environment_directory"],
        (name) => name,
      ),
      ["approved_fixture"],
    );
    let calls = 0;
    await withControlPlaneToolAuthority(
      db,
      thread.id,
      "approved_fixture",
      async () => {
        await Promise.resolve();
        assert.deepEqual(currentControlPlanePrincipal(), {
          kind: "user",
          userId: source.user.id,
        });
        calls++;
        const access = createControlPlaneAccess({
          version: 1,
          publicOrigin: "https://fixture.invalid",
          admin: {
            login: "fixture",
            passwordHash: "unused-non-authenticated-fixture",
          },
        });
        const app = new Hono();
        app.get("/api/v1/projects", (context) =>
          context.json({ forbidden: true }),
        );
        await assert.rejects(
          access.dispatch(app, "https://fixture.invalid/api/v1/projects"),
          /scoped authorization/,
        );
      },
    );
    assert.equal(calls, 1);
    assert.equal(currentControlPlanePrincipal(), null);
    setControlPlaneProfileAccess(db, profile.profileId, source.user.id, false);
    assert.throws(
      () =>
        withControlPlaneToolAuthority(
          db,
          thread.id,
          "approved_fixture",
          () => calls++,
        ),
      /not authorized/,
    );
    assert.equal(calls, 1);
    return {
      delegatedToolPolicyAndPrincipalInDocker: true,
      userPluginUnscopedSdkDeniedInDocker: true,
    };
  } finally {
    db.$client.close();
  }
}
