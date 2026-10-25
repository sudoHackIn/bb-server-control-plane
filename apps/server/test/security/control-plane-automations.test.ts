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
    let stopFailures = 0;
    let cleanupGate: {
      threadId: string;
      wait: Promise<void>;
      cancellationWait: Promise<void>;
      calls: number;
      entered: () => void;
    } | null = null;
    const jobs = createControlPlaneBackgroundJobs(
      harness.db,
      "automations",
      true,
      {
        ...workers,
        async stopWorker(parentId, threadId) {
          if (stopFailures-- > 0) throw new Error("Temporary host unavailable");
          if (cleanupGate?.threadId === threadId) {
            const gate = cleanupGate;
            const first = gate.calls++ === 0;
            gate.entered();
            await (first ? gate.wait : gate.cancellationWait);
            return;
          }
          await workers.stopWorker(parentId, threadId);
        },
        async getWorker(parentId, threadId) {
          const worker = await workers.getWorker(parentId, threadId);
          return cleanupGate?.threadId === threadId
            ? {
                ...worker,
                status: "error",
                error: "Provider failure during cancellation race",
              }
            : worker;
        },
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
            scriptAttempt(runId: string): unknown;
            cancelRequested(runId: string): boolean;
            restart(): void;
            abort(): void;
            shutdown(): Promise<void> | undefined;
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
      `${base}/${saved.id}/script`,
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
    expect(page.runs[0]?.runMode).toBe("agent");
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

    setControlPlaneProfileAccess(
      harness.db,
      alice.profile.profileId,
      alice.user.id,
      true,
    );
    const created = await mine.create({
      originThreadId: alice.thread.id,
      name: "API definition",
      prompt: "owned prompt API",
      trigger: { triggerType: "schedule", cron: "* * * * *", timezone: "UTC" },
      enabled: false,
    });
    expect(created.revision).toBe(1);
    expect(created.enabled).toBe(false);
    expect(created).not.toHaveProperty("prompt");
    expect(await mine.definition(created.id)).toMatchObject({
      executionMode: "agent",
      prompt: "owned prompt API",
    });
    const beforeForeignMutation = rpcCalls;
    await expect(foreign.definition(created.id)).rejects.toThrow("404");
    await expect(
      foreign.update(created.id, { expectedRevision: 1, prompt: "forged" }),
    ).rejects.toThrow("404");
    await expect(foreign.pause(created.id)).rejects.toThrow("404");
    await expect(foreign.resume(created.id)).rejects.toThrow("404");
    await expect(foreign.run(created.id)).rejects.toThrow("404");
    await expect(foreign.stop(created.id, "forged")).rejects.toThrow("404");
    await expect(foreign.remove(created.id)).rejects.toThrow("404");
    expect(rpcCalls).toBe(beforeForeignMutation);
    await expect(
      mine.create({
        originThreadId: bob.thread.id,
        name: "forged",
        prompt: "owned prompt",
        trigger: created.trigger,
      }),
    ).rejects.toThrow("404");
    const updated = await mine.update(created.id, {
      expectedRevision: 1,
      prompt: "owned prompt API revised",
      name: "Revised",
    });
    expect(updated.revision).toBe(2);
    await expect(
      mine.update(created.id, { expectedRevision: 1, name: "stale" }),
    ).rejects.toThrow("409");
    await expect(
      invoke(alice.user.id, "controlPlaneAutomationUpdate", {
        projectId: created.projectId,
        automationId: created.id,
        expectedRevision: 1,
        name: "stale native",
      }),
    ).rejects.toThrow(/revision conflict/);
    expect(await mine.definition(created.id)).toMatchObject({
      executionMode: "agent",
      prompt: "owned prompt API revised",
    });
    native.fault(true);
    await expect(
      mine.update(created.id, {
        expectedRevision: 2,
        prompt: "owned prompt rollback",
      }),
    ).rejects.toThrow();
    native.fault(false);
    expect(await mine.definition(created.id)).toMatchObject({
      executionMode: "agent",
      prompt: "owned prompt API revised",
    });
    expect((await mine.definition(created.id)).revision).toBe(2);
    expect(
      z
        .array(z.object({ revision: z.number(), execution_json: z.string() }))
        .parse(native.versions(created.id))
        .map((row) => ({
          revision: row.revision,
          prompt: z
            .object({ prompt: z.string() })
            .parse(JSON.parse(row.execution_json)).prompt,
        })),
    ).toEqual([
      { revision: 1, prompt: "owned prompt API" },
      { revision: 2, prompt: "owned prompt API revised" },
    ]);
    const concurrent = await Promise.allSettled([
      mine.update(created.id, {
        expectedRevision: 2,
        name: "Concurrent first",
      }),
      mine.update(created.id, {
        expectedRevision: 2,
        name: "Concurrent second",
      }),
    ]);
    expect(
      concurrent.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const refused = concurrent.find((result) => result.status === "rejected");
    if (!refused || refused.status !== "rejected")
      throw new Error("Missing CAS refusal");
    expect(String(refused.reason)).toContain("409");
    expect((await mine.definition(created.id)).revision).toBe(3);
    expect((await mine.resume(created.id)).enabled).toBe(true);
    const running = await mine.run(created.id, { idempotencyKey: "api-one" });
    expect((await mine.run(created.id, { idempotencyKey: "api-one" })).id).toBe(
      running.id,
    );
    expect(running).not.toHaveProperty("output");
    await expect(mine.stop(created.id, first.run.id)).rejects.toThrow("404");
    stopFailures = 1;
    await expect(mine.stop(created.id, running.id)).rejects.toThrow("409");
    expect((await mine.history(created.id)).runs[0]?.status).toBe("running");
    native.restart();
    await native.tick(true);
    expect((await mine.history(created.id)).runs[0]?.status).toBe("cancelled");
    expect(await mine.stop(created.id, running.id)).toEqual({ stopped: false });
    expect((await mine.get(created.id)).enabled).toBe(true);
    expect((await mine.history(created.id)).runs[0]?.status).toBe("cancelled");
    const raced = await mine.run(created.id, { idempotencyKey: "cancel-race" });
    if (!raced.threadId) throw new Error("Missing race worker");
    let releaseCleanup = () => {};
    let releaseCancellation = () => {};
    let enteredCleanup = () => {};
    const cleanupEntered = new Promise<void>((resolve) => {
      enteredCleanup = resolve;
    });
    cleanupGate = {
      threadId: raced.threadId,
      calls: 0,
      cancellationWait: new Promise<void>((resolve) => {
        releaseCancellation = resolve;
      }),
      wait: new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      }),
      entered: enteredCleanup,
    };
    const sweep = native.tick();
    await cleanupEntered;
    const cancellation = mine.stop(created.id, raced.id);
    await expect.poll(() => native.cancelRequested(raced.id)).toBe(true);
    releaseCleanup();
    const duringCleanup = (await mine.history(created.id)).runs.find(
      (row) => row.id === raced.id,
    )?.status;
    releaseCancellation();
    await Promise.all([sweep, cancellation]);
    expect(duringCleanup).toBe("running");
    cleanupGate = null;
    expect(
      (await mine.history(created.id)).runs.find((row) => row.id === raced.id)
        ?.status,
    ).toBe("cancelled");
    expect((await mine.pause(created.id)).enabled).toBe(false);
    await expect(mine.run(created.id)).rejects.toThrow();
    expect((await mine.definition(created.id)).revision).toBe(3);
    for (const override of [
      { userId: bob.user.id },
      { home: "/root" },
      { providerId: "forged" },
      { model: "forged" },
      { tools: [] },
      { execution: { mode: "script", script: "forged" } },
    ]) {
      const response = await server.app.request(base, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.get(alice.user.id)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          originThreadId: alice.thread.id,
          name: "forged",
          prompt: "owned prompt",
          trigger: created.trigger,
          ...override,
        }),
      });
      expect(response.status).toBe(400);
    }
    const large = await server.app.request(base, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.get(alice.user.id)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "x".repeat(1024 * 1024) }),
    });
    expect(large.status).toBe(413);
    const scriptCalls: Array<{ id: string; source: string }> = [];
    const pendingScripts = new Map<
      string,
      (result: Awaited<ReturnType<typeof jobs.runAutomationScript>>) => void
    >();
    let scriptStopFailures = 0;
    const originalScriptRun = jobs.runAutomationScript;
    const originalScriptStop = jobs.stopAutomationScript;
    jobs.runAutomationScript = async (id, input) => {
      withControlPlaneJobAuthority(harness.db, id, () => undefined);
      scriptCalls.push({ id, source: input.source });
      return new Promise((resolve) => pendingScripts.set(id, resolve));
    };
    jobs.stopAutomationScript = async (id) => {
      if (scriptStopFailures-- > 0)
        throw new Error("Script cleanup unavailable");
      pendingScripts.get(id)?.({
        jobId: id,
        status: "cancelled",
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        outputBytes: 0,
        truncated: false,
      });
      pendingScripts.delete(id);
    };
    try {
      const scriptDefinition = await mine.create({
        originThreadId: alice.thread.id,
        name: "Personal script",
        trigger: {
          triggerType: "schedule",
          cron: "* * * * *",
          timezone: "UTC",
        },
        script: { source: "console.log('original')", timeoutMs: 1000 },
      });
      expect(scriptDefinition.executionMode).toBe("script");
      expect(await mine.definition(scriptDefinition.id)).toMatchObject({
        executionMode: "script",
        script: { source: "console.log('original')", timeoutMs: 1000 },
      });
      expect((await mine.get(scriptDefinition.id)).id).toBe(
        scriptDefinition.id,
      );
      await expect(foreign.get(scriptDefinition.id)).rejects.toThrow("404");
      const firstScript = run.parse(
        await invoke(alice.user.id, "automations_run", {
          projectId: alice.project.id,
          automationId: scriptDefinition.id,
          idempotencyKey: "script-stable",
        }),
      ).run;
      expect(firstScript.threadId).toBeNull();
      expect(firstScript.status).toBe("running");
      expect(scriptCalls).toHaveLength(1);
      expect(scriptCalls[0]?.source).toBe("console.log('original')");
      const attempt = z
        .object({
          jobId: z.string().uuid(),
          cleanupError: z.string().nullable(),
        })
        .parse(native.scriptAttempt(firstScript.id));
      expect(attempt.jobId).toBe(scriptCalls[0]?.id);
      await invoke(alice.user.id, "controlPlaneAutomationUpdate", {
        projectId: alice.project.id,
        automationId: scriptDefinition.id,
        expectedRevision: 1,
        execution: {
          mode: "script",
          interpreter: "node",
          script: "console.log('revised')",
          workingDirectory: { type: "project" },
          timeoutMs: 1000,
        },
      });
      expect(scriptCalls[0]?.source).toBe("console.log('original')");
      scriptStopFailures = 2;
      await expect(
        invoke(alice.user.id, "controlPlaneAutomationStop", {
          projectId: alice.project.id,
          automationId: scriptDefinition.id,
          runId: firstScript.id,
        }),
      ).rejects.toThrow(/pending/u);
      expect(native.cancelRequested(firstScript.id)).toBe(true);
      expect(
        z
          .object({ cleanupError: z.string() })
          .parse(native.scriptAttempt(firstScript.id)).cleanupError,
      ).toContain("unavailable");
      expect(
        await mine.output(scriptDefinition.id, firstScript.id),
      ).toMatchObject({
        status: "running",
        cleanupPending: true,
        error: "Script cleanup unavailable",
        result: null,
      });
      pendingScripts.clear();
      native.restart();
      await native.tick(true);
      const states = async () =>
        z
          .object({
            runs: z.array(z.object({ id: z.string(), status: z.string() })),
          })
          .parse(
            await invoke(alice.user.id, "automations_runs", {
              projectId: alice.project.id,
              automationId: scriptDefinition.id,
            }),
          );
      expect(
        (await states()).runs.find((value) => value.id === firstScript.id)
          ?.status,
      ).toBe("running");
      await native.tick();
      await expect
        .poll(
          async () =>
            (await states()).runs.find((value) => value.id === firstScript.id)
              ?.status,
        )
        .toBe("cancelled");
      const scriptOutput = await mine.output(
        scriptDefinition.id,
        firstScript.id,
      );
      expect(scriptOutput.status).toBe("cancelled");
      expect(scriptOutput.result).toBeNull();
      expect(scriptOutput.cleanupPending).toBe(false);
      await expect(
        foreign.output(scriptDefinition.id, firstScript.id),
      ).rejects.toThrow("404");
      expect(scriptCalls).toHaveLength(1);
      const deduped = run.parse(
        await invoke(alice.user.id, "automations_run", {
          projectId: alice.project.id,
          automationId: scriptDefinition.id,
          idempotencyKey: "script-stable",
        }),
      ).run;
      expect(deduped.id).toBe(firstScript.id);
      expect(scriptCalls).toHaveLength(1);
      const interrupted = run.parse(
        await invoke(alice.user.id, "automations_run", {
          projectId: alice.project.id,
          automationId: scriptDefinition.id,
          idempotencyKey: "script-new",
        }),
      ).run;
      expect(scriptCalls[1]?.source).toBe("console.log('revised')");
      pendingScripts.clear();
      native.restart();
      await native.tick(true);
      await expect
        .poll(
          async () =>
            (await states()).runs.find((value) => value.id === interrupted.id)
              ?.status,
        )
        .toBe("failed");
      expect(scriptCalls).toHaveLength(2);
      await native.tick(true);
      const shuttingDownRun = await mine.run(scriptDefinition.id, {
        idempotencyKey: "shutdown-active",
      });
      const shuttingDownJob = scriptCalls.at(-1)?.id;
      if (!shuttingDownJob) throw new Error("No active script job");
      let closed = false;
      native.abort();
      const stopping = native.shutdown()?.then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(native.cancelRequested(shuttingDownRun.id)).toBe(true);
      await expect(mine.run(scriptDefinition.id)).rejects.toThrow("409");
      await expect(
        mine.create({
          originThreadId: alice.thread.id,
          name: "late",
          prompt: "owned prompt",
          trigger: { triggerType: "once", runAt: Date.now() + 3600000 },
        }),
      ).rejects.toThrow("409");
      await jobs.stopAutomationScript(shuttingDownJob);
      await stopping;
      expect(closed).toBe(true);
      expect(
        (await mine.output(scriptDefinition.id, shuttingDownRun.id)).status,
      ).toBe("cancelled");
      pendingScripts.clear();
      native.restart();
      await native.tick(true);
      const originalBind = jobs.bind;
      let arrived: () => void = () => {};
      let release: () => void = () => {};
      const bound = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      jobs.bind = async (input) => {
        const value = await originalBind(input);
        if (input.kind === "automation-run") {
          arrived();
          await gate;
        }
        return value;
      };
      const beforeLate = scriptCalls.length;
      try {
        const late = mine.run(scriptDefinition.id, {
          idempotencyKey: "shutdown-attachment",
        });
        await bound;
        native.abort();
        const shutdown = native.shutdown();
        release();
        expect((await late).status).toBe("cancelled");
        await shutdown;
        expect(scriptCalls).toHaveLength(beforeLate);
      } finally {
        release();
        jobs.bind = originalBind;
      }
      pendingScripts.clear();
      native.restart();
      await invoke(alice.user.id, "automations_delete", {
        projectId: alice.project.id,
        automationId: scriptDefinition.id,
      });
    } finally {
      jobs.runAutomationScript = originalScriptRun;
      jobs.stopAutomationScript = originalScriptStop;
    }
    setControlPlaneProfileAccess(
      harness.db,
      alice.profile.profileId,
      alice.user.id,
      false,
    );
    await expect(mine.resume(created.id)).rejects.toThrow();
    expect((await mine.get(created.id)).enabled).toBe(false);
    expect(await mine.remove(created.id)).toEqual({ deleted: true });
    await expect(mine.get(created.id)).rejects.toThrow("404");
  });
});
