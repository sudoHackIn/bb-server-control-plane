import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  ControlPlaneRegistry,
  controlPlaneUserSessions,
  controlPlaneProjectAccess,
  controlPlaneJobBindings,
  createControlPlaneJobBinding,
  createThread,
  events,
  noopNotifier,
  setControlPlaneProfileAccess,
  controlPlaneUsers,
  controlPlaneProjectPolicies,
} from "@bb/db";
import { jsonValueSchema, CONTROL_PLANE_WORKFLOWS_PLUGIN_ID } from "@bb/domain";
import { createControlPlaneClient } from "@bb/sdk/node";
import { eq } from "drizzle-orm";
import { withTestHarness } from "../helpers/test-app.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { createControlPlaneBackgroundJobs } from "../../src/control-plane/background-jobs.js";
import { createControlPlaneInspectionService } from "../../src/control-plane/inspections.js";
import {
  createControlPlaneWorkflowService,
  createControlPlaneWorkflowRpc,
  type ControlPlaneWorkflowRpc,
} from "../../src/control-plane/workflows.js";
import { createControlPlaneThreadService } from "../../src/control-plane/threads.js";
import {
  createControlPlaneAccess,
  withControlPlaneService,
} from "../../src/control-plane/access.js";
import { createControlPlaneUserAccess } from "../../src/control-plane/user-access.js";
import { hashAdminPassword } from "../../src/control-plane/credentials.js";
import {
  withControlPlaneInspectionRead,
  isControlPlaneInspectionRead,
} from "../../src/control-plane/inspection-context.js";
import { createApp } from "../../src/server.js";

