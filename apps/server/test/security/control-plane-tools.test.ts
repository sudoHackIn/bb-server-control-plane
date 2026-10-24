import { expect, it } from "vitest";
import {
  ControlPlaneRegistry,
  controlPlaneUsers,
  controlPlaneProjectAccess,
  environments,
  createControlPlaneProfile,
  createControlPlaneProject,
  createEnvironment,
  createThread,
  setControlPlaneProfileAccess,
  setControlPlaneProfileEnabled,
  threads,
} from "@bb/db";
import { eq } from "drizzle-orm";
import { currentControlPlanePrincipal } from "../../src/control-plane/access.js";
import { filterControlPlaneTools } from "../../src/control-plane/tool-authority.js";
import { setPluginAgentContributions } from "../../src/services/plugins/plugin-agent-contributions.js";
import type { PluginAgentToolRecord } from "../../src/services/plugins/plugin-api.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { seedHostSession } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

it("checks each managed daemon tool call against current grants and invokes only with the persisted user principal", async () => {
  await withTestHarness(async (harness) => {
    const registry = new ControlPlaneRegistry(harness.db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 299999,
    });
    const alice = registry.reserve("alice", 1);
    const bob = registry.reserve("bob", 1);
    registry.environmentState(alice.id, "ready");
    registry.environmentState(bob.id, "ready");
    const { host, session } = seedHostSession(harness.deps);
    const { project } = createControlPlaneProject(harness.db, harness.hub, {
      userId: alice.id,
      hostId: host.id,
      name: "App",
      slug: "app",
    });
    const environment = createEnvironment(harness.db, harness.hub, {
      projectId: project.id,
      hostId: host.id,
      path: `${alice.projectsRoot}/app`,
      status: "ready",
      providerOwnsPath: false,
    });
    const profile = createControlPlaneProfile(harness.db, {
      slug: "delegated",
      name: "Delegated",
      definition: {
        prompt: "Approved",
        providerId: "qwen-server",
        model: "qwen-test",
        reasoningLevel: "none",
        permissionMode: "full",
        tools: [
          "bb:approved_tool",
          "bb:update_environment_directory",
          "bb:bb_workflow_run",
        ],
        mcpServers: ["bb"],
      },
    });
    setControlPlaneProfileAccess(harness.db, profile.profileId, alice.id, true);
    const thread = createThread(harness.db, harness.hub, {
      projectId: project.id,
      environmentId: environment.id,
      status: "active",
      providerId: "qwen-server",
      controlPlaneOwnerUserId: alice.id,
      controlPlaneProfileVersionId: profile.versionId,
    });
    let calls = 0;
    const record: PluginAgentToolRecord = {
      name: "approved_tool",
      description: "Fixture",
      instructions: null,
      presentation: null,
      inputSchema: {},
      parse: (value) => ({ ok: true, value }),
      execute: () => "unused",
    };
    setPluginAgentContributions({
      listSkillRootContributions: () => [],
      listAgentTools: () => [],
      listInstructionContributions: () => [],
      findAgentTool: (name) =>
        name === record.name ? { pluginId: "fixture", record } : undefined,
      resolveMention: async () => ({ ok: false, error: "unused" }),
      invokeAgentTool: async ({ ctx }) => {
        await Promise.resolve();
        expect(ctx.threadId).toBe(thread.id);
        expect(ctx.projectId).toBe(project.id);
        expect(currentControlPlanePrincipal()).toEqual({
          kind: "user",
          userId: alice.id,
        });
        calls++;
        return {
          success: true,
          contentItems: [{ type: "inputText", text: "Approved invocation" }],
        };
      },
    });
    const invoke = (tool = "approved_tool") =>
      harness.app.request("/internal/session/tool-call", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          threadId: thread.id,
          providerThreadId: "provider",
          turnId: "turn",
          callId: "call",
          tool,
          arguments: {
            userId: bob.id,
            projectId: "foreign",
            threadId: "foreign",
          },
        }),
      });
    try {
      expect(
        filterControlPlaneTools(
          harness.db,
          thread.id,
          [
            "approved_tool",
            "foreign_tool",
            "update_environment_directory",
            "bb_workflow_run",
          ],
          (value) => value,
        ),
      ).toEqual(["approved_tool"]);
      const ok = await invoke();
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ success: true });
      expect(calls).toBe(1);
      for (const tool of [
        "foreign_tool",
        "update_environment_directory",
        "bb_workflow_run",
      ])
        expect((await invoke(tool)).status).toBe(403);
      for (const change of [
        {
          revoke: () =>
            harness.db
              .update(controlPlaneProjectAccess)
              .set({ role: "viewer" })
              .where(eq(controlPlaneProjectAccess.userId, alice.id))
              .run(),
          restore: () =>
            harness.db
              .update(controlPlaneProjectAccess)
              .set({ role: "owner" })
              .where(eq(controlPlaneProjectAccess.userId, alice.id))
              .run(),
        },
        {
          revoke: () =>
            harness.db
              .update(environments)
              .set({ path: bob.projectsRoot })
              .where(eq(environments.id, environment.id))
              .run(),
          restore: () =>
            harness.db
              .update(environments)
              .set({ path: `${alice.projectsRoot}/app` })
              .where(eq(environments.id, environment.id))
              .run(),
        },
        {
          revoke: () =>
            setControlPlaneProfileAccess(
              harness.db,
              profile.profileId,
              alice.id,
              false,
            ),
          restore: () =>
            setControlPlaneProfileAccess(
              harness.db,
              profile.profileId,
              alice.id,
              true,
            ),
        },
        {
          revoke: () =>
            setControlPlaneProfileEnabled(
              harness.db,
              profile.profileId,
              false,
              profile.versionId,
            ),
          restore: () =>
            setControlPlaneProfileEnabled(
              harness.db,
              profile.profileId,
              true,
              profile.versionId,
            ),
        },
        {
          revoke: () =>
            harness.db
              .update(controlPlaneUsers)
              .set({ enabled: false })
              .where(eq(controlPlaneUsers.id, alice.id))
              .run(),
          restore: () =>
            harness.db
              .update(controlPlaneUsers)
              .set({ enabled: true })
              .where(eq(controlPlaneUsers.id, alice.id))
              .run(),
        },
        {
          revoke: () =>
            harness.db
              .update(threads)
              .set({ status: "idle" })
              .where(eq(threads.id, thread.id))
              .run(),
          restore: () =>
            harness.db
              .update(threads)
              .set({ status: "active" })
              .where(eq(threads.id, thread.id))
              .run(),
        },
      ]) {
        change.revoke();
        expect((await invoke()).status).toBe(403);
        expect(calls).toBe(1);
        change.restore();
      }
      expect((await invoke()).status).toBe(200);
      expect(calls).toBe(2);
      expect(currentControlPlanePrincipal()).toBeNull();
    } finally {
      setPluginAgentContributions(undefined);
    }
  });
});
