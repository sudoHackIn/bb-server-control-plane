import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { z } from "zod";
import { expect, it, onTestFinished } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
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
    const native = factory(fake.bb);
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
    expect(
      harness.db
        .select()
        .from(controlPlaneJobBindings)
        .where(eq(controlPlaneJobBindings.objectId, saved.id))
        .get()?.deletedAt,
    ).not.toBeNull();
  });
});
