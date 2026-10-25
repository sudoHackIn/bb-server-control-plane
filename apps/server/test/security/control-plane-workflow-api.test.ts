import { createHash, randomBytes } from "node:crypto";
import { expect, it, onTestFinished } from "vitest";
import { and, eq } from "drizzle-orm";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  ControlPlaneRegistry,
  controlPlaneUserSessions,
  setControlPlaneProfileAccess,
  controlPlaneJobBindings,
  controlPlaneProjectAccess,
  controlPlaneUsers,
  installedPlugins,
} from "@bb/db";
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
import {
  createControlPlaneWorkflowService,
  createControlPlaneWorkflowRpc,
} from "../../src/control-plane/workflows.js";
import { createControlPlaneAccess } from "../../src/control-plane/access.js";
import { createControlPlaneUserAccess } from "../../src/control-plane/user-access.js";
import { hashAdminPassword } from "../../src/control-plane/credentials.js";
import { withTestHarness } from "../helpers/test-app.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";

it("runs the limited SDK against native plugin SQLite with owner-scoped pagination, history, result, resume and safe cancellation", async () => {
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
          (bb: BbPluginApi) => { settle: (id: string) => void }
        >((value) => typeof value === "function"),
      })
      .parse(imported).default;
    const native = factory(fake.bb);
    const service = createControlPlaneWorkflowService(
      harness.db,
      async (method, input) =>
        jsonValueSchema.parse(await fake.harness.callRpc(method, input)),
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
          undefined,
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
    const base = "/control-plane/user/workflows";
    const script =
      'export const meta = {name:"personal-api",description:"Owned native run"}; return {value:42};';
    try {
      expect((await request(null, base)).status).toBe(401);
      expect(
        (
          await request(alice.user.id, base, "POST", {
            originThreadId: alice.thread.id,
            script: "x".repeat(4 * 1024 * 1024 + 1),
          })
        ).status,
      ).toBe(413);
      expect(harness.db.select().from(controlPlaneJobBindings).all()).toEqual(
        [],
      );
      await expect(
        createControlPlaneWorkflowRpc(harness.db, () => server.pluginService)(
          "controlPlaneWorkflowGet",
          { runId: "missing" },
        ),
      ).rejects.toMatchObject({ status: 503 });
      harness.db
        .insert(controlPlaneProjectAccess)
        .values({
          userId: bob.user.id,
          projectId: alice.project.id,
          role: "viewer",
        })
        .run();
      const first = await client(alice.user.id).workflows.start({
        originThreadId: alice.thread.id,
        script,
      });
      const foreign = await client(bob.user.id).workflows.start({
        originThreadId: bob.thread.id,
        script,
      });
      const second = await client(alice.user.id).workflows.start({
        originThreadId: alice.thread.id,
        script,
      });
      expect(first.projectId).toBe(alice.project.id);
      const page = await client(alice.user.id).workflows.list({ limit: 1 });
      expect(page.runs).toHaveLength(1);
      expect(page.nextCursor).not.toBeNull();
      const more = await client(alice.user.id).workflows.list({
        limit: 1,
        cursor: page.nextCursor ?? undefined,
      });
      expect(
        new Set([...page.runs, ...more.runs].map((row) => row.id)),
      ).toEqual(new Set([first.id, second.id]));
      expect(
        (await client(bob.user.id).workflows.list()).runs.map((row) => row.id),
      ).toEqual([foreign.id]);
      for (const suffix of ["", "/result", "/history", "/stop"])
        expect(
          (
            await request(
              bob.user.id,
              `${base}/${first.id}${suffix}`,
              suffix === "/stop" ? "POST" : "GET",
            )
          ).status,
        ).toBe(404);
      expect(
        (
          await request(bob.user.id, base, "POST", {
            originThreadId: alice.thread.id,
            script,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(bob.user.id, base, "POST", {
            originThreadId: bob.thread.id,
            script,
            resumeRunId: first.id,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(alice.user.id, base, "POST", {
            originThreadId: alice.thread.id,
            script,
            userId: bob.user.id,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(
            alice.user.id,
            "/api/v1/plugins/workflows/rpc/controlPlaneWorkflowGet",
            "POST",
            { runId: first.id },
          )
        ).status,
      ).toBe(401);
      expect(
        (await client(alice.user.id).workflows.history(first.id)).calls,
      ).toEqual([]);
      expect(
        (await client(alice.user.id).workflows.result(first.id)).available,
      ).toBe(false);
      native.settle(first.id);
      expect(
        await client(alice.user.id).workflows.result(first.id),
      ).toMatchObject({ available: true, value: { value: 42 } });
      const resumed = await client(alice.user.id).workflows.start({
        originThreadId: alice.thread.id,
        script,
        resumeRunId: first.id,
      });
      expect(resumed.id).not.toBe(first.id);
      const escaped = await client(alice.user.id).workflows.start({
        originThreadId: alice.thread.id,
        script: `/*${'"'.repeat(512000)}*/${script}`,
        args: { text: '"'.repeat(40000) },
      });
      expect(escaped.name).toBe("personal-api");
      setControlPlaneProfileAccess(
        harness.db,
        alice.profile.profileId,
        alice.user.id,
        false,
      );
      expect((await client(alice.user.id).workflows.get(second.id)).id).toBe(
        second.id,
      );
      await expect(
        client(alice.user.id).workflows.start({
          originThreadId: alice.thread.id,
          script,
        }),
      ).rejects.toThrow("403");
      expect(await client(alice.user.id).workflows.stop(second.id)).toEqual({
        stopped: true,
      });
      expect(
        (await client(alice.user.id).workflows.get(second.id)).status,
      ).toBe("cancelled");
      expect(
        harness.db
          .select()
          .from(controlPlaneJobBindings)
          .where(eq(controlPlaneJobBindings.objectId, second.id))
          .get()?.enabled,
      ).toBe(false);
      harness.db
        .delete(controlPlaneProjectAccess)
        .where(
          and(
            eq(controlPlaneProjectAccess.userId, alice.user.id),
            eq(controlPlaneProjectAccess.projectId, alice.project.id),
          ),
        )
        .run();
      expect(
        (await request(alice.user.id, `${base}/${first.id}/result`)).status,
      ).toBe(404);
      expect((await client(alice.user.id).workflows.list()).runs).toEqual([]);
      harness.db
        .update(controlPlaneUsers)
        .set({ enabled: false })
        .where(eq(controlPlaneUsers.id, bob.user.id))
        .run();
      expect((await request(bob.user.id, base)).status).toBe(401);
    } finally {
      await fake.harness.dispose();
      await rm(directory, { recursive: true, force: true });
      await server.pluginService.stop();
      await server.closeWebSockets();
    }
  });
});

it("refuses an enabled same-ID plugin without builtin provenance before invoking any RPC", async () => {
  await withTestHarness(async (harness) => {
    harness.db
      .insert(installedPlugins)
      .values({
        id: "workflows",
        source: "builtin:workflows",
        rootDir: "/untrusted/workflows",
        version: "0.1.0",
        provenance: "direct",
        sourceKind: "builtin",
        sourceBuiltinName: "workflows",
        installedAt: 1,
        updatedAt: 1,
      })
      .run();
    const rpc = createControlPlaneWorkflowRpc(harness.db, () => {
      throw new Error("Must not invoke unapproved plugin");
    });
    await expect(
      rpc("controlPlaneWorkflowGet", { runId: "missing" }),
    ).rejects.toMatchObject({ status: 503 });
  });
});
