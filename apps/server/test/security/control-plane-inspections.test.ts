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
  controlPlaneTestRuns,
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
    let dropAdmissionReply = false;
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
      const result = jsonValueSchema.parse(
        await fake.harness.callRpc(method, input),
      );
      if (dropAdmissionReply && method === "controlPlaneAgentWorkflowStart") {
        dropAdmissionReply = false;
        throw new Error("Lost admission reply");
      }
      return result;
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
        args: "Captured test input",
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
      const draftScript =
        'export const meta={name:"test-target",description:"Immutable draft target",inputSchema:{type:"string"},outputSchema:{type:"string"}};return args;';
      const draft = await aliceApi.workflows.definitions.create({
        originThreadId: alice.thread.id,
        script: draftScript,
        args: null,
      });
      const original = await aliceApi.profiles.get(alice.profile.profileId);
      const published = await admin.admin.profiles.create({
        slug: "test-target",
        name: "Test target",
        definition: {
          ...original.version.definition,
          workflow: { definitionId: draft.id, revision: draft.revision },
        },
      });
      const request = {
        sourceRunId: a.runId,
        projectId: alice.project.id,
        target: {
          kind: "draft" as const,
          profileVersionId: alice.profile.versionId,
          definitionId: draft.id,
          revision: draft.revision,
        },
        idempotencyKey: "native-test-draft",
      };
      await expect(bobApi.testRuns.start(request)).rejects.toThrow("404");
      await expect(reviewApi.testRuns.start(request)).rejects.toThrow("404");
      await expect(admin.admin.testRuns.start(request)).rejects.toThrow("400");
      expect(
        (
          await raw(
            tokens.get(alice.user.id) ?? "",
            "/control-plane/user/test-runs",
            "POST",
            {
              ...request,
              cwd: "/etc",
              uid: 0,
              input: "replace captured input",
            },
          )
        ).status,
      ).toBe(400);
      const tested = await aliceApi.testRuns.start(request);
      expect(tested.state).toBe("started");
      expect(tested.runId).not.toBe(a.runId);
      expect(tested.input).toBe("Captured test input");
      expect(tested.sourceRunId).toBe(a.runId);
      expect(tested.profile).toEqual(original.version.definition);
      expect((await reviewApi.testRuns.get(tested.id)).runId).toBe(
        tested.runId,
      );
      expect((await aliceApi.testRuns.start(request)).id).toBe(tested.id);
      await expect(
        aliceApi.testRuns.start({ ...request, projectId: bob.project.id }),
      ).rejects.toThrow("404");
      await aliceApi.workflows.definitions.update(draft.id, {
        expectedRevision: 1,
        script: draftScript + "\n",
        args: "new default",
      });
      await expect(
        aliceApi.testRuns.start({
          ...request,
          target: { ...request.target, revision: 2 },
        }),
      ).rejects.toThrow("409");
      await expect(
        aliceApi.testRuns.start({ ...request, executionUserId: alice.user.id }),
      ).rejects.toThrow("400");
      const administered = await admin.admin.testRuns.start({
        ...request,
        idempotencyKey: "admin-test",
        executionUserId: alice.user.id,
      });
      expect(administered.ownerUserId).toBe(alice.user.id);
      const crossUserTest = await admin.admin.testRuns.start({
        ...request,
        projectId: bob.project.id,
        executionUserId: bob.user.id,
        idempotencyKey: "explicit-bob-execution",
        target: { ...request.target, profileVersionId: bob.profile.versionId },
      });
      expect(crossUserTest.ownerUserId).toBe(bob.user.id);
      expect(crossUserTest.projectId).toBe(bob.project.id);
      expect(
        harness.db
          .select()
          .from(controlPlaneJobBindings)
          .where(eq(controlPlaneJobBindings.objectId, crossUserTest.runId))
          .get()?.ownerUserId,
      ).toBe(bob.user.id);
      const jsonScript =
        'export const meta={name:"json-test",description:"JSON input"}; return args;';
      const jsonDraft = await aliceApi.workflows.definitions.create({
        originThreadId: alice.thread.id,
        script: jsonScript,
        args: null,
      });
      const jsonSource = await aliceApi.workflows.start({
        originThreadId: alice.thread.id,
        script: jsonScript,
        args: { task: "exact input", count: 3 },
      });
      const jsonTest = await admin.admin.testRuns.start({
        ...request,
        sourceRunId: jsonSource.id,
        idempotencyKey: "json-test",
        executionUserId: alice.user.id,
        target: {
          kind: "draft",
          profileVersionId: alice.profile.versionId,
          definitionId: jsonDraft.id,
          revision: 1,
        },
      });
      expect(jsonTest.input).toEqual({ task: "exact input", count: 3 });

      await expect(bobApi.testRuns.get(tested.id)).rejects.toThrow("404");
      expect((await admin.admin.testRuns.get(tested.id)).ownerUserId).toBe(
        alice.user.id,
      );
      expect(
        harness.db
          .select()
          .from(controlPlaneTestRuns)
          .where(eq(controlPlaneTestRuns.id, tested.id))
          .get()?.script,
      ).toBe(draftScript);
      await aliceApi.workflows.definitions.setEnabled(draft.id, false);
      await expect(
        aliceApi.testRuns.start({
          ...request,
          idempotencyKey: "disabled-draft",
        }),
      ).rejects.toThrow("404");
      await aliceApi.workflows.definitions.setEnabled(draft.id, true);
      expect(
        (
          await raw(
            tokens.get(alice.user.id) ?? "",
            `/control-plane/user/test-runs/${tested.id}?unexpected=1`,
          )
        ).status,
      ).toBe(400);
      dropAdmissionReply = true;
      const lostRequest = {
        ...request,
        idempotencyKey: "lost-admission-reply",
      };
      await expect(aliceApi.testRuns.start(lostRequest)).rejects.toThrow("500");
      const pendingTest = harness.db
        .select()
        .from(controlPlaneTestRuns)
        .where(
          eq(controlPlaneTestRuns.idempotencyKey, lostRequest.idempotencyKey),
        )
        .get();
      expect(pendingTest?.state).toBe("pending");
      if (!pendingTest) throw new Error("Missing reserved test");
      expect((await aliceApi.testRuns.get(pendingTest.id)).state).toBe(
        "pending",
      );
      const recoveredTest = await aliceApi.testRuns.start(lostRequest);
      expect(recoveredTest.id).toBe(pendingTest.id);
      expect(recoveredTest.runId).toBe(pendingTest.runId);
      expect(recoveredTest.state).toBe("started");
      await admin.admin.profiles.setAccess(
        published.profile.id,
        alice.user.id,
        true,
      );
      const versionTest = await aliceApi.testRuns.start({
        ...request,
        idempotencyKey: "native-test-published",
        target: { kind: "published", profileVersionId: published.version.id },
      });
      await expect(
        admin.admin.testRuns.start({
          ...request,
          projectId: bob.project.id,
          executionUserId: bob.user.id,
          idempotencyKey: "admin-cannot-bypass-profile",
          target: { kind: "published", profileVersionId: published.version.id },
        }),
      ).rejects.toThrow("404");
      expect(
        (await aliceApi.testRuns.find(versionTest.runId)).testRun?.id,
      ).toBe(versionTest.id);
      expect(versionTest.target).toEqual({
        kind: "published",
        profileVersionId: published.version.id,
      });
      expect(
        (await aliceApi.inspections.workflows.inspect(a.runId)).sourceHash,
      ).toBe(tested.sourceHash);
      await admin.admin.profiles.setAccess(
        published.profile.id,
        alice.user.id,
        false,
      );
      await expect(
        aliceApi.testRuns.start({
          ...request,
          idempotencyKey: "revoked-test",
          target: { kind: "published", profileVersionId: published.version.id },
        }),
      ).rejects.toThrow("404");
      expect((await aliceApi.testRuns.get(versionTest.id)).runId).toBe(
        versionTest.runId,
      );
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
      await expect(reviewApi.testRuns.get(tested.id)).rejects.toThrow("404");
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
