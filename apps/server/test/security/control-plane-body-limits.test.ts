import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { count } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  ControlPlaneRegistry,
  controlPlaneUsers,
  controlPlaneProjects,
  controlPlaneProfiles,
  controlPlaneProfileVersions,
  controlPlaneProfileAccess,
  controlPlaneUserSessions,
  controlPlaneAuthFlows,
  controlPlaneJobBindings,
  threads,
  events,
  queuedThreadMessages,
} from "@bb/db";
import { withTestHarness } from "../helpers/test-app.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { createApp } from "../../src/server.js";
import {
  createControlPlaneAccess,
  withControlPlaneUser,
  withControlPlaneService,
} from "../../src/control-plane/access.js";
import { createControlPlaneUserAccess } from "../../src/control-plane/user-access.js";
import { createControlPlaneThreadService } from "../../src/control-plane/threads.js";
import { installControlPlaneProfileRoutes } from "../../src/control-plane/profile-routes.js";
import { hashAdminPassword } from "../../src/control-plane/credentials.js";

it("rejects oversized root/nested JSON, forms and empty-body actions before database or session mutations", async () => {
  await withTestHarness(async (harness) => {
    const { alice } = seedControlPlaneJobSubjects(harness.db);
    const registry = new ControlPlaneRegistry(harness.db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 299999,
    });
    const token = `agt_${randomBytes(32).toString("base64url")}`;
    registry.createSession(
      alice.user.id,
      createHash("sha256").update(token).digest("hex"),
      Date.now() + 60000,
      Date.now(),
      null,
    );
    const origin = "https://bb.example";
    harness.config.appUrl = origin;
    const service = createControlPlaneThreadService({ deps: harness.deps });
    const server = createApp(harness.deps, {
      controlPlane: createControlPlaneAccess(
        {
          version: 1,
          publicOrigin: origin,
          admin: {
            login: "admin",
            passwordHash: await hashAdminPassword("input-test-password"),
          },
        },
        Date.now,
        createControlPlaneUserAccess(
          registry,
          origin,
          Date.now,
          undefined,
          service,
        ),
      ),
    });
    const login = await server.app.request("/control-plane/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "admin", password: "input-test-password" }),
    });
    const credentials: unknown = await login.json();
    if (
      typeof credentials !== "object" ||
      credentials === null ||
      !("token" in credentials) ||
      typeof credentials.token !== "string"
    )
      throw new Error("Missing admin test token");
    const admin = credentials.token;
    const tables = [
      controlPlaneUsers,
      controlPlaneProjects,
      controlPlaneProfiles,
      controlPlaneProfileVersions,
      controlPlaneProfileAccess,
      controlPlaneUserSessions,
      controlPlaneAuthFlows,
      controlPlaneJobBindings,
      threads,
      events,
      queuedThreadMessages,
    ] as const;
    const snapshot = () =>
      tables.map(
        (table) =>
          harness.db.select({ value: count() }).from(table).get()?.value ?? 0,
      );
    const before = snapshot();
    async function send(
      path: string,
      body: string,
      identity: string | null,
      type: string,
      framing: "length" | "stream",
      method = "POST",
    ) {
      const bytes = new TextEncoder().encode(body);
      const headers: Record<string, string> = {
        "content-type": type,
        origin,
        ...(identity ? { authorization: `Bearer ${identity}` } : {}),
      };
      if (framing === "length")
        headers["content-length"] = String(bytes.byteLength);
      else headers["transfer-encoding"] = "chunked";
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.slice(offset, offset + 16384));
          offset += 16384;
        },
      });
      const init = {
        method,
        headers,
        body: framing === "length" ? body : stream,
        duplex: "half",
      };
      return server.app.fetch(new Request(origin + path, init));
    }
    const cases = [
      {
        path: "/control-plane/user/threads",
        limit: 1048576,
        identity: token,
        type: "application/json",
      },
      {
        path: `/control-plane/user/threads/${alice.thread.id}/send`,
        limit: 1048576,
        identity: token,
        type: "application/json",
      },
      {
        path: `/control-plane/user/threads/${alice.thread.id}/interactions/missing/resolve`,
        limit: 1048576,
        identity: token,
        type: "application/json",
      },
      {
        path: "/control-plane/admin/profiles",
        limit: 1048576,
        identity: admin,
        type: "application/json",
      },
      {
        path: `/control-plane/admin/profiles/${alice.profile.profileId}/versions`,
        limit: 1048576,
        identity: admin,
        type: "application/json",
      },
      {
        path: `/control-plane/admin/profiles/${alice.profile.profileId}/versions/${alice.profile.versionId}/enabled`,
        limit: 1048576,
        identity: admin,
        type: "application/json",
        method: "PUT",
      },
      {
        path: `/control-plane/admin/profiles/${alice.profile.profileId}/access/${alice.user.id}`,
        limit: 1048576,
        identity: admin,
        type: "application/json",
        method: "PUT",
      },
      {
        path: "/control-plane/user/projects",
        limit: 4096,
        identity: token,
        type: "application/json",
      },
      {
        path: "/control-plane/user/environment",
        limit: 1024,
        identity: token,
        type: "application/json",
      },
      {
        path: "/control-plane/user/logout",
        limit: 1024,
        identity: token,
        type: "application/json",
      },
      {
        path: "/control-plane/logout",
        limit: 1024,
        identity: admin,
        type: "application/json",
      },
      {
        path: "/control-plane/auth/start",
        limit: 4096,
        identity: null,
        type: "application/json",
      },
      {
        path: "/control-plane/auth/exchange",
        limit: 4096,
        identity: null,
        type: "application/json",
      },
      {
        path: "/control-plane/login",
        limit: 8192,
        identity: null,
        type: "application/json",
      },
      {
        path: "/control-plane/login",
        limit: 8192,
        identity: null,
        type: "application/x-www-form-urlencoded",
      },
    ];
    cases.push({
      path: `/control-plane/admin/profiles/${alice.profile.profileId}/enabled`,
      limit: 1048576,
      identity: admin,
      type: "application/json",
      method: "PUT",
    });
    try {
      for (const framing of ["length", "stream"] as const)
        for (const row of cases) {
          const definition = {
            prompt: "Bounded",
            providerId: "qwen-server",
            model: "qwen-test",
            reasoningLevel: "none",
            permissionMode: "full",
            tools: [],
            mcpServers: [],
          };
          const payload = row.path.endsWith("/login")
            ? { login: "admin", password: "input-test-password" }
            : row.path.endsWith("/auth/start")
              ? { clientName: "Rejected large flow", challenge: "a".repeat(43) }
              : row.path.endsWith("/auth/exchange")
                ? { flowId: alice.user.id, verifier: "a".repeat(43) }
                : row.path.endsWith("/threads")
                  ? {
                      projectId: alice.project.id,
                      profileVersionId: alice.profile.versionId,
                      message: "Must not start",
                    }
                  : row.path.endsWith("/send")
                    ? { message: "Must not send" }
                    : row.path.endsWith("/profiles")
                      ? {
                          slug: "must-not-create",
                          name: "Rejected profile",
                          definition,
                        }
                      : row.path.endsWith("/versions")
                        ? { definition }
                        : row.path.endsWith("/enabled")
                          ? { enabled: false }
                          : row.path.includes("/access/")
                            ? { allowed: false }
                            : row.path.endsWith("/projects")
                              ? {
                                  name: "Rejected project",
                                  slug: "must-not-create",
                                }
                              : {};
          const body =
            row.type === "application/json"
              ? JSON.stringify(payload) + " ".repeat(row.limit)
              : "login=admin&password=input-test-password" +
                "&".repeat(row.limit);
          const response = await send(
            row.path,
            body,
            row.identity,
            row.type,
            framing,
            row.method ?? "POST",
          );
          expect(response.status, `${framing} ${row.path}`).toBe(413);
          expect(response.headers.get("connection")).toBe("close");
          expect(snapshot()).toEqual(before);
        }
      for (const path of [
        `/control-plane/user/threads/${alice.thread.id}/stop`,
        "/control-plane/user/logout",
      ]) {
        expect(
          (
            await send(
              path,
              '{"model":"forged"}',
              token,
              "application/json",
              "stream",
            )
          ).status,
        ).toBe(400);
        expect(snapshot()).toEqual(before);
      }
      expect(
        (
          await send(
            "/control-plane/logout",
            '{"userId":"forged"}',
            admin,
            "application/json",
            "stream",
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await server.app.request("/control-plane/session", {
            headers: { authorization: `Bearer ${admin}` },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await server.app.request("/control-plane/user", {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await send(
            "/control-plane/auth/start",
            "{invalid",
            null,
            "application/json",
            "stream",
          )
        ).status,
      ).toBe(400);
      const malformed = await send(
        "/control-plane/login",
        "{invalid",
        null,
        "application/json",
        "stream",
      );
      expect(malformed.status).toBe(400);
      const validForm = await send(
        "/control-plane/login",
        "login=admin&password=input-test-password",
        null,
        "application/x-www-form-urlencoded",
        "stream",
      );
      expect(validForm.status).toBe(303);
    } finally {
      service.close();
      await server.pluginService.stop();
      await server.closeWebSockets();
    }
  });
});

it("enforces administrative profile ownership guards at the root and nested module boundaries", async () => {
  await withTestHarness(async (harness) => {
    const { alice } = seedControlPlaneJobSubjects(harness.db);
    const app = new Hono();
    installControlPlaneProfileRoutes(app, harness.db, () => ({
      user: { id: alice.user.id },
    }));
    for (const path of [
      "/control-plane/admin/profiles",
      `/control-plane/admin/profiles/${alice.profile.profileId}`,
      `/control-plane/admin/profiles/${alice.profile.profileId}/versions`,
    ]) {
      expect(
        (await withControlPlaneUser(alice.user.id, () => app.request(path)))
          .status,
      ).toBe(403);
      expect(
        (await withControlPlaneService(() => app.request(path))).status,
      ).toBe(200);
    }
  });
});
