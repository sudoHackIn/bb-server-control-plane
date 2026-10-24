import { once } from "node:events";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { serve } from "@hono/node-server";
import { createNodeBbSdk } from "@bb/sdk/node";
import { createProject, upsertHost } from "@bb/db";
import { Hono } from "hono";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createControlPlaneAccess,
  currentControlPlanePrincipal,
} from "../../src/control-plane/access.js";
import { hashAdminPassword } from "../../src/control-plane/credentials.js";
import { createApp } from "../../src/server.js";
import { withTestHarness } from "../helpers/test-app.js";

const password = "test-only-admin-password";
const config = async () => ({
  version: 1 as const,
  publicOrigin: "https://admin.example",
  admin: { login: "operator", passwordHash: await hashAdminPassword(password) },
});
const loginResponse = z.object({
  token: z.string(),
  role: z.literal("admin"),
  expiresAt: z.number(),
});

function runCli(
  baseUrl: string,
  clientHome: string,
  args: string[],
  input = "",
) {
  const repo = resolve(import.meta.dirname, "../../../..");
  return new Promise<{ ok: boolean; stdout: string; stderr: string }>(
    (complete) => {
      const child = execFile(
        process.execPath,
        [
          "--conditions=source",
          "--import",
          "tsx",
          join(repo, "apps/cli/src/index.ts"),
          ...args,
        ],
        {
          cwd: repo,
          env: {
            ...process.env,
            HOME: clientHome,
            BB_CLI: "",
            BB_SERVER_URL: baseUrl,
            BB_CLI_ERROR_LOG: "0",
          },
          encoding: "utf8",
          timeout: 10000,
        },
        (error, stdout, stderr) =>
          complete({ ok: error === null, stdout, stderr }),
      );
      child.stdin?.end(input);
    },
  );
}

