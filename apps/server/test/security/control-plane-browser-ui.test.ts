import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { ControlPlaneRegistry } from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { createControlPlaneAccess } from "../../src/control-plane/access.js";
import { createControlPlaneUserAccess } from "../../src/control-plane/user-access.js";
import { hashAdminPassword } from "../../src/control-plane/credentials.js";

it("admits authenticated personal shell assets without admitting administrative APIs, plugins or arbitrary paths", async () => {
  const db = createMigratedConnection();
  try {
    const registry = new ControlPlaneRegistry(db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 200010,
    });
    const user = registry.reserve("alice", 1);
    const token = `agt_${randomBytes(32).toString("base64url")}`;
    const digest = createHash("sha256").update(token).digest("hex");
    expect(registry.createSession(user.id, digest, 1000, 1, null)).toBe(true);
    const app = new Hono();
    const access = createControlPlaneAccess(
      {
        version: 1,
        publicOrigin: "https://bb.example",
        admin: {
          login: "admin",
          passwordHash: await hashAdminPassword("long-test-only-password"),
        },
      },
      () => 2,
      createControlPlaneUserAccess(registry, "https://bb.example", () => 2),
    );
    access.install(app);
    app.get("*", (context) => context.html("native application"));
    const loginRedirect = await app.request("/control-plane/app", {
      headers: { accept: "text/html" },
    });
    expect(loginRedirect.status).toBe(303);
    expect(loginRedirect.headers.get("location")).toBe(
      "/control-plane/user/login",
    );
    const deepRedirect = await app.request(
      "/projects/p/threads/t?view=history",
      {
        headers: { accept: "text/html" },
      },
    );
    expect(deepRedirect.status).toBe(303);
    expect(deepRedirect.headers.get("location")).toBe(
      "/control-plane/user/login?returnTo=%2Fprojects%2Fp%2Fthreads%2Ft%3Fview%3Dhistory",
    );
    const headers = { cookie: `bb_user_session=${token}` };
    for (const path of [
      "/control-plane/app",
      "/projects/own-project",
      "/projects/own-project/threads/own-thread",
      "/threads/own-thread",
      "/projects/foreign-project/threads/foreign-thread",
      "/assets/main-123.js",
      "/assets/main-123.css",
      "/favicon-32x32.png",
      "/manifest.webmanifest",
    ]) {
      expect((await app.request(path)).status).toBe(401);
      const response = await app.request(path, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toBeNull();
    }
    for (const path of [
      "/",
      "/index.html",
      "/api/v1/projects",
      "/api/v1/threads",
      "/ws",
      "/assets/nested/secret",
      "/plugins/composer/app.js",
      "/control-plane/admin/profiles",
    ]) {
      const response = await app.request(path, { headers });
      expect(response.status, path).not.toBe(200);
      expect(await response.text(), path).not.toContain("native application");
    }
    const invalidHeaders: Record<string, string>[] = [
      { authorization: "Bearer invalid" },
      { origin: "https://evil.example" },
      { "x-bb-client-identity": "user:bob" },
      { "x-bb-client-session": "stale" },
    ];
    for (const extra of invalidHeaders) {
      expect(
        (
          await app.request("/control-plane/app", {
            headers: { ...headers, ...extra },
          })
        ).status,
      ).not.toBe(200);
    }
    expect(
      (await app.request("/control-plane/app", { method: "POST", headers }))
        .status,
    ).toBe(401);
    registry.revoke(digest);
    expect((await app.request("/assets/main-123.js", { headers })).status).toBe(
      401,
    );
    access.close();
  } finally {
    db.$client.close();
  }
});
