import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  ControlPlaneRegistry,
  controlPlaneProjectAccess,
  createControlPlaneProject,
  createEnvironment,
  createThread,
} from "@bb/db";
import {
  threadScope,
  turnScope,
  encodeClientTurnRequestIdNumber,
} from "@bb/domain";
import { createControlPlaneClient } from "@bb/sdk/node";
import { createApp } from "../../src/server.js";
import { createControlPlaneAccess } from "../../src/control-plane/access.js";
import { createControlPlaneUserAccess } from "../../src/control-plane/user-access.js";
import { createControlPlaneThreadService } from "../../src/control-plane/threads.js";
import { hashAdminPassword } from "../../src/control-plane/credentials.js";
import { withTestHarness } from "../helpers/test-app.js";
import { seedHostSession, seedEvent } from "../helpers/seed.js";
import { seedControlPlaneProfile } from "../helpers/control-plane-profile.js";

it("paginates native owned history and hydrates tools while denying foreign threads, transplanted cursors and revoked project grants", async () => {
  await withTestHarness(async (harness) => {
    const registry = new ControlPlaneRegistry(harness.db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 200010,
    });
    const { host } = seedHostSession(harness.deps);
    const owners = ["alice", "bob"].map((login) => {
      const user = registry.reserve(login, 1);
      registry.environmentState(user.id, "ready");
      const { project } = createControlPlaneProject(harness.db, harness.hub, {
        userId: user.id,
        hostId: host.id,
        name: login,
        slug: "app",
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        hostId: host.id,
        projectId: project.id,
        path: `${user.projectsRoot}/app`,
        status: "ready",
        providerOwnsPath: false,
      });
      const profile = seedControlPlaneProfile(harness.db, user.id);
      const thread = createThread(harness.db, harness.hub, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "qwen-server",
        controlPlaneOwnerUserId: user.id,
        controlPlaneProfileVersionId: profile.versionId,
        status: "idle",
      });
      let sequence = 0;
      const append = (
        type: Parameters<typeof seedEvent>[1]["type"],
        scope: ReturnType<typeof turnScope> | ReturnType<typeof threadScope>,
        data: Record<string, unknown>,
      ) =>
        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId: "qwen-session",
          sequence: ++sequence,
          type,
          scope,
          data,
        });
      for (let index = 0; index < 25; index++) {
        const requestId = encodeClientTurnRequestIdNumber({ value: index + 1 });
        const scope = turnScope(`history-${index}`);
        append("client/turn/requested", threadScope(), {
          direction: "outbound",
          source: "tell",
          initiator: "user",
          request: { method: "turn/start", params: {} },
          requestId,
          senderThreadId: null,
          input: [
            { type: "text", text: `${login} history ${index}`, mentions: [] },
          ],
          target: index === 0 ? { kind: "thread-start" } : { kind: "new-turn" },
          execution: {
            model: "test",
            serviceTier: "default",
            reasoningLevel: "none",
            permissionMode: "full",
            source: "client/turn/requested",
          },
        });
        append("turn/started", scope, {});
        append("turn/input/accepted", scope, { clientRequestId: requestId });
        append("item/completed", scope, {
          item: {
            type: "agentMessage",
            id: `answer-${index}`,
            text: `${login} answer ${index}`,
          },
        });
        append("turn/completed", scope, { status: "completed" });
      }
      append("turn/started", turnScope("turn"), {});
      append("item/completed", turnScope("turn"), {
        item: {
          type: "commandExecution",
          id: "cmd",
          command: "echo private",
          cwd: "/srv/test",
          status: "completed",
          approvalStatus: null,
          exitCode: 0,
          aggregatedOutput: `${login} private output`,
        },
      });
      append("turn/completed", turnScope("turn"), { status: "completed" });
      const token = `agt_${randomBytes(32).toString("base64url")}`;
      registry.createSession(
        user.id,
        createHash("sha256").update(token).digest("hex"),
        Date.now() + 60000,
        Date.now(),
        null,
      );
      return { user, project, thread, token };
    });
    const alice = owners[0]!,
      bob = owners[1]!;
    const origin = "https://bb.example";
    harness.config.appUrl = origin;
    const threads = createControlPlaneThreadService({ deps: harness.deps });
    const server = createApp(harness.deps, {
      controlPlane: createControlPlaneAccess(
        {
          version: 1,
          publicOrigin: origin,
          admin: {
            login: "admin",
            passwordHash: await hashAdminPassword("test-password-long-enough"),
          },
        },
        Date.now,
        createControlPlaneUserAccess(
          registry,
          origin,
          Date.now,
          undefined,
          threads,
        ),
      ),
    });
    const client = (token: string) =>
      createControlPlaneClient({
        origin,
        token: () => token,
        fetch: async (input, init) =>
          server.app.fetch(new Request(input, init)),
      }).threads;
    const api = client(alice.token);
    const input = {
      turnId: "turn",
      sourceSeqStart: 126,
      sourceSeqEnd: 128,
      itemId: "cmd",
    };
    try {
      const latest = await api.timeline(alice.thread.id);
      expect(latest.timelinePage.olderCursor).not.toBeNull();
      if (!latest.timelinePage.olderCursor)
        throw new Error("Missing history cursor");
      const older = await api.olderTimeline(
        alice.thread.id,
        latest.timelinePage.olderCursor,
      );
      expect(JSON.stringify(older.rows)).toContain("alice history 0");
      expect(JSON.stringify(older.rows)).not.toContain("bob history");
      const details = await api.timelineDetails(alice.thread.id, input);
      expect(details.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "work",
            callId: "cmd",
            output: "alice private output",
          }),
        ]),
      );
      await expect(api.timelineDetails(bob.thread.id, input)).rejects.toThrow(
        "404",
      );
      await expect(
        api.olderTimeline(bob.thread.id, latest.timelinePage.olderCursor),
      ).rejects.toThrow("404");
      const bobLatest = await client(bob.token).timeline(bob.thread.id);
      if (!bobLatest.timelinePage.olderCursor)
        throw new Error("Missing foreign cursor");
      await expect(
        api.olderTimeline(alice.thread.id, bobLatest.timelinePage.olderCursor),
      ).rejects.toThrow("400");
      await expect(
        api.timelineDetails(alice.thread.id, { ...input, sourceSeqStart: 129 }),
      ).rejects.toThrow();
      for (const suffix of [
        "timeline?beforeAnchorSeq=1",
        "timeline?beforeAnchorId=bad",
        "timeline?includeNestedRows=true",
        "timeline-details?turnId=turn&sourceSeqStart=126&sourceSeqEnd=128&environmentId=foreign",
      ]) {
        const response = await server.app.request(
          `/control-plane/user/threads/${alice.thread.id}/${suffix}`,
          { headers: { authorization: `Bearer ${alice.token}` } },
        );
        expect(response.status, suffix).toBe(400);
      }
      harness.db
        .delete(controlPlaneProjectAccess)
        .where(
          and(
            eq(controlPlaneProjectAccess.projectId, alice.project.id),
            eq(controlPlaneProjectAccess.userId, alice.user.id),
          ),
        )
        .run();
      await expect(api.timelineDetails(alice.thread.id, input)).rejects.toThrow(
        "404",
      );
      await expect(
        api.olderTimeline(alice.thread.id, latest.timelinePage.olderCursor),
      ).rejects.toThrow("404");
    } finally {
      await server.pluginService.stop();
      await server.closeWebSockets();
    }
  });
});