describe("control-plane administrative boundary", () => {
  it("loads the administrative boundary from the server data directory before registering public routes", async () => {
    await withTestHarness(async (harness) => {
      const settings = await config();
      harness.config.appUrl = settings.publicOrigin;
      await writeFile(
        join(harness.config.dataDir, "control-plane.json"),
        JSON.stringify(settings),
        { mode: 0o600 },
      );
      const server = createApp(harness.deps);
      try {
        expect(server.sdkFetch).toBeTypeOf("function");
        expect((await server.app.request("/api/v1/projects")).status).toBe(401);
        expect((await server.app.request("/control-plane/login")).status).toBe(
          200,
        );
      } finally {
        await server.pluginService.stop();
        await server.closeWebSockets();
      }
    });
  });
  it("preserves a real server plugin's SDK and authenticated inter-plugin RPC without exposing a service token", async () => {
    await withTestHarness(async (harness) => {
      const access = createControlPlaneAccess(await config());
      harness.config.appUrl = access.publicOrigin;
      const server = createApp(harness.deps, { controlPlane: access });
      const root = join(harness.config.dataDir, "access-fixture");
      try {
        server.pluginService.bindSdk({
          baseUrl: "http://localhost",
          fetch: server.sdkFetch,
        });
        await mkdir(root);
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({
            name: "bb-plugin-access-fixture",
            version: "0.1.0",
            bb: {
              name: "Access fixture",
              description: "Access fixture",
              branding: { icon: "Zap" },
              server: "./server.ts",
            },
          }),
        );
        await writeFile(
          join(root, "server.ts"),
          "export default function plugin() {}",
        );
        expect((await server.pluginService.installPath(root)).status).toBe(
          "running",
        );
        const api = server.pluginService.getApi("access-fixture");
        if (!api) throw new Error("Plugin did not start");
        const callerSchema = z.union([
          z.object({ kind: z.literal("plugin"), pluginId: z.string() }),
          z.object({ kind: z.literal("client") }),
        ]);
        api.rpc.register(
          defineRpcContract({
            whoami: { input: z.null(), output: callerSchema },
          }),
          { whoami: (_input, context) => context.experimental_caller },
        );
        expect(await api.sdk.projects.list()).toEqual([]);
        expect(
          await api.sdk.plugins.callRpc({
            pluginId: "access-fixture",
            method: "whoami",
            input: null,
            outputSchema: callerSchema,
          }),
        ).toEqual({ kind: "plugin", pluginId: "access-fixture" });
        expect(
          (
            await server.app.request(
              "/api/v1/plugins/access-fixture/rpc/whoami",
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-bb-plugin-caller": "forged",
                },
                body: "null",
              },
            )
          ).status,
        ).toBe(401);
      } finally {
        await server.pluginService.stop();
        await server.closeWebSockets();
      }
    });
  });
  it("blocks all public entry points and local enrollment without credentials; permits the admin and private SDK", async () => {
    await withTestHarness(async (harness) => {
      const host = upsertHost(harness.db, harness.hub, {
        name: "shared-host",
      })!;
      const project = createProject(harness.db, harness.hub, {
        name: "Alice project",
        source: {
          type: "local_path",
          hostId: host.id,
          path: "/srv/alice/project",
        },
      }).project;
      const access = createControlPlaneAccess(await config());
      harness.config.appUrl = access.publicOrigin;
      const server = createApp(harness.deps, { controlPlane: access });
      try {
        for (const path of [
          "/api/v1/projects",
          "/api/v1/threads",
          "/api/v1/sidebar-bootstrap",
          "/api/v1/plugins",
          "/api/v1/system/config",
          "/ws",
          "/ws/terminals/guessed",
          "/install.sh",
        ]) {
          expect((await server.app.request(path)).status, path).toBe(401);
        }
        expect(
          (
            await server.app.request("/internal/hosts/enroll-key", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            })
          ).status,
        ).toBe(401);
        expect(
          (
            await server.app.request("/internal/hosts/%65nroll-key", {
              method: "POST",
            })
          ).status,
        ).toBe(401);
        expect(
          (
            await server.app.request("/api/v1/projects", {
              headers: {
                "x-user-id": "operator",
                "x-role": "admin",
                "x-bb-gate-auth": "session",
              },
            })
          ).status,
        ).toBe(401);
        expect(
          (
            await server.app.request("/", { headers: { accept: "text/html" } })
          ).headers.get("location"),
        ).toBe("/control-plane/login");
        expect(await (await server.app.request("/health")).json()).toEqual({
          ok: true,
        });
        expect(
          (
            await server.app.request("/internal/session/events", {
              method: "POST",
            })
          ).status,
        ).toBe(401);

        const signedIn = await server.app.request("/control-plane/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ login: "operator", password }),
        });
        const body: unknown = await signedIn.json();
        const session = loginResponse.parse(body);
        const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
        expect(signedIn.headers.get("set-cookie")).toContain("HttpOnly");
        expect(signedIn.headers.get("set-cookie")).toContain("Secure");
        expect(signedIn.headers.get("set-cookie")).toContain("SameSite=Strict");
        expect(
          (
            await server.app.request("/api/v1/projects", {
              headers: { cookie },
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await server.app.request("/api/v1/projects", {
              headers: { cookie, authorization: "Bearer forged" },
            })
          ).status,
        ).toBe(401);
        expect(
          (
            await server.app.request("/api/v1/projects", {
              method: "POST",
              headers: { cookie, "content-type": "application/json" },
              body: "{}",
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await server.app.request("/api/v1/projects", {
              method: "POST",
              headers: {
                cookie,
                origin: "https://evil.example",
                "content-type": "application/json",
              },
              body: "{}",
            })
          ).status,
        ).toBe(403);

        const sdk = createNodeBbSdk({
          baseUrl: "http://localhost",
          fetch: server.sdkFetch,
        });
        expect((await sdk.projects.list()).map((value) => value.id)).toContain(
          project.id,
        );
        expect((await server.app.request("/api/v1/projects")).status).toBe(401);
        await expect(
          access.dispatch(server.app, "http://localhost/control-plane/login"),
        ).rejects.toThrow("Internal SDK");
        const headers = { authorization: `Bearer ${session.token}` };
        expect(
          (await server.app.request("/api/v1/projects", { headers })).status,
        ).toBe(200);
        expect(
          (
            await server.app.request("/control-plane/logout", {
              method: "POST",
              headers,
            })
          ).status,
        ).toBe(200);
        expect(
          (await server.app.request("/api/v1/projects", { headers })).status,
        ).toBe(401);
        expect(currentControlPlanePrincipal()).toBeNull();
      } finally {
        await server.pluginService.stop();
        await server.closeWebSockets();
      }
    });
  });

  it("rejects bad passwords and cross-origin login, throttles attempts, expires sessions and keeps concurrent identities separate", async () => {
    let now = 1000;
    const access = createControlPlaneAccess(await config(), () => now);
    const app = new Hono();
    access.install(app);
    app.get("/api/v1/who", async (context) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return context.json(currentControlPlanePrincipal());
    });
    const signIn = (candidate: string, origin?: string) =>
      app.request("/control-plane/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify({ login: "operator", password: candidate }),
      });
    expect((await signIn(password, "https://evil.example")).status).toBe(403);
    const form = await app.request("/control-plane/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://admin.example",
      },
      body: new URLSearchParams({ login: "operator", password }).toString(),
    });
    expect(form.status).toBe(303);
    expect(await form.text()).not.toContain("token");
    for (let i = 0; i < 5; i++)
      expect((await signIn("wrong")).status).toBe(401);
    expect((await signIn(password)).status).toBe(429);
    now += 60001;
    const response: unknown = await (await signIn(password)).json();
    const session = loginResponse.parse(response);
    const headers = { authorization: `Bearer ${session.token}` };
    const [admin, service, denied] = await Promise.all([
      app.request("/api/v1/who", { headers }),
      access.dispatch(app, "http://localhost/api/v1/who"),
      app.request("/api/v1/who"),
    ]);
    expect(await admin.json()).toEqual({ kind: "admin", login: "operator" });
    expect(await service.json()).toEqual({ kind: "service" });
    expect(denied.status).toBe(401);
    now = session.expiresAt;
    expect((await app.request("/api/v1/who", { headers })).status).toBe(401);
  });

  it("checks real WebSocket upgrades and closes an established socket on logout", async () => {
    await withTestHarness(async (harness) => {
      const settings = await config();
      const access = createControlPlaneAccess(settings);
      harness.config.appUrl = access.publicOrigin;
      const server = createApp(harness.deps, { controlPlane: access });
      const listener = serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: server.app.fetch,
      });
      server.injectWebSocket(listener);
      if (!listener.listening) await once(listener, "listening");
      const address = listener.address();
      if (!address || typeof address === "string")
        throw new Error("Expected TCP listener");
      const base = `http://127.0.0.1:${address.port}`;
      settings.publicOrigin = base;
      harness.config.appUrl = base;
      harness.config.serverPort = address.port;
      let socket: WebSocket | null = null;
      try {
        expect((await fetch(`${base}/api/v1/projects`)).status).toBe(401);
        const clientHome = join(harness.config.dataDir, "cli-home");
        await mkdir(clientHome);
        const signedInCli = await runCli(
          base,
          clientHome,
          [
            "server",
            "access",
            "login",
            "--login",
            "operator",
            "--password-stdin",
          ],
          password,
        );
        expect(signedInCli, signedInCli.stderr).toMatchObject({ ok: true });
        expect(signedInCli.stdout).not.toContain(password);
        const cliStatus = await runCli(base, clientHome, [
          "server",
          "access",
          "status",
        ]);
        expect(cliStatus, cliStatus.stderr).toMatchObject({ ok: true });
        expect(cliStatus.stdout).toContain("operator");
        const projects = await runCli(base, clientHome, [
          "project",
          "list",
          "--json",
        ]);
        expect(projects, projects.stderr).toMatchObject({ ok: true });
        const cliLogout = await runCli(base, clientHome, [
          "server",
          "access",
          "logout",
        ]);
        expect(cliLogout, cliLogout.stderr).toMatchObject({ ok: true });
        expect(
          (await runCli(base, clientHome, ["project", "list", "--json"])).ok,
        ).toBe(false);
        const rejected = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
        rejected.on("error", () => {});
        const unauthorized = await new Promise<number>((complete) =>
          rejected.once("unexpected-response", (_request, response) => {
            response.resume();
            complete(response.statusCode ?? 0);
          }),
        );
        expect(unauthorized).toBe(401);
        rejected.terminate();
        const signedIn = await fetch(`${base}/control-plane/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ login: "operator", password }),
        });
        const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
        for (const [origin, authorization, expected] of [
          [undefined, undefined, 403],
          ["https://evil.example", undefined, 403],
          [base, "Bearer forged", 401],
        ] as const) {
          const denied = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
            origin,
            headers: { cookie, ...(authorization ? { authorization } : {}) },
          });
          denied.on("error", () => {});
          const status = await new Promise<number>((complete) =>
            denied.once("unexpected-response", (_request, response) => {
              response.resume();
              complete(response.statusCode ?? 0);
            }),
          );
          expect(status).toBe(expected);
          denied.terminate();
        }
        socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
          headers: { cookie },
          origin: base,
        });
        await once(socket, "open");
        const connected = socket;
        const closed = new Promise<number>((complete) =>
          connected.once("close", (code) => complete(code)),
        );
        expect(
          (
            await fetch(`${base}/control-plane/logout`, {
              method: "POST",
              headers: { cookie, origin: base },
            })
          ).status,
        ).toBe(200);
        expect(await closed).toBe(4401);
      } finally {
        socket?.terminate();
        await server.pluginService.stop();
        await server.closeWebSockets();
        await new Promise<void>((resolve, reject) =>
          listener.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  });
});
