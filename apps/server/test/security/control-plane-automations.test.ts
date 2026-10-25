import { normalizeRpcRegistration } from "@get-bb/plugin-sdk/internal/host-policy";
import type { PluginRpcHandler } from "../../src/services/plugins/plugin-api.js";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { build } from "esbuild";
import { z } from "zod";
import { expect, it, onTestFinished } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  ControlPlaneRegistry,
  controlPlaneUserSessions,
  installedPlugins,
  createThread,
  createControlPlaneJobBinding,
  controlPlaneJobBindings,
  controlPlaneProjectAccess,
  appendStoredThreadEvent,
  setControlPlaneProfileAccess,
  threads,
} from "@bb/db";
import { eq } from "drizzle-orm";
import { turnScope } from "@bb/domain";
import { createControlPlaneClient } from "@bb/sdk/node";
import {
  createControlPlaneAutomationService,
  createControlPlaneAutomationRpc,
} from "../../src/control-plane/automations.js";
import { createControlPlaneUserAccess } from "../../src/control-plane/user-access.js";
import { createControlPlaneAccess } from "../../src/control-plane/access.js";
import { hashAdminPassword } from "../../src/control-plane/credentials.js";
import { createApp } from "../../src/server.js";
import { withTestHarness } from "../helpers/test-app.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { createControlPlaneWorkflowWorkers } from "../../src/control-plane/workflow-workers.js";
import { createControlPlaneBackgroundJobs } from "../../src/control-plane/background-jobs.js";
import { withControlPlaneUser } from "../../src/control-plane/access.js";
import { withControlPlaneJobAuthority } from "../../src/control-plane/job-authority.js";

const automation = z
  .object({
    id: z.string(),
    projectId: z.string(),
    enabled: z.boolean(),
    execution: z.object({ prompt: z.string() }).passthrough(),
  })
  .passthrough();
const run = z.object({
  run: z
    .object({
      id: z.string(),
      threadId: z.string().nullable(),
      status: z.string(),
    })
    .passthrough(),
});

