import { dispatchControlPlaneDispatchRead } from "./sdk-dispatch-read.js";
import { dispatchControlPlaneEnvironmentRead } from "./sdk-environment-read.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { WebSocket, WebSocketServer } from "ws";
import type { ControlPlaneConfig } from "./config.js";
import { verifyAdminPassword } from "./credentials.js";
import { isUserAuthPath, type ControlPlaneUserAccess } from "./user-access.js";

export type ControlPlanePrincipal =
  | { kind: "admin"; login: string }
  | { kind: "user"; userId: string }
  | { kind: "service" };
const principals = new AsyncLocalStorage<ControlPlanePrincipal>();
const cookieName = "bb_admin_session";
const lifetimeMs = 24 * 60 * 60 * 1000;
const loginSchema = z
  .object({ login: z.string().max(100), password: z.string().max(1024) })
  .strict();

export function currentControlPlanePrincipal(): ControlPlanePrincipal | null {
  return principals.getStore() ?? null;
}

export function assertServiceRealtimePrincipal(): void {
  if (currentControlPlanePrincipal()?.kind === "user")
    throw new Error("User realtime requires a scoped transport");
}

export function withControlPlaneUser<T>(userId: string, run: () => T): T {
  return principals.run({ kind: "user", userId }, run);
}

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function loginPage(): string {
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BB administration</title><body><main><h1>BB administration</h1><form method="post" action="/control-plane/login"><p><label>Login <input name="login" autocomplete="username" required maxlength="100"></label></p><p><label>Password <input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label></p><button type="submit">Sign in</button></form></main></body></html>';
}

