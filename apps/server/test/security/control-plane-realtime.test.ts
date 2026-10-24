import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createNodeBbSdk, type BbRealtimeSocket } from "@bb/sdk";
import { createProject, upsertHost } from "@bb/db";
import WebSocket from "ws";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp } from "../../src/server.js";
import {
  createControlPlaneAccess,
  withControlPlaneUser,
} from "../../src/control-plane/access.js";
import { createPrivateRealtime } from "../../src/control-plane/realtime.js";
import { hashAdminPassword } from "../../src/control-plane/credentials.js";
import { withTestHarness } from "../helpers/test-app.js";

function networkSocket(url: string, token: string): BbRealtimeSocket {
  const native = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  const socket: BbRealtimeSocket = {
    get readyState() {
      return native.readyState;
    },
    onopen: null,
    onerror: null,
    onclose: null,
    onmessage: null,
    send(data) {
      native.send(data);
    },
    close() {
      native.close();
    },
  };
  native.on("open", () => socket.onopen?.());
  native.on("message", (data) => socket.onmessage?.({ data: data.toString() }));
  native.on("close", () => socket.onclose?.());
  native.on("error", () => socket.onerror?.());
  return socket;
}

it.each(["public", "private"] as const)(
  "delivers native project notifications through %s SDK realtime and releases subscriptions",
  async (surface) => {
    await withTestHarness(async (harness) => {
      const settings = {
        version: 1 as const,
        publicOrigin: "https://admin.example",
        admin: {
          login: "admin",
          passwordHash: await hashAdminPassword("test-admin-password"),
        },
      };
      const access = createControlPlaneAccess(settings);
      harness.config.appUrl = settings.publicOrigin;
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
        throw new Error("Missing listener");
      const base = `http://127.0.0.1:${address.port}`;
      settings.publicOrigin = base;
      harness.config.appUrl = base;
      harness.config.serverPort = address.port;
      const signedIn = await server.app.request("/control-plane/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          login: "admin",
          password: "test-admin-password",
        }),
      });
      const { token } = z
        .object({ token: z.string() })
        .parse(await signedIn.json());
      const host = upsertHost(harness.db, harness.hub, {
        name: "Realtime host",
      });
      const { project } = createProject(harness.db, harness.hub, {
        name: "Realtime",
        source: { type: "local_path", hostId: host.id, path: "/tmp/realtime" },
      });
      const sdk = createNodeBbSdk({
        baseUrl: base,
        fetch:
          surface === "private"
            ? server.sdkFetch
            : (input, init) => {
                const headers = new Headers(init?.headers);
                headers.set("authorization", `Bearer ${token}`);
                return fetch(input, { ...init, headers });
              },
        websocket:
          surface === "private"
            ? server.sdkWebsocket
            : (url) => networkSocket(url, token),
      });
      const received: unknown[] = [];
      const unsubscribe = sdk.subscribe({
        event: "project:changed",
        projectId: project.id,
        callback: (event) => received.push(event),
      });
      try {
        await vi.waitFor(() =>
          expect(
            harness.hub.listWatchedTargets("project-detail"),
          ).toContainEqual({ kind: "project-detail", projectId: project.id }),
        );
        await sdk.projects.update({
          projectId: project.id,
          name: "Updated through SDK",
        });
        await vi.waitFor(() =>
          expect(received).toContainEqual(
            expect.objectContaining({
              entity: "project",
              id: project.id,
              changes: ["project-updated"],
            }),
          ),
        );
        expect((await server.app.request("/api/v1/projects")).status).toBe(401);
        const count = received.length;
        unsubscribe();
        await vi.waitFor(() =>
          expect(harness.hub.listWatchedTargets("project-detail")).toEqual([]),
        );
        await sdk.projects.update({
          projectId: project.id,
          name: "After unsubscribe",
        });
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        expect(received).toHaveLength(count);
      } finally {
        unsubscribe();
        await server.pluginService.stop();
        await server.closeWebSockets();
        await new Promise<void>((resolve) => listener.close(() => resolve()));
      }
    });
  },
);

it("closes invalid private messages, cancels pending opens and rejects user-global connections", async () => {
  await withTestHarness(async (harness) => {
    const transport = createPrivateRealtime(harness.hub);
    expect(() =>
      withControlPlaneUser("alice", () =>
        transport.websocket("ws://private/ws"),
      ),
    ).toThrow("scoped transport");
    const client = transport.websocket("ws://private/ws");
    await new Promise<void>((resolve) => {
      client.onopen = resolve;
    });
    client.send("invalid json");
    expect(client.readyState).toBe(3);
    const pending = transport.websocket("ws://private/ws");
    const opened = vi.fn();
    pending.onopen = opened;
    transport.close();
    transport.close();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(pending.readyState).toBe(3);
    expect(opened).not.toHaveBeenCalled();
    expect(() => transport.websocket("ws://private/ws")).toThrow("closed");
  });
});

it("owns plugin SDK subscriptions for the plugin's lifetime, including saved SDK references", async () => {
  await withTestHarness(async (harness) => {
    const settings = {
      version: 1 as const,
      publicOrigin: "https://admin.example",
      admin: {
        login: "admin",
        passwordHash: await hashAdminPassword("test-admin-password"),
      },
    };
    harness.config.appUrl = settings.publicOrigin;
    const server = createApp(harness.deps, {
      controlPlane: createControlPlaneAccess(settings),
    });
    server.pluginService.bindSdk({
      baseUrl: "http://private.invalid",
      fetch: server.sdkFetch,
      websocket: server.sdkWebsocket,
    });
    const root = join(harness.config.dataDir, "realtime-fixture");
    await mkdir(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "bb-plugin-realtime-fixture",
        version: "0.1.0",
        bb: {
          name: "Realtime fixture",
          description: "Realtime fixture",
          branding: { icon: "Zap" },
          server: "server.ts",
        },
      }),
    );
    await writeFile(
      join(root, "server.ts"),
      "export default function plugin() {}",
    );
    try {
      expect((await server.pluginService.installPath(root)).status).toBe(
        "running",
      );
      const api = server.pluginService.getApi("realtime-fixture");
      if (!api) throw new Error("Plugin is unavailable");
      const sdk = api.sdk;
      const received = vi.fn();
      sdk.subscribe({
        event: "project:changed",
        projectId: "prj_fixture",
        callback: received,
      });
      await vi.waitFor(() =>
        expect(harness.hub.listWatchedTargets("project-detail")).toHaveLength(
          1,
        ),
      );
      expect(() =>
        withControlPlaneUser("alice", () =>
          sdk.subscribe({
            event: "project:changed",
            projectId: "prj_fixture",
            callback: received,
          }),
        ),
      ).toThrow("scoped transport");
      harness.hub.notifyProject("prj_fixture", ["project-updated"]);
      await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
      await server.pluginService.setEnabled("realtime-fixture", false);
      expect(harness.hub.listWatchedTargets("project-detail")).toEqual([]);
      harness.hub.notifyProject("prj_fixture", ["project-updated"]);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(received).toHaveBeenCalledOnce();
      expect(() =>
        sdk.subscribe({ event: "project:changed", callback: received }),
      ).toThrow();
    } finally {
      await server.pluginService.stop();
      await server.closeWebSockets();
    }
  });
});