it("uses the actual builtin automation controller and two SQLite stores for ownership, immutable dispatch, schedules, idempotency and revocation", async () => {
  await withTestHarness(async (harness) => {
    const { alice, bob } = seedControlPlaneJobSubjects(harness.db);
    const fake = createFakePluginHost({ pluginId: "automations" });
    const workers = createControlPlaneWorkflowWorkers(
      harness.deps,
      "automations",
    );
    onTestFinished(() => workers.close());
    let starts = 0;
    let releases = 0;
    const jobs = createControlPlaneBackgroundJobs(
      harness.db,
      "automations",
      true,
      {
        ...workers,
        async releaseWorker() {
          releases++;
          return releases > 1;
        },
        async startWorker(parentId, input) {
          return withControlPlaneJobAuthority(
            harness.db,
            parentId,
            (context) => {
              starts++;
              const binding = createControlPlaneJobBinding(harness.db, {
                kind: "automation-worker",
                objectId: randomUUID(),
                revision: 1,
                userId: context.user.id,
                projectId: context.project.projectId,
                originThreadId: context.binding.originThreadId,
                profileVersionId: context.profileVersion.id,
                sourceBindingId: parentId,
              });
              const thread = createThread(harness.db, harness.hub, {
                projectId: context.project.projectId,
                environmentId:
                  context.user.id === alice.user.id
                    ? alice.environment.id
                    : bob.environment.id,
                providerId: "qwen-server",
                status: "idle",
                originPluginId: "automations",
                controlPlaneOwnerUserId: context.user.id,
                controlPlaneProfileVersionId: context.profileVersion.id,
                controlPlaneJobBindingId: binding.id,
              });
              appendStoredThreadEvent(harness.db, harness.hub, {
                threadId: thread.id,
                type: "turn/completed",
                scope: turnScope("turn_test"),
                data: { providerThreadId: "test-session", status: "completed" },
              });
              expect(input.prompt).toContain("owned prompt");
              return { threadId: thread.id, bindingId: binding.id };
            },
          );
        },
      },
    );
    Object.defineProperty(
      fake.bb.server,
      "internal_DO_NOT_USE_backgroundJobs",
      { value: jobs },
    );
    const cache = fileURLToPath(
      new URL("../../node_modules/.cache/", import.meta.url),
    );
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(join(cache, "automations-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const outfile = join(directory, "fixture.mjs");
    const sdkPath = fileURLToPath(
      new URL("../../../../packages/plugin-sdk/dist/index.js", import.meta.url),
    );
    await build({
      entryPoints: [
        fileURLToPath(
          new URL(
            "../../../../plugins/automations/src/testing/managed-fixture.ts",
            import.meta.url,
          ),
        ),
      ],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      plugins: [
        {
          name: "public-sdk",
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
    const imported: unknown = await import(pathToFileURL(outfile).href);
    const factory = z
      .object({
        default: z.custom<
          (bb: BbPluginApi) => {
            tick(startup?: boolean): Promise<void> | undefined;
            fault(enabled: boolean): void;
            versions(id: string): unknown;
            due(id: string): void;
            legacy(projectId: string): string;
          }
        >((value) => typeof value === "function"),
      })
      .parse(imported).default;
    const records = new Map<string, PluginRpcHandler>();
    const register = fake.bb.rpc.register;
    fake.bb.rpc.register = (contract, handlers, options) => {
      for (const [name, record] of normalizeRpcRegistration(
        contract,
        handlers,
        records,
        options,
      ))
        records.set(name, record);
      register(contract, handlers, options);
    };
    const native = factory(fake.bb);
    await expect(
      fake.harness.callRpc("controlPlaneAutomationReads", {
        ids: Array.from({ length: 51 }, () => "id"),
      }),
    ).rejects.toThrow();
    const invoke = (userId: string, method: string, input: unknown) =>
      withControlPlaneUser(userId, () => fake.harness.callRpc(method, input));
    const payload = (subject: typeof alice) => ({
      projectId: subject.project.id,
      name: "Owned automation",
      enabled: true,
      createdByThreadId: subject.thread.id,
      origin: "human",
      trigger: { triggerType: "schedule", cron: "* * * * *", timezone: "UTC" },
      execution: {
        mode: "agent",
        prompt: "owned prompt",
        providerId: "qwen-server",
        model: "qwen-test",
        reasoningLevel: "none",
        permissionMode: "full",
        environment: { type: "project-default" },
      },
    });
    const saved = automation.parse(
      await invoke(alice.user.id, "automations_create", payload(alice)),
    );
    const other = automation.parse(
      await invoke(bob.user.id, "automations_create", payload(bob)),
    );
    harness.db
      .insert(controlPlaneProjectAccess)
      .values({
        projectId: alice.project.id,
        userId: bob.user.id,
        role: "runner",
      })
      .run();
    const registry = new ControlPlaneRegistry(harness.db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 299999,
    });
    let rpcCalls = 0;
    const personal = createControlPlaneAutomationService(
      harness.db,
      async (method, input) => {
        rpcCalls++;
        return realRpc(method, input);
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
            passwordHash: await hashAdminPassword("automation-test-password"),
          },
        },
        Date.now,
        createControlPlaneUserAccess(
          registry,
          origin,
          Date.now,
          undefined,
          undefined,
          undefined,
          personal,
        ),
      ),
    });
    harness.db
      .insert(installedPlugins)
      .values({
        id: "automations",
        source: "builtin:automations",
        rootDir: "/test/native-automations",
        version: "0.1.0",
        provenance: "builtin",
        sourceKind: "builtin",
        sourceBuiltinName: "automations",
        installedAt: 1,
        updatedAt: 1,
      })
      .onConflictDoUpdate({
        target: installedPlugins.id,
        set: {
          enabled: true,
          provenance: "builtin",
          sourceKind: "builtin",
          sourceBuiltinName: "automations",
          removedAt: null,
        },
      })
      .run();
    const realRpc = createControlPlaneAutomationRpc(harness.db, () => ({
      getRpcHandler(_id, method) {
        const handler = records.get(method);
        if (!handler) throw new Error("Missing actual automation RPC handler");
        return { outcome: "found", value: handler };
      },
      invokeRpcHandler: server.pluginService.invokeRpcHandler,
    }));
    onTestFinished(async () => {
      await server.pluginService.stop();
      await server.closeWebSockets();
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
    const client = (userId: string) =>
      createControlPlaneClient({
        origin,
        token: () => tokens.get(userId) ?? null,
        fetch: async (input, init) =>
          server.app.fetch(new Request(input, init)),
      });
    const mine = client(alice.user.id).automations;
    const foreign = client(bob.user.id).automations;
    expect(
      (await mine.list({ limit: 1 })).automations.map((row) => row.id),
    ).toEqual([saved.id]);
    expect(
      (await foreign.list({ projectId: alice.project.id })).automations,
    ).toEqual([]);
    expect((await mine.get(saved.id)).id).toBe(saved.id);
    const beforeForeign = rpcCalls;
    await expect(foreign.get(saved.id)).rejects.toThrow("404");
    await expect(foreign.history(saved.id)).rejects.toThrow("404");
    expect(rpcCalls).toBe(beforeForeign);
    const base = "/control-plane/user/automations";
    for (const path of [
      base,
      `${base}/${saved.id}`,
      `${base}/${saved.id}/history`,
    ]) {
      expect((await server.app.request(path)).status).toBe(401);
    }
    for (const path of [
      `${base}?limit=51`,
      `${base}?ownerUserId=${bob.user.id}`,
      `${base}/${saved.id}?projectId=${bob.project.id}`,
      `${base}/${saved.id}/history?limit=101`,
      `${base}/${saved.id}/history?cursor=%2Fbad`,
    ]) {
      expect(
        (
          await server.app.request(path, {
            headers: { authorization: `Bearer ${tokens.get(alice.user.id)}` },
          })
        ).status,
      ).toBe(400);
    }
    for (const path of [
      `${base}/${saved.id}/run`,
      "/api/plugins/automations/rpc/automations_list",
    ]) {
      expect(
        (
          await server.app.request(path, {
            method: "POST",
            headers: { authorization: `Bearer ${tokens.get(alice.user.id)}` },
          })
        ).status,
      ).toBe(401);
    }
    expect(
      automation.array().parse(
        await invoke(bob.user.id, "automations_list", {
          projectId: alice.project.id,
        }),
      ),
    ).toEqual([]);
    for (const method of [
      "automations_get",
      "automations_pause",
      "automations_resume",
      "automations_delete",
      "automations_run",
      "automations_runs",
    ])
      await expect(
        invoke(bob.user.id, method, {
          projectId: alice.project.id,
          automationId: saved.id,
        }),
      ).rejects.toThrow();
    await expect(
      invoke(bob.user.id, "automations_update", {
        projectId: alice.project.id,
        automationId: saved.id,
        name: "Foreign change",
      }),
    ).rejects.toThrow();
    const overview = z
      .object({
        automations: z.array(
          z.object({ automation: z.object({ id: z.string() }) }),
        ),
      })
      .parse(await invoke(bob.user.id, "automations_overview", null));
    expect(overview.automations.map((entry) => entry.automation.id)).toEqual([
      other.id,
    ]);
    await expect(
      invoke(alice.user.id, "automations_create", {
        ...payload(alice),
        createdByThreadId: bob.thread.id,
      }),
    ).rejects.toThrow();
    await expect(
      invoke(alice.user.id, "automations_create", {
        ...payload(alice),
        execution: { ...payload(alice).execution, model: "forged" },
      }),
    ).rejects.toThrow(/approved profile/);
    await expect(
      invoke(alice.user.id, "automations_create", {
        ...payload(alice),
        execution: { mode: "script", script: "touch /tmp/forbidden" },
      }),
    ).rejects.toThrow();
    native.fault(true);
    const count = harness.db
      .select()
      .from(controlPlaneJobBindings)
      .where(eq(controlPlaneJobBindings.kind, "automation"))
      .all().length;
    await expect(
      invoke(alice.user.id, "automations_create", payload(alice)),
    ).rejects.toThrow(/version write rejected/);
    native.fault(false);
    const roots = harness.db
      .select()
      .from(controlPlaneJobBindings)
      .where(eq(controlPlaneJobBindings.kind, "automation"))
      .all();
    expect(roots).toHaveLength(count + 1);
    expect(roots.filter((root) => root.deletedAt === null)).toHaveLength(2);
    const first = run.parse(
      await invoke(alice.user.id, "automations_run", {
        projectId: alice.project.id,
        automationId: saved.id,
        idempotencyKey: "same",
      }),
    );
    const deduped = run.parse(
      await invoke(alice.user.id, "automations_run", {
        projectId: alice.project.id,
        automationId: saved.id,
        idempotencyKey: "same",
      }),
    );
    expect(first.run.id).toBe(deduped.run.id);
    expect(starts).toBe(1);
    await native.tick();
    expect(releases).toBe(1);
    const read = await mine.get(saved.id);
    expect(read).not.toHaveProperty("execution");
    expect(read).not.toHaveProperty("ownerUserId");
    const page = await mine.history(saved.id, { limit: 1 });
    expect(page.runs[0]?.id).toBe(first.run.id);
    expect(page.runs[0]).not.toHaveProperty("output");
    expect(page.runs[0]).not.toHaveProperty("runMode");
    expect(
      (
        await server.app.request(`${base}/${saved.id}`, {
          headers: { authorization: `Bearer ${tokens.get(alice.user.id)}` },
        })
      ).headers.get("cache-control"),
    ).toBe("no-store");

    if (!first.run.threadId) throw new Error("Missing worker");
    harness.db
      .update(threads)
      .set({ status: "active" })
      .where(eq(threads.id, first.run.threadId))
      .run();
    await native.tick();
    expect(releases).toBe(1);
    harness.db
      .update(threads)
      .set({ status: "idle" })
      .where(eq(threads.id, first.run.threadId))
      .run();
    expect(
      run.parse(
        await invoke(alice.user.id, "automations_run", {
          projectId: alice.project.id,
          automationId: saved.id,
          idempotencyKey: "same",
        }),
      ).run.status,
    ).toBe("succeeded");
    await invoke(alice.user.id, "automations_update", {
      projectId: alice.project.id,
      automationId: saved.id,
      agent: { prompt: "owned prompt v2" },
    });
    expect(
      z
        .array(z.object({ revision: z.number(), execution_json: z.string() }))
        .parse(native.versions(saved.id))
        .map(
          (row) =>
            z
              .object({ prompt: z.string() })
              .parse(JSON.parse(row.execution_json)).prompt,
        ),
    ).toEqual(["owned prompt", "owned prompt v2"]);
    native.due(other.id);
    await native.tick();
    await expect
      .poll(async () => {
        await native.tick();
        return z
          .object({ runs: z.array(z.object({ status: z.string() })) })
          .parse(
            await invoke(bob.user.id, "automations_runs", {
              projectId: bob.project.id,
              automationId: other.id,
            }),
          ).runs[0]?.status;
      })
      .toBe("succeeded");
    expect(starts).toBe(2);
    const secondSaved = automation.parse(
      await invoke(alice.user.id, "automations_create", payload(alice)),
    );
    const firstDefinitions = await mine.list({
      projectId: alice.project.id,
      limit: 1,
    });
    expect(firstDefinitions.nextCursor).not.toBeNull();
    if (!firstDefinitions.nextCursor)
      throw new Error("Missing definition cursor");
    const nextDefinitions = await mine.list({
      projectId: alice.project.id,
      limit: 1,
      cursor: firstDefinitions.nextCursor,
    });
    expect(
      new Set(
        [...firstDefinitions.automations, ...nextDefinitions.automations].map(
          (row) => row.id,
        ),
      ),
    ).toEqual(new Set([saved.id, secondSaved.id]));
    expect(nextDefinitions.nextCursor).toBeNull();
    createControlPlaneJobBinding(harness.db, {
      kind: "automation",
      objectId: "reserved-without-native-definition",
      revision: 1,
      userId: alice.user.id,
      projectId: alice.project.id,
      originThreadId: alice.thread.id,
      profileVersionId: alice.profile.versionId,
      sourceBindingId: null,
    });
    await invoke(alice.user.id, "automations_pause", {
      projectId: alice.project.id,
      automationId: saved.id,
    });
    await expect(
      invoke(alice.user.id, "automations_run", {
        projectId: alice.project.id,
        automationId: saved.id,
      }),
    ).rejects.toThrow(/not authorized/);
    setControlPlaneProfileAccess(
      harness.db,
      alice.profile.profileId,
      alice.user.id,
      false,
    );
    await expect(
      invoke(alice.user.id, "automations_resume", {
        projectId: alice.project.id,
        automationId: saved.id,
      }),
    ).rejects.toThrow();
    const legacy = native.legacy(alice.project.id);
    await native.tick(true);
    expect(
      z.object({ enabled: z.boolean() }).parse(
        await fake.harness.callRpc("automations_get", {
          projectId: alice.project.id,
          automationId: legacy,
        }),
      ).enabled,
    ).toBe(false);
    await expect(
      fake.harness.callRpc("automations_run", {
        projectId: alice.project.id,
        automationId: legacy,
      }),
    ).rejects.toThrow(/owner assignment/);
    expect(starts).toBe(2);
    await invoke(alice.user.id, "automations_delete", {
      projectId: alice.project.id,
      automationId: saved.id,
    });
    const callsBeforeDeleted = rpcCalls;
    await expect(mine.get(saved.id)).rejects.toThrow("404");
    await expect(mine.history(saved.id)).rejects.toThrow("404");
    expect(rpcCalls).toBe(callsBeforeDeleted);
    await expect(
      mine.get("reserved-without-native-definition"),
    ).rejects.toThrow("404");
    expect(
      (await mine.list({ limit: 50 })).automations.map((row) => row.id),
    ).toEqual([secondSaved.id]);

    expect(
      harness.db
        .select()
        .from(controlPlaneJobBindings)
        .where(eq(controlPlaneJobBindings.objectId, saved.id))
        .get()?.deletedAt,
    ).not.toBeNull();
  });
});