export function createControlPlaneAccess(
  config: ControlPlaneConfig,
  now = Date.now,
  users?: ControlPlaneUserAccess,
) {
  const sessions = new Map<string, { login: string; expiresAt: number }>();
  const failures = new Map<string, { count: number; until: number }>();
  const trustedRequests = new WeakMap<Request, ControlPlanePrincipal>();
  const sockets = new Map<WebSocket, string>();
  let verifying = 0;
  const secure = config.publicOrigin.startsWith("https:");
  const revoke = (key: string) => {
    sessions.delete(key);
    for (const [socket, socketKey] of sockets) {
      if (socketKey === key) socket.close(4401, "Authentication required");
    }
  };
  const session = (context: Context) => {
    const authorization = context.req.header("authorization");
    const token =
      authorization !== undefined
        ? authorization.startsWith("Bearer ")
          ? authorization.slice(7)
          : undefined
        : getCookie(context, cookieName);
    if (!token) return null;
    const key = tokenKey(token),
      value = sessions.get(key);
    if (!value) return null;
    if (value.expiresAt <= now()) {
      revoke(key);
      return null;
    }
    return { ...value, key };
  };
  const safeOrigin = (context: Context) =>
    context.req.header("origin") === config.publicOrigin;
  const denied = (context: Context) =>
    context.json({ error: "authentication_required" }, 401);

  return {
    get publicOrigin() {
      return config.publicOrigin;
    },
    install(app: Hono) {
      app.use("*", async (context, next) => {
        const trusted = trustedRequests.get(context.req.raw);
        if (trusted) {
          trustedRequests.delete(context.req.raw);
          return principals.run(trusted, next);
        }
        const path = context.req.path;
        let decodedPath: string;
        try {
          decodedPath =
            decodeURIComponent(path)
              .replace(/\/{2,}/gu, "/")
              .replace(/\/$/u, "") || "/";
        } catch {
          return context.json({ error: "invalid_path" }, 400);
        }
        if (
          decodedPath !== path &&
          (path.startsWith("/internal/") ||
            decodedPath.startsWith("/internal/"))
        )
          return context.json({ error: "noncanonical_path" }, 400);
        if (
          path === "/health" &&
          ["GET", "HEAD"].includes(context.req.method) &&
          !session(context)
        )
          return context.json({ ok: true });
        if (
          path === "/control-plane/login" &&
          ["GET", "POST"].includes(context.req.method)
        )
          return next();
        if (users && isUserAuthPath(path, context.req.method)) {
          const origin = context.req.header("origin");
          if (origin !== undefined && !safeOrigin(context))
            return context.json({ error: "forbidden_origin" }, 403);
          return next();
        }
        if (
          path.startsWith("/internal/") &&
          path !== "/internal/hosts/enroll-key"
        )
          return next();
        const value = session(context);
        if (!value) {
          if (
            context.req.method === "GET" &&
            context.req.header("accept")?.includes("text/html") &&
            !path.startsWith("/api/") &&
            !path.startsWith("/ws")
          ) {
            return context.redirect("/control-plane/login", 303);
          }
          return denied(context);
        }
        const origin = context.req.header("origin");
        const bearer = context.req.header("authorization") !== undefined;
        if (
          (origin !== undefined && !safeOrigin(context)) ||
          (!bearer &&
            (!["GET", "HEAD", "OPTIONS"].includes(context.req.method) ||
              context.req.header("upgrade")?.toLowerCase() === "websocket") &&
            !safeOrigin(context))
        ) {
          return context.json({ error: "forbidden_origin" }, 403);
        }
        return principals.run({ kind: "admin", login: value.login }, next);
      });

      app.use("/control-plane/*", async (context, next) => {
        context.header("cache-control", "no-store");
        context.header("x-content-type-options", "nosniff");
        context.header(
          "content-security-policy",
          "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        );
        return next();
      });
      app.get("/control-plane/login", (context) =>
        session(context)
          ? context.redirect("/", 303)
          : context.html(loginPage()),
      );
      app.post(
        "/control-plane/login",
        bodyLimit({ maxSize: 8192 }),
        async (context) => {
          const json =
            context.req.header("content-type")?.split(";")[0] ===
            "application/json";
          const origin = context.req.header("origin");
          if ((!json || origin !== undefined) && !safeOrigin(context))
            return context.json({ error: "forbidden_origin" }, 403);
          let address = "unknown";
          try {
            address = getConnInfo(context).remote.address ?? "unknown";
          } catch {}
          for (const [key, value] of failures)
            if (value.until <= now()) failures.delete(key);
          const previous = failures.get(address);
          if (
            (previous?.count ?? 0) >= 5 ||
            verifying >= 2 ||
            (!previous && failures.size >= 1024)
          ) {
            context.header("retry-after", "60");
            return context.json({ error: "try_again_later" }, 429);
          }
          const parsed = loginSchema.safeParse(
            await (json ? context.req.json() : context.req.parseBody()).catch(
              () => null,
            ),
          );
          if (!parsed.success)
            return context.json({ error: "invalid_login" }, 400);
          verifying++;
          let valid: boolean;
          try {
            valid = await verifyAdminPassword(
              parsed.data.password,
              config.admin.passwordHash,
            );
          } finally {
            verifying--;
          }
          if (!valid || parsed.data.login !== config.admin.login) {
            failures.set(address, {
              count: (previous?.count ?? 0) + 1,
              until: now() + 60000,
            });
            return context.json({ error: "invalid_credentials" }, 401);
          }
          failures.delete(address);
          for (const [key, value] of sessions)
            if (value.expiresAt <= now()) sessions.delete(key);
          if (sessions.size >= 100)
            return context.json({ error: "session_limit" }, 429);
          const old = session(context);
          if (old) revoke(old.key);
          const token = randomBytes(32).toString("base64url"),
            expiresAt = now() + lifetimeMs;
          sessions.set(tokenKey(token), {
            login: config.admin.login,
            expiresAt,
          });
          setCookie(context, cookieName, token, {
            httpOnly: true,
            secure,
            sameSite: "Strict",
            path: "/",
            maxAge: lifetimeMs / 1000,
          });
          return json
            ? context.json({ token, expiresAt, role: "admin" })
            : context.redirect("/", 303);
        },
      );
      app.get("/control-plane/session", (context) =>
        context.json({ role: "admin", login: session(context)?.login ?? null }),
      );
      app.get("/control-plane/logout", (context) =>
        context.html(
          '<!doctype html><html lang="en"><meta charset="utf-8"><title>BB sign out</title><form method="post" action="/control-plane/logout"><button type="submit">Sign out of BB administration</button></form></html>',
        ),
      );
      app.post("/control-plane/logout", (context) => {
        const value = session(context);
        if (value) revoke(value.key);
        deleteCookie(context, cookieName, {
          path: "/",
          secure,
          sameSite: "Strict",
        });
        return context.req.header("accept")?.includes("text/html")
          ? context.redirect("/control-plane/login", 303)
          : context.json({ ok: true });
      });
      users?.install(app);
    },
    attachSockets(server: WebSocketServer) {
      server.on("connection", (socket, request) => {
        if (request.url?.startsWith("/internal/")) return;
        const authorization = request.headers.authorization;
        const token =
          authorization !== undefined
            ? authorization.startsWith("Bearer ")
              ? authorization.slice(7)
              : null
            : request.headers.cookie
                ?.split(";")
                .map((value) => value.trim())
                .find((value) => value.startsWith(`${cookieName}=`))
                ?.slice(cookieName.length + 1);
        const key = token ? tokenKey(token) : null;
        const value = key ? sessions.get(key) : null;
        if (!key || !value || value.expiresAt <= now()) {
          socket.close(4401, "Authentication required");
          return;
        }
        sockets.set(socket, key);
        socket.once("close", () => sockets.delete(socket));
      });
      const timer = setInterval(() => {
        for (const key of new Set(sockets.values())) {
          const value = sessions.get(key);
          if (!value || value.expiresAt <= now()) revoke(key);
        }
      }, 1000);
      timer.unref();
      server.once("close", () => {
        clearInterval(timer);
        sockets.clear();
      });
    },
    async dispatch(
      app: Hono,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (!path.startsWith("/api/v1/"))
        throw new Error("Internal SDK must use the BB API");
      const principal = currentControlPlanePrincipal();
      if (principal?.kind === "user") {
        const response =
          dispatchControlPlaneDispatchRead(principal.userId, request) ??
          dispatchControlPlaneEnvironmentRead(principal.userId, request);
        if (response) return response;
        throw new Error("User SDK operations require scoped authorization");
      }
      trustedRequests.set(
        request,
        currentControlPlanePrincipal() ?? { kind: "service" },
      );
      try {
        return await app.fetch(request);
      } finally {
        trustedRequests.delete(request);
      }
    },
  };
}

export type ControlPlaneAccess = ReturnType<typeof createControlPlaneAccess>;