it("separates diagnostic grants from invocation/project access, scopes worker reads, and fences revoked requests and streams", async () => {
  await withTestHarness(async (harness) => {
    const { alice, bob } = seedControlPlaneJobSubjects(harness.db);
    const registry = new ControlPlaneRegistry(harness.db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 299999,
    });
    const reviewer = registry.reserve("reviewer", 1);
    registry.environmentState(reviewer.id, "ready");
    const fake = createFakePluginHost({ pluginId: "workflows" });
    const facade = createControlPlaneBackgroundJobs(
      harness.db,
      "workflows",
      true,
    );
    Object.defineProperty(
      fake.bb.server,
      "internal_DO_NOT_USE_backgroundJobs",
      { value: facade },
    );
    const directory = await mkdtemp(
      join(harness.config.dataDir, "inspection-native-"),
    );
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const out = join(directory, "fixture.mjs");
    const sdkPath = fileURLToPath(
      new URL("../../../../packages/plugin-sdk/dist/index.js", import.meta.url),
    );
    await build({
      entryPoints: [
        fileURLToPath(
          new URL(
            "../../../../plugins/workflows/src/testing/inspection-fixture.ts",
            import.meta.url,
          ),
        ),
      ],
      outfile: out,
      bundle: true,
      platform: "node",
      format: "esm",
      plugins: [
        {
          name: "sdk-boundary",
          setup(b) {
            b.onResolve({ filter: /^@get-bb\/plugin-sdk$/ }, () => ({
              path: sdkPath,
              external: true,
            }));
          },
        },
      ],
      banner: {
        js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
      },
      logLevel: "silent",
    });
    const imported: unknown = await import(pathToFileURL(out).href);
    const native = z
      .object({
        default: z.custom<
          (bb: BbPluginApi) => {
            seedCall: (
              runId: string,
              threadId: string,
            ) => { callId: string; attemptId: string };
            replayReference: (callId: string, original: string) => void;
          }
        >((value) => typeof value === "function"),
      })
      .parse(imported)
      .default(fake.bb);
    let hold: { entered: () => void; wait: Promise<void> } | null = null;
    let mutationProbe = false;
    const rpc: ControlPlaneWorkflowRpc = async (method, input) => {
      if (isControlPlaneInspectionRead() && mutationProbe) {
        expect(() => facade.withAuthority("invalid", () => null)).toThrow(
          "Inspection",
        );
        expect(() => facade.stopWorker("invalid", "worker")).toThrow(
          "Inspection",
        );
      }
      if (hold && method === "controlPlaneWorkflowInspection") {
        hold.entered();
        await hold.wait;
      }
      return jsonValueSchema.parse(await fake.harness.callRpc(method, input));
    };
    const inspection = createControlPlaneInspectionService(harness.deps, rpc);
    const ordinary = createControlPlaneWorkflowService(harness.db, rpc);
    const origin = "https://bb.example";
    harness.config.appUrl = origin;
    const server = createApp(harness.deps, {
      controlPlane: createControlPlaneAccess(
        {
          version: 1,
          publicOrigin: origin,
          admin: {
            login: "admin",
            passwordHash: await hashAdminPassword("inspection-password"),
          },
        },
        Date.now,
        createControlPlaneUserAccess(
          registry,
          origin,
          Date.now,
          undefined,
          createControlPlaneThreadService({ deps: harness.deps }),
          ordinary,
          undefined,
          undefined,
          inspection,
        ),
      ),
    });
    const tokens = new Map<string, string>();
    for (const user of [alice.user, bob.user, reviewer]) {
      const token = `agt_${randomBytes(32).toString("base64url")}`;
      tokens.set(user.id, token);
      harness.db
        .insert(controlPlaneUserSessions)
        .values({
          userId: user.id,
          digest: createHash("sha256").update(token).digest("hex"),
          expiresAt: Date.now() + 600000,
        })
        .run();
    }
    const transport: typeof fetch = async (input, init) =>
      server.app.fetch(new Request(input, init));
    const api = (id: string) =>
      createControlPlaneClient({
        origin,
        token: () => tokens.get(id) ?? null,
        fetch: transport,
      });
    const aliceApi = api(alice.user.id),
      bobApi = api(bob.user.id),
      reviewApi = api(reviewer.id);
    const login = await server.app.request("/control-plane/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "admin", password: "inspection-password" }),
    });
    const adminToken = z
      .object({ token: z.string() })
      .parse(await login.json()).token;
    const admin = createControlPlaneClient({
      origin,
      token: () => adminToken,
      fetch: transport,
    });
    async function seed(subject: typeof alice) {
      const root = await api(subject.user.id).workflows.start({
        originThreadId: subject.thread.id,
        script:
          'export const meta={name:"inspection",description:"read fixture"}; return null;',
      });
      const parent = harness.db
        .select()
        .from(controlPlaneJobBindings)
        .where(eq(controlPlaneJobBindings.objectId, root.id))
        .get();
      expect(parent).toBeTruthy();
      if (!parent) throw new Error("No parent");
      const worker = createControlPlaneJobBinding(harness.db, {
        kind: "workflow-worker",
        objectId: randomUUID(),
        revision: 1,
        userId: subject.user.id,
        projectId: subject.project.id,
        profileVersionId: subject.profile.versionId,
        originThreadId: subject.thread.id,
        sourceBindingId: parent.id,
      });
      const thread = createThread(harness.db, noopNotifier, {
        projectId: subject.project.id,
        environmentId: subject.environment.id,
        providerId: "qwen-server",
        originPluginId: CONTROL_PLANE_WORKFLOWS_PLUGIN_ID,
        controlPlaneOwnerUserId: subject.user.id,
        controlPlaneProfileVersionId: subject.profile.versionId,
        controlPlaneJobBindingId: worker.id,
      });
      const detail = native.seedCall(root.id, thread.id);
      harness.db
        .insert(events)
        .values({
          id: randomUUID(),
          threadId: thread.id,
          scopeKind: "turn",
          turnId: "turn",
          providerThreadId: "qwen",
          sequence: 1,
          type: "item/completed",
          itemKind: "fileChange",
          createdAt: Date.now(),
          data: JSON.stringify({
            providerThreadId: "qwen",
            item: {
              id: "file",
              type: "fileChange",
              status: "completed",
              approvalStatus: null,
              changes: [
                {
                  path: `${subject.user.login}.puml`,
                  kind: "add",
                  diff: `+private-${subject.user.login}`,
                },
              ],
            },
          }),
        })
        .run();
      return { ...detail, runId: root.id, threadId: thread.id };
    }
    try {
      const a = await seed(alice),
        b = await seed(bob),
        sibling = await seed(alice);
      const raw = (
        token: string,
        path: string,
        method = "GET",
        body?: object,
      ) =>
        server.app.request(path, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      const project = alice.project.id;
      expect(
        (
          await inspection
            .forActor({
              kind: "user",
              userId: alice.user.id,
              authorized: () => true,
            })
            .workflows.inspect(a.runId, -1, 20)
        ).run.id,
      ).toBe(a.runId);
      expect(
        (await aliceApi.inspections.workflows.inspect(a.runId)).run.id,
      ).toBe(a.runId);
      harness.db
        .insert(controlPlaneProjectAccess)
        .values({ projectId: project, userId: bob.user.id, role: "viewer" })
        .run();
      setControlPlaneProfileAccess(
        harness.db,
        alice.profile.profileId,
        bob.user.id,
        true,
      );
      await expect(
        bobApi.inspections.workflows.inspect(a.runId),
      ).rejects.toThrow("404");
      await expect(
        admin.admin.diagnosticGrants.set(project, reviewer.id, {
          role: "reviewer",
          expectedRevision: 0,
        }),
      ).resolves.toEqual({ ok: true });
      await expect(
        reviewApi.inspections.workflows.inspect(a.runId),
      ).rejects.toThrow("404");
      harness.db
        .insert(controlPlaneProjectAccess)
        .values({ projectId: project, userId: reviewer.id, role: "viewer" })
        .run();
      mutationProbe = true;
      expect(
        (await reviewApi.inspections.workflows.inspect(a.runId)).run.id,
      ).toBe(a.runId);
      const detail = await reviewApi.inspections.workflows.inspectCall(
        a.runId,
        a.callId,
      );
      expect(
        detail.diagnostics.entries.some(
          (row) => row.message === "Expected an object",
        ),
      ).toBe(true);
      expect(detail.fileArtifacts.entries[0]).toMatchObject({
        path: "alice.puml",
        diff: "+private-alice",
      });
      const workerApi = reviewApi.inspections.forWorkflow(a.runId).threads;
      expect((await workerApi.get(a.threadId)).id).toBe(a.threadId);
      expect((await workerApi.events(a.threadId)).events).toHaveLength(1);
      await expect(workerApi.get(sibling.threadId)).rejects.toThrow("404");
      await expect(workerApi.get(b.threadId)).rejects.toThrow("404");
      await expect(
        reviewApi.inspections.threads.get(a.threadId),
      ).rejects.toThrow("404");
      await expect(reviewApi.threads.get(a.threadId)).rejects.toThrow("404");
      await expect(
        reviewApi.inspections.workflows.trace(a.runId, {
          attemptId: b.attemptId,
        }),
      ).rejects.toThrow("404");
      await expect(
        reviewApi.inspections.workflows.inspect(b.runId),
      ).rejects.toThrow("404");
      native.replayReference(a.callId, b.callId);
      expect(
        (await reviewApi.inspections.workflows.inspectCall(a.runId, a.callId))
          .replayedFrom,
      ).toBeNull();
      expect(
        (await admin.admin.inspections.workflows.inspectCall(a.runId, a.callId))
          .replayedFrom?.runId,
      ).toBe(b.runId);
      expect(
        (await admin.admin.inspections.list(project)).runs.some(
          (row) => row.id === a.runId,
        ),
      ).toBe(true);
      expect(
        (await reviewApi.inspections.list(project, { limit: 1 })).nextCursor,
      ).not.toBeNull();
      for (const path of [
        `/control-plane/user/workflows/${a.runId}/stop`,
        `/control-plane/user/threads/${a.threadId}/stop`,
        `/control-plane/user/threads/${a.threadId}/send`,
        `/control-plane/user/inspections/workflows/${a.runId}/stop`,
        `/api/v1/threads/${a.threadId}/stop`,
        `/control-plane/admin/inspections/workflows/${a.runId}/inspection`,
      ])
        expect([401, 403, 404], path).toContain(
          (await raw(tokens.get(reviewer.id) ?? "", path, "POST", {})).status,
        );
      await expect(
        reviewApi.admin.inspections.workflows.inspect(a.runId),
      ).rejects.toThrow("401");
      await expect(
        reviewApi.threads.send(a.threadId, {
          message: "Unauthorized steering",
        }),
      ).rejects.toThrow("404");
      await expect(reviewApi.threads.stop(a.threadId)).rejects.toThrow("404");
      expect("stop" in workerApi).toBe(false);
      expect("send" in workerApi).toBe(false);
      expect("start" in reviewApi.inspections.workflows).toBe(false);
      const abort = new AbortController();
      const stream = workerApi
        .stream(a.threadId, { signal: abort.signal })
        [Symbol.asyncIterator]();
      for (let n = 0; n < 12; n++) {
        if ((await stream.next()).value?.kind === "ready") break;
      }
      const pending = stream.next();
      await admin.admin.diagnosticGrants.set(project, reviewer.id, {
        role: "developer",
        expectedRevision: 1,
      });
      await expect(pending).rejects.toThrow();
      abort.abort();
      expect(
        (await reviewApi.inspections.workflows.result(a.runId)).available,
      ).toBe(true);
      await expect(
        admin.admin.diagnosticGrants.set(project, reviewer.id, {
          role: null,
          expectedRevision: 1,
        }),
      ).rejects.toThrow("409");
      let entered: () => void = () => {};
      const entry = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release: () => void = () => {};
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = { entered, wait };
      const inFlight = reviewApi.inspections.workflows.inspect(a.runId);
      const rejected = expect(inFlight).rejects.toThrow("404");
      await entry;
      await admin.admin.diagnosticGrants.set(project, reviewer.id, {
        role: null,
        expectedRevision: 2,
      });
      release();
      await rejected;
      hold = null;
      await expect(
        reviewApi.inspections.workflows.inspectCall(a.runId, a.callId),
      ).rejects.toThrow("404");
      expect((await bobApi.inspections.threads.get(bob.thread.id)).id).toBe(
        bob.thread.id,
      );
      await admin.admin.diagnosticGrants.set(project, reviewer.id, {
        role: "reviewer",
        expectedRevision: 3,
      });
      harness.db
        .update(controlPlaneUsers)
        .set({ enabled: false })
        .where(eq(controlPlaneUsers.id, alice.user.id))
        .run();
      expect(
        (await admin.admin.inspections.workflows.inspect(a.runId)).run.id,
      ).toBe(a.runId);
      const revoked = new AbortController();
      const stream2 = workerApi
        .stream(a.threadId, { signal: revoked.signal })
        [Symbol.asyncIterator]();
      for (let n = 0; n < 12; n++) {
        if ((await stream2.next()).value?.kind === "ready") break;
      }
      const roleChange = stream2.next();
      harness.db
        .update(controlPlaneProjectPolicies)
        .set({ revision: 2 })
        .where(eq(controlPlaneProjectPolicies.projectId, project))
        .run();
      await expect(roleChange).rejects.toThrow();
      revoked.abort();
      const administratorStream = admin.admin.inspections
        .forWorkflow(a.runId)
        .threads.stream(a.threadId)
        [Symbol.asyncIterator]();
      for (let n = 0; n < 12; n++) {
        if ((await administratorStream.next()).value?.kind === "ready") break;
      }
      const signedOutRead = administratorStream.next();
      const signedOut = await server.app.request("/control-plane/logout", {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}`, origin },
      });
      expect(signedOut.status).toBe(200);
      await expect(signedOutRead).rejects.toThrow();
      await expect(
        admin.admin.inspections.workflows.inspect(a.runId),
      ).rejects.toThrow("401");
      harness.db
        .delete(controlPlaneProjectAccess)
        .where(eq(controlPlaneProjectAccess.userId, reviewer.id))
        .run();
      await expect(
        reviewApi.inspections.workflows.inspect(a.runId),
      ).rejects.toThrow("404");
      await expect(
        withControlPlaneInspectionRead(() =>
          withControlPlaneService(() =>
            createControlPlaneWorkflowRpc(
              harness.db,
              () => harness.pluginService,
            )("controlPlaneWorkflowStop", { runId: a.runId }),
          ),
        ),
      ).rejects.toThrow("Inspection");
    } finally {
      inspection.close();
      await server.pluginService.stop();
      await server.closeWebSockets();
      await fake.harness.dispose();
    }
  });
}, 20000);
