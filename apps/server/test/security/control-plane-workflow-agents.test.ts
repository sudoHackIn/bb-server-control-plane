import { createControlPlaneThreadService } from "../../src/control-plane/threads.js";
import { withControlPlaneUser } from "../../src/control-plane/access.js";
import { ApiError } from "../../src/errors.js";
import { createHash, randomBytes } from "node:crypto";
import { expect, it, onTestFinished } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { ControlPlaneRegistry, controlPlaneUserSessions } from "@bb/db";
import { createControlPlaneClient } from "@bb/sdk/node";
import { build } from "esbuild";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { jsonValueSchema } from "@bb/domain";
import { createApp } from "../../src/server.js";
import { createControlPlaneBackgroundJobs } from "../../src/control-plane/background-jobs.js";
import { createControlPlaneWorkflowService } from "../../src/control-plane/workflows.js";
import { createControlPlaneAccess } from "../../src/control-plane/access.js";
import { createControlPlaneUserAccess } from "../../src/control-plane/user-access.js";
import { hashAdminPassword } from "../../src/control-plane/credentials.js";
import { withTestHarness } from "../helpers/test-app.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";

it("publishes and invokes a frozen workflow agent through authorized SDK routes with native persistence", async () => {
  await withTestHarness(async (harness) => {
    const { alice, bob } = seedControlPlaneJobSubjects(harness.db);
    const registry = new ControlPlaneRegistry(harness.db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 299999,
    });
    const fake = createFakePluginHost({ pluginId: "workflows" });
    Object.defineProperty(
      fake.bb.server,
      "internal_DO_NOT_USE_backgroundJobs",
      {
        value: createControlPlaneBackgroundJobs(harness.db, "workflows", true),
      },
    );
    const cache = fileURLToPath(
      new URL("../../node_modules/.cache/", import.meta.url),
    );
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(join(cache, "workflow-api-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const jsPath = join(directory, "fixture.mjs");
    const sdkPath = fileURLToPath(
      new URL("../../../../packages/plugin-sdk/dist/index.js", import.meta.url),
    );
    await build({
      entryPoints: [
        fileURLToPath(
          new URL(
            "../../../../plugins/workflows/src/testing/managed-api-fixture.ts",
            import.meta.url,
          ),
        ),
      ],
      outfile: jsPath,
      bundle: true,
      platform: "node",
      format: "esm",
      plugins: [
        {
          name: "built-public-sdk",
          setup(builder) {
            builder.onResolve({ filter: /^@get-bb\/plugin-sdk$/ }, () => ({
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
    const imported: unknown = await import(pathToFileURL(jsPath).href);
    const factory = z
      .object({
        default: z.custom<
          (bb: BbPluginApi) => {
            settle: (id: string) => void;
            failDefinitionWrites: (enabled: boolean) => void;
            definitionCount: () => number;
          }
        >((value) => typeof value === "function"),
      })
      .parse(imported).default;
    const native = factory(fake.bb);
    const service = createControlPlaneWorkflowService(
      harness.db,
      async (method, input) => {
        try {
          return jsonValueSchema.parse(
            await fake.harness.callRpc(method, input),
          );
        } catch (error) {
          throw new ApiError(
            error instanceof Error &&
              error.message.includes("idempotency conflict")
              ? 409
              : 400,
            "workflow_rejected",
            error instanceof Error ? error.message : "Workflow rejected",
          );
        }
      },
    );
    const origin = "https://bb.example";
    harness.config.appUrl = origin;
    const server = createApp(harness.deps, {
      controlPlane: createControlPlaneAccess(
        {
          version: 1,
          publicOrigin: origin,
          admin: {
            login: "admin",
            passwordHash: await hashAdminPassword("workflow-test-password"),
          },
        },
        Date.now,
        createControlPlaneUserAccess(
          registry,
          origin,
          Date.now,
          undefined,
          createControlPlaneThreadService({ deps: harness.deps }),
          service,
        ),
      ),
    });
    const tokens = new Map<string, string>();
    for (const subject of [alice, bob]) {
      const token = `agt_${randomBytes(32).toString("base64url")}`;
      tokens.set(subject.user.id, token);
      harness.db
        .insert(controlPlaneUserSessions)
        .values({
          userId: subject.user.id,
          digest: createHash("sha256").update(token).digest("hex"),
          expiresAt: Date.now() + 60000,
        })
        .run();
    }
    const client = (id: string) =>
      createControlPlaneClient({
        origin,
        token: () => tokens.get(id) ?? null,
        fetch: async (input, init) =>
          server.app.fetch(new Request(input, init)),
      });
    const request = (
      userId: string | null,
      path: string,
      method = "GET",
      body?: object,
    ) =>
      server.app.request(path, {
        method,
        headers: {
          ...(userId ? { authorization: `Bearer ${tokens.get(userId)}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const script =
      'export const meta={name:"published-workflow",description:"Pinned workflow agent",inputSchema:{type:"string",maxLength:80},outputSchema:{type:"object",properties:{value:{type:"number"}},required:["value"],additionalProperties:false}}; return {value:42};';
    try {
      const login = await request(null, "/control-plane/login", "POST", {
        login: "admin",
        password: "workflow-test-password",
      });
      const token = z
        .object({ token: z.string() })
        .parse(await login.json()).token;
      const admin = createControlPlaneClient({
        origin,
        token: () => token,
        fetch: async (input, init) =>
          server.app.fetch(new Request(input, init)),
      }).admin.profiles;
      const definition = await client(
        alice.user.id,
      ).workflows.definitions.create({
        originThreadId: alice.thread.id,
        script,
        args: "example",
      });
      const profileDefinition = {
        prompt: "Pinned instructions",
        providerId: "qwen-server" as const,
        model: "qwen-test",
        reasoningLevel: "none",
        permissionMode: "full" as const,
        tools: [],
        mcpServers: [],
        workflow: {
          definitionId: definition.id,
          revision: definition.revision,
        },
      };
      await expect(
        withControlPlaneUser(alice.user.id, () =>
          fake.harness.callRpc("controlPlaneDefinitionApprove", {
            id: definition.id,
            revision: 1,
          }),
        ),
      ).rejects.toThrow("administrator authority");
      const invalidDefinition = await client(
        alice.user.id,
      ).workflows.definitions.create({
        originThreadId: alice.thread.id,
        script:
          'export const meta={name:"missing-contract",description:"Missing contracts"};return 42;',
        args: null,
      });
      await expect(
        admin.create({
          slug: "invalid-contract",
          name: "Invalid",
          definition: {
            ...profileDefinition,
            workflow: { definitionId: invalidDefinition.id, revision: 1 },
          },
        }),
      ).rejects.toThrow("400");
      await expect(
        admin.create({
          slug: "missing-revision",
          name: "Missing",
          definition: {
            ...profileDefinition,
            workflow: { definitionId: definition.id, revision: 99 },
          },
        }),
      ).rejects.toThrow("400");
      const published = await admin.create({
        slug: "published-workflow",
        name: "Published workflow",
        definition: profileDefinition,
      });
      await admin.setAccess(published.profile.id, alice.user.id, true);
      await admin.setAccess(published.profile.id, bob.user.id, true);
      expect(published.profile.strategy).toBe("workflow");
      expect(JSON.stringify(published)).not.toContain(script);
      const aliceApi = client(alice.user.id),
        bobApi = client(bob.user.id);
      const input = {
        projectId: alice.project.id,
        profileVersionId: published.version.id,
        input: "task",
        source: "manual" as const,
        idempotencyKey: "fixed-request",
      };
      const [run, duplicate] = await Promise.all([
        aliceApi.agentRuns.start(input),
        aliceApi.agentRuns.start(input),
      ]);
      expect(duplicate.runId).toBe(run.runId);
      expect(run).toMatchObject({
        strategy: "workflow",
        threadId: null,
        workflowRunId: run.runId,
        profileVersionId: published.version.id,
        status: "queued",
      });
      await expect(
        aliceApi.agentRuns.start({ ...input, input: "different" }),
      ).rejects.toThrow("409");
      await expect(bobApi.agentRuns.get(run.runId)).rejects.toThrow("404");
      await expect(bobApi.agentRuns.result(run.runId)).rejects.toThrow("404");
      await expect(bobApi.agentRuns.cancel(run.runId)).rejects.toThrow("404");
      await expect(bobApi.agentRuns.start(input)).rejects.toThrow("404");
      await expect(
        aliceApi.threads.start({
          projectId: alice.project.id,
          profileVersionId: published.version.id,
          message: "chat",
        }),
      ).rejects.toThrow("409");
      const foreign = await bobApi.agentRuns.start({
        ...input,
        projectId: bob.project.id,
      });
      expect(foreign.runId).not.toBe(run.runId);
      expect(
        (
          await aliceApi.agentRuns.list({ projectId: alice.project.id })
        ).runs.map((item) => item.runId),
      ).toEqual([run.runId]);
      native.settle(run.runId);
      expect(await aliceApi.agentRuns.result(run.runId)).toMatchObject({
        run: { status: "succeeded" },
        text: '{\n  "value": 42\n}',
      });
      await aliceApi.workflows.definitions.update(definition.id, {
        expectedRevision: 1,
        script: script.replace("return {value:42}", "return {value:99}"),
        args: "example",
      });
      await aliceApi.workflows.definitions.remove(definition.id);
      const frozen = await aliceApi.agentRuns.start({
        ...input,
        idempotencyKey: "after-source-removal",
      });
      expect(frozen.profileVersionId).toBe(published.version.id);
      await expect(
        admin.publish(published.profile.id, profileDefinition),
      ).rejects.toThrow("400");
      await expect(
        aliceApi.agentRuns.start({
          ...input,
          idempotencyKey: "invalid-contract",
          input: "x".repeat(81),
        }),
      ).rejects.toThrow("400");
      const malformed = await request(
        alice.user.id,
        "/control-plane/user/agent-runs",
        "POST",
        { ...input, input: "я".repeat(70000) },
      );
      expect(malformed.status).toBe(400);
      const first = await aliceApi.agentRuns.list({ limit: 1 });
      expect(first.runs).toHaveLength(1);
      expect(first.nextCursor).toBe(first.runs[0]?.runId);
      expect(
        (
          await aliceApi.agentRuns.list({
            cursor: first.nextCursor ?? undefined,
            limit: 1,
          })
        ).runs,
      ).toHaveLength(1);
      await admin.setAccess(alice.profile.profileId, alice.user.id, false);
      await expect(
        aliceApi.agentRuns.start({
          ...input,
          profileVersionId: alice.profile.versionId,
          idempotencyKey: "revoked-conversation",
        }),
      ).rejects.toThrow("404");
      await admin.setAccess(alice.profile.profileId, alice.user.id, true);
      await admin.setAccess(published.profile.id, alice.user.id, false);
      await expect(aliceApi.agentRuns.start(input)).rejects.toThrow("404");
      expect(
        (await request(null, "/control-plane/user/agent-runs")).status,
      ).toBe(401);
    } finally {
      await fake.harness.dispose();
      await server.pluginService.stop();
      await server.closeWebSockets();
    }
  });
});
