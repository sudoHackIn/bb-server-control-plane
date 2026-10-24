import type { IncomingHttpHeaders } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:https";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  ControlPlaneRegistry,
  controlPlaneUsers,
  controlPlaneUserSessions,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { createControlPlaneClient } from "@bb/sdk/node";
import { describe, expect, it } from "vitest";
import { createControlPlaneAccess } from "../../src/control-plane/access.js";
import { hashAdminPassword } from "../../src/control-plane/credentials.js";
import { createControlPlaneUserAccess } from "../../src/control-plane/user-access.js";
import { startHttpListener } from "../../src/start-server.js";

const exec = promisify(execFile);

describe("control-plane personal authorization", () => {
  it("does not expose the native UI through unsupported public-auth methods and expires pending flows", async () => {
    const db = createMigratedConnection();
    let now = 1;
    try {
      const registry = new ControlPlaneRegistry(db, {
        usersRoot: "/srv/users",
        firstUid: 200000,
        lastUid: 200010,
      });
      const app = new Hono();
      const origin = "https://bb.example";
      createControlPlaneAccess(
        {
          version: 1,
          publicOrigin: origin,
          admin: {
            login: "admin",
            passwordHash: await hashAdminPassword("long-test-only-password"),
          },
        },
        () => now,
        createControlPlaneUserAccess(registry, origin, () => now),
      ).install(app);
      app.get("*", (context) => context.html("private native UI"));
      for (const path of [
        "/control-plane/auth/start",
        "/control-plane/auth/exchange",
        "/control-plane/user/logout",
      ])
        expect((await app.request(path)).status).toBe(401);
      const verifier = randomBytes(32).toString("base64url");
      const start = await app.request("/control-plane/auth/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientName: "test",
          challenge: createHash("sha256").update(verifier).digest("base64url"),
        }),
      });
      const raw: unknown = await start.json();
      const flow = z.object({ flowId: z.string() }).parse(raw);
      now += 10 * 60 * 1000;
      expect(
        (
          await app.request("/control-plane/auth/exchange", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ flowId: flow.flowId, verifier }),
          })
        ).status,
      ).toBe(404);
    } finally {
      db.$client.close();
    }
  });
  it("allocates stable UUID homes and monotonic UIDs atomically without recycling disabled users", () => {
    const db = createMigratedConnection();
    try {
      const registry = new ControlPlaneRegistry(db, {
        usersRoot: "/srv/users",
        firstUid: 200000,
        lastUid: 200001,
      });
      const alice = registry.reserve("alice", 1);
      expect(registry.reserve("alice", 2)).toEqual(alice);
      expect(alice).toMatchObject({
        uid: 200000,
        gid: 200000,
        home: `/srv/users/${alice.id}/home`,
        environmentStatus: "allocated",
      });
      db.update(controlPlaneUsers)
        .set({ enabled: false })
        .where(eq(controlPlaneUsers.id, alice.id))
        .run();
      const bob = registry.reserve("bob", 3);
      expect(bob.uid).toBe(200001);
      expect(bob.home).not.toBe(alice.home);
      expect(() => registry.reserve("charlie", 4)).toThrow(
        "allocation exhausted",
      );
      expect(registry.user("charlie")).toBeUndefined();
    } finally {
      db.$client.close();
    }
  });

  it("requires a real trusted certificate, binds approval to its CN and exchanges PKCE only once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-cert-test-"));
    const db = createMigratedConnection();
    let now = Date.now();
    const registry = new ControlPlaneRegistry(db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 200010,
    });
    try {
      const openssl = async (...args: string[]) =>
        exec("openssl", args, { cwd: directory, timeout: 10000 });
      await openssl(
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-keyout",
        "ca.key",
        "-out",
        "ca.crt",
        "-days",
        "1",
        "-subj",
        "/CN=BB test CA",
      );
      for (const name of ["server", "alice", "bob"]) {
        await openssl(
          "req",
          "-new",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:P-256",
          "-nodes",
          "-keyout",
          `${name}.key`,
          "-out",
          `${name}.csr`,
          "-subj",
          `/CN=${name}`,
          "-addext",
          "subjectAltName=IP:127.0.0.1",
          "-addext",
          `extendedKeyUsage=${name === "server" ? "serverAuth" : "clientAuth"}`,
        );
        await openssl(
          "x509",
          "-req",
          "-in",
          `${name}.csr`,
          "-CA",
          "ca.crt",
          "-CAkey",
          "ca.key",
          "-CAcreateserial",
          "-out",
          `${name}.crt`,
          "-days",
          "1",
          "-copy_extensions",
          "copy",
        );
      }
      await openssl(
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-keyout",
        "rogue.key",
        "-out",
        "rogue.crt",
        "-days",
        "1",
        "-subj",
        "/CN=alice",
      );
      const ca = await readFile(join(directory, "ca.crt"));
      const app = new Hono();
      let origin = "https://127.0.0.1";
      const server = startHttpListener({
        fetch: app.fetch,
        serverConfig: { BB_SERVER_BIND_HOST: "127.0.0.1", BB_SERVER_PORT: 0 },
        tls: {
          key: await readFile(join(directory, "server.key")),
          cert: await readFile(join(directory, "server.crt")),
          ca,
          requestCert: true,
          rejectUnauthorized: false,
        },
      });
      try {
        if (!server.listening) await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Expected TCP listener");
        origin = `https://127.0.0.1:${address.port}`;
        createControlPlaneAccess(
          {
            version: 1,
            publicOrigin: origin,
            admin: {
              login: "admin",
              passwordHash: await hashAdminPassword("long-test-only-password"),
            },
          },
          () => now,
          createControlPlaneUserAccess(registry, origin, () => now),
        ).install(app);
        app.get("/api/v1/projects", (context) =>
          context.json({ projects: [] }),
        );
        const send = async (
          path: string,
          options: {
            user?: string;
            method?: string;
            body?: object | string;
            headers?: Record<string, string>;
          } = {},
        ) => {
          const key = options.user
            ? await readFile(join(directory, `${options.user}.key`))
            : undefined;
          const cert = options.user
            ? await readFile(join(directory, `${options.user}.crt`))
            : undefined;
          return new Promise<{
            status: number;
            text: string;
            headers: IncomingHttpHeaders;
          }>((resolve, reject) => {
            const req = request(
              `${origin}${path}`,
              {
                ca,
                key,
                cert,
                method: options.method ?? (options.body ? "POST" : "GET"),
                headers: {
                  ...(options.body && typeof options.body !== "string"
                    ? { "content-type": "application/json" }
                    : {}),
                  ...options.headers,
                },
                timeout: 5000,
              },
              (res) => {
                let text = "";
                res
                  .setEncoding("utf8")
                  .on("data", (part: string) => (text += part));
                res.once("end", () =>
                  resolve({
                    status: res.statusCode ?? 0,
                    text,
                    headers: res.headers,
                  }),
                );
              },
            );
            req.once("error", reject);
            req.once("timeout", () =>
              req.destroy(new Error("TLS request timeout")),
            );
            req.end(
              options.body
                ? typeof options.body === "string"
                  ? options.body
                  : JSON.stringify(options.body)
                : undefined,
            );
          });
        };
        const sdk = createControlPlaneClient({
          origin,
          fetch: async (input, init) => {
            const target = new URL(
              input instanceof Request ? input.url : input.toString(),
            );
            const headers = Object.fromEntries(
              new Headers(init?.headers).entries(),
            );
            const result = await send(target.pathname, {
              body: typeof init?.body === "string" ? init.body : undefined,
              headers,
            });
            return new Response(result.text, { status: result.status });
          },
        });
        const verifier = randomBytes(32).toString("base64url");
        const flow = await sdk.start(
          "BB test",
          createHash("sha256").update(verifier).digest("base64url"),
        );
        const path = new URL(flow.authorizationUrl).pathname;
        expect(
          (
            await send(path, {
              headers: {
                "x-user-id": "alice",
                "x-ssl-client-s-dn": "CN=alice",
              },
            })
          ).status,
        ).toBe(401);
        const page = await send(path, { user: "alice" });
        expect((await send(path, { user: "rogue" })).status).toBe(401);
        expect((await send(path, { user: "server" })).status).toBe(401);
        expect(page.status).toBe(200);
        const csrf = page.text.match(/name="csrf" value="([^"]+)"/u)?.[1];
        if (!csrf) throw new Error("Missing approval form");
        expect(await sdk.exchange(flow.flowId, verifier)).toEqual({
          status: "pending",
        });
        const approval = {
          body: new URLSearchParams({ csrf, decision: "approve" }).toString(),
          headers: {
            origin,
            "content-type": "application/x-www-form-urlencoded",
          },
        };
        expect((await send(path, { ...approval, user: "bob" })).status).toBe(
          403,
        );
        expect(
          (
            await send(path, {
              ...approval,
              user: "alice",
              headers: { ...approval.headers, origin: "https://evil.example" },
            })
          ).status,
        ).toBe(403);
        expect((await send(path, { ...approval, user: "alice" })).status).toBe(
          200,
        );
        expect(
          (
            await send("/control-plane/auth/exchange", {
              body: {
                flowId: flow.flowId,
                verifier: randomBytes(32).toString("base64url"),
              },
            })
          ).status,
        ).toBe(403);
        const issued = await sdk.exchange(flow.flowId, verifier);
        if (issued.status !== "authorized")
          throw new Error("Expected authorization");
        expect(issued.expiresAt - now).toBe(86400000);
        expect(
          db.select().from(controlPlaneUserSessions).all()[0]?.digest,
        ).not.toBe(issued.accessToken);
        expect(
          (
            await send("/control-plane/auth/exchange", {
              body: { flowId: flow.flowId, verifier },
            })
          ).status,
        ).toBe(409);
        const headers = { authorization: `Bearer ${issued.accessToken}` };
        expect((await send("/control-plane/user", { headers })).text).toContain(
          '"login":"alice"',
        );
        expect((await send("/api/v1/projects", { headers })).status).toBe(401);
        const cookie = (
          result: { headers: IncomingHttpHeaders },
          name: string,
        ) => {
          const value = result.headers["set-cookie"]?.find((value) =>
            value.startsWith(name + "="),
          );
          if (!value) throw new Error("Missing browser session cookie");
          return { value: value.split(";")[0]!, attributes: value };
        };
        const browserPath = "/control-plane/user/login";
        for (const user of [undefined, "rogue", "server"])
          expect(
            (
              await send(browserPath, {
                user,
                headers: {
                  "x-user-id": "alice",
                  "x-ssl-client-s-dn": "CN=alice",
                },
              })
            ).status,
          ).toBe(403);
        expect((await send(browserPath, { user: "alice" })).text).toContain(
          "Войти как alice",
        );
        const invalidOrigins: Record<string, string>[] = [
          {},
          { origin: "https://evil.example" },
        ];
        for (const headers of invalidOrigins)
          expect(
            (
              await send(browserPath, {
                user: "alice",
                method: "POST",
                headers,
              })
            ).status,
          ).toBe(403);
        expect(
          (
            await send(browserPath, {
              user: "alice",
              method: "POST",
              headers: { origin },
              body: { login: "bob" },
            })
          ).status,
        ).toBe(400);
        const adminLogin = await send("/control-plane/login", {
          body: { login: "admin", password: "long-test-only-password" },
        });
        const oldAdmin = cookie(adminLogin, "bb_admin_session").value;
        expect(
          (await send("/api/v1/projects", { headers: { cookie: oldAdmin } }))
            .status,
        ).toBe(200);
        const webLogin = await send(browserPath, {
          user: "alice",
          method: "POST",
          headers: {
            origin,
            cookie: oldAdmin,
            authorization: "Bearer invalid",
          },
        });
        expect(webLogin.status).toBe(303);
        expect(webLogin.headers.location).toBe("/control-plane/user");
        expect(webLogin.headers["clear-site-data"]).toBe('"cache", "storage"');
        const aliceCookie = cookie(webLogin, "bb_user_session");
        for (const attribute of [
          "HttpOnly",
          "Secure",
          "SameSite=Strict",
          "Max-Age=86400",
          "Path=/",
        ])
          expect(aliceCookie.attributes).toContain(attribute);
        expect(webLogin.text).not.toContain("agt_");
        expect(
          (
            await send("/control-plane/user", {
              headers: { cookie: aliceCookie.value },
            })
          ).text,
        ).toContain('"login":"alice"');
        for (const cookie of [
          oldAdmin,
          aliceCookie.value,
          oldAdmin + "; " + aliceCookie.value,
        ])
          expect(
            (await send("/api/v1/projects", { headers: { cookie } })).status,
          ).toBe(401);
        expect(
          (
            await send("/control-plane/user", {
              headers: {
                cookie: aliceCookie.value,
                authorization: "Bearer invalid",
              },
            })
          ).status,
        ).toBe(401);
        expect(
          (
            await send("/control-plane/user/logout", {
              method: "POST",
              headers: { cookie: aliceCookie.value },
            })
          ).status,
        ).toBe(403);
        const bobLogin = await send(browserPath, {
          user: "bob",
          method: "POST",
          headers: { origin, cookie: aliceCookie.value },
        });
        const bobCookie = cookie(bobLogin, "bb_user_session").value;
        expect(
          (
            await send("/control-plane/user", {
              headers: { cookie: aliceCookie.value },
            })
          ).status,
        ).toBe(401);
        expect(
          (
            await send("/control-plane/user", {
              headers: { cookie: bobCookie },
            })
          ).text,
        ).toContain('"login":"bob"');
        const administrator = await send("/control-plane/login", {
          body: { login: "admin", password: "long-test-only-password" },
          headers: { cookie: bobCookie },
        });
        expect(administrator.status).toBe(200);
        expect(
          (
            await send("/control-plane/user", {
              headers: { cookie: bobCookie },
            })
          ).status,
        ).toBe(401);
        expect(
          (
            await send("/api/v1/projects", {
              headers: {
                cookie: cookie(administrator, "bb_admin_session").value,
              },
            })
          ).status,
        ).toBe(200);
        const logoutCookie = cookie(
          await send(browserPath, {
            user: "alice",
            method: "POST",
            headers: { origin },
          }),
          "bb_user_session",
        ).value;
        const loggedOut = await send("/control-plane/user/logout", {
          method: "POST",
          headers: { origin, cookie: logoutCookie },
        });
        expect(loggedOut.status).toBe(200);
        expect(loggedOut.headers["clear-site-data"]).toBe('"cache", "storage"');
        expect(
          (
            await send("/control-plane/user", {
              headers: { cookie: logoutCookie },
            })
          ).status,
        ).toBe(401);
        const expiringCookie = cookie(
          await send(browserPath, {
            user: "alice",
            method: "POST",
            headers: { origin },
          }),
          "bb_user_session",
        ).value;
        db.update(controlPlaneUsers)
          .set({ enabled: false })
          .where(eq(controlPlaneUsers.login, "alice"))
          .run();
        expect(
          (
            await send(browserPath, {
              user: "alice",
              method: "POST",
              headers: { origin },
            })
          ).status,
        ).toBe(403);

        expect((await send("/control-plane/user", { headers })).status).toBe(
          401,
        );
        db.update(controlPlaneUsers)
          .set({ enabled: true })
          .where(eq(controlPlaneUsers.login, "alice"))
          .run();
        expect(
          (
            await send(browserPath, {
              user: "alice",
              method: "POST",
              headers: { origin },
            })
          ).status,
        ).toBe(303);
        now = issued.expiresAt;
        expect(
          (
            await send("/control-plane/user", {
              headers: { cookie: expiringCookie },
            })
          ).status,
        ).toBe(401);
        expect((await send("/control-plane/user", { headers })).status).toBe(
          401,
        );
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          if ("closeAllConnections" in server) server.closeAllConnections();
        });
      }
    } finally {
      db.$client.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20000);
});
