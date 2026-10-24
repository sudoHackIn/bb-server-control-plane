import { createHash, randomBytes, randomUUID } from "node:crypto";
import { IncomingMessage } from "node:http";
import { TLSSocket } from "node:tls";
import { ControlPlaneRegistry } from "@bb/db";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

const loginSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u);
const startSchema = z
  .object({
    clientName: z.string().trim().min(1).max(80),
    challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .strict();
const exchangeSchema = z
  .object({
    flowId: z.string().uuid(),
    verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/u),
  })
  .strict();
const decisionSchema = z
  .object({
    csrf: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    decision: z.enum(["approve", "deny"]),
  })
  .strict();
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export function certificateLogin(context: Context): string | null {
  const bindings: unknown = context.env;
  if (
    !bindings ||
    typeof bindings !== "object" ||
    !("incoming" in bindings) ||
    !(bindings.incoming instanceof IncomingMessage)
  )
    return null;
  const socket = bindings.incoming.socket;
  if (!(socket instanceof TLSSocket) || !socket.authorized) return null;
  const parsed = loginSchema.safeParse(socket.getPeerCertificate().subject?.CN);
  return parsed.success ? parsed.data : null;
}

export function isUserAuthPath(path: string, method: string): boolean {
  if (path === "/control-plane/user") return method === "GET";
  if (
    [
      "/control-plane/auth/start",
      "/control-plane/auth/exchange",
      "/control-plane/user/logout",
    ].includes(path)
  )
    return method === "POST";
  return (
    ["GET", "POST"].includes(method) &&
    /^\/control-plane\/auth\/authorize\/[0-9a-f-]{36}$/u.test(path)
  );
}

export function createControlPlaneUserAccess(
  registry: ControlPlaneRegistry,
  publicOrigin: string,
  now = Date.now,
) {
  const authenticate = (context: Context) => {
    const authorization = context.req.header("authorization");
    if (
      !authorization ||
      !/^Bearer agt_[A-Za-z0-9_-]{43}$/u.test(authorization)
    )
      return null;
    const token = authorization.slice(7);
    const value = registry.authenticate(digest(token), now());
    return value ? { ...value, digest: digest(token) } : null;
  };
  return {
    authenticate,
    install(app: Hono) {
      app.use("/control-plane/auth/*", bodyLimit({ maxSize: 4096 }));
      app.post("/control-plane/auth/start", async (context) => {
        const parsed = startSchema.safeParse(
          await context.req.json().catch(() => null),
        );
        if (!parsed.success)
          return context.json({ error: "invalid_request" }, 400);
        const origin = context.req.header("origin");
        if (origin !== undefined && origin !== publicOrigin)
          return context.json({ error: "forbidden_origin" }, 403);
        const id = randomUUID(),
          expiresAt = now() + 10 * 60 * 1000;
        if (
          !registry.createFlow(
            { id, ...parsed.data, status: "pending", expiresAt },
            now(),
          )
        )
          return context.json({ error: "flow_limit" }, 429);
        return context.json({
          flowId: id,
          authorizationUrl: `${publicOrigin}/control-plane/auth/authorize/${id}`,
          expiresAt,
          pollIntervalMs: 1500,
        });
      });
      app.get("/control-plane/auth/authorize/:id", (context) => {
        const login = certificateLogin(context);
        if (!login)
          return context.json({ error: "client_certificate_required" }, 401);
        const flow = registry.flow(context.req.param("id"));
        if (!flow || flow.expiresAt <= now())
          return context.json({ error: "flow_not_found" }, 404);
        const csrf = random();
        if (!registry.approval(flow.id, login, digest(csrf), now()))
          return context.json({ error: "flow_already_handled" }, 409);
        return context.html(
          `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Подключение к BB</title><main><h1>Подключение к BB</h1><p>Клиент: ${escapeHtml(flow.clientName)}</p><p>Пользователь сертификата: ${escapeHtml(login)}</p><p>Подтверждайте только подключение, которое начали сами.</p><form method="post"><input type="hidden" name="csrf" value="${csrf}"><button name="decision" value="approve">Подключить</button><button name="decision" value="deny">Отказать</button></form></main></html>`,
        );
      });
      app.post("/control-plane/auth/authorize/:id", async (context) => {
        const login = certificateLogin(context);
        if (!login)
          return context.json({ error: "client_certificate_required" }, 401);
        if (context.req.header("origin") !== publicOrigin)
          return context.json({ error: "forbidden_origin" }, 403);
        const parsed = decisionSchema.safeParse(
          await context.req.parseBody().catch(() => null),
        );
        if (!parsed.success)
          return context.json({ error: "invalid_request" }, 400);
        const flow = registry.flow(context.req.param("id"));
        if (!flow || flow.expiresAt <= now())
          return context.json({ error: "flow_not_found" }, 404);
        if (
          flow.status !== "pending" ||
          flow.approvalLogin !== login ||
          flow.csrfHash !== digest(parsed.data.csrf)
        )
          return context.json({ error: "invalid_approval" }, 403);
        const user =
          parsed.data.decision === "approve"
            ? registry.reserve(login, now())
            : null;
        if (user && !user.enabled)
          return context.json({ error: "user_disabled" }, 403);
        if (
          !registry.decide(
            flow.id,
            login,
            digest(parsed.data.csrf),
            user?.id ?? null,
            now(),
          )
        )
          return context.json({ error: "flow_already_handled" }, 409);
        return context.html(
          '<!doctype html><html lang="ru"><meta charset="utf-8"><title>BB</title><p>Запрос обработан. Вернитесь в клиент BB.</p></html>',
        );
      });
      app.post("/control-plane/auth/exchange", async (context) => {
        const parsed = exchangeSchema.safeParse(
          await context.req.json().catch(() => null),
        );
        if (!parsed.success)
          return context.json({ error: "invalid_request" }, 400);
        const flow = registry.flow(parsed.data.flowId);
        if (!flow || flow.expiresAt <= now())
          return context.json({ error: "flow_not_found" }, 404);
        if (
          createHash("sha256")
            .update(parsed.data.verifier)
            .digest("base64url") !== flow.challenge
        )
          return context.json({ error: "invalid_verifier" }, 403);
        if (flow.status === "pending")
          return context.json({ status: "pending" });
        if (flow.status === "denied")
          return context.json({ error: "authorization_denied" }, 403);
        if (flow.status !== "approved" || !flow.userId)
          return context.json({ error: "flow_already_handled" }, 409);
        const token = `agt_${random()}`,
          expiresAt = now() + 24 * 60 * 60 * 1000;
        if (
          !registry.consume(
            flow.id,
            flow.userId,
            digest(token),
            expiresAt,
            now(),
          )
        )
          return context.json({ error: "authorization_unavailable" }, 409);
        return context.json({
          status: "authorized",
          accessToken: token,
          tokenType: "Bearer",
          expiresAt,
        });
      });
      app.get("/control-plane/user", (context) => {
        const value = authenticate(context);
        if (!value)
          return context.json({ error: "authentication_required" }, 401);
        return context.json({
          role: "user",
          user: {
            id: value.user.id,
            login: value.user.login,
            environmentStatus: value.user.environmentStatus,
          },
          expiresAt: value.expiresAt,
        });
      });
      app.post("/control-plane/user/logout", (context) => {
        const value = authenticate(context);
        if (!value)
          return context.json({ error: "authentication_required" }, 401);
        registry.revoke(value.digest);
        return context.json({ ok: true });
      });
    },
  };
}

export type ControlPlaneUserAccess = ReturnType<
  typeof createControlPlaneUserAccess
>;
