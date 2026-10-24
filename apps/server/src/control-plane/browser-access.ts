import { createHash, randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import type { ControlPlaneRegistry } from "@bb/db";

const cookieName = "bb_user_session";
const lifetimeMs = 24 * 60 * 60 * 1000;
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function controlPlaneBrowserToken(context: Context): string | null {
  const token = getCookie(context, cookieName);
  return token && /^agt_[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function createControlPlaneBrowserAccess({
  registry,
  publicOrigin,
  now,
  certificateLogin,
}: {
  registry: ControlPlaneRegistry;
  publicOrigin: string;
  now: () => number;
  certificateLogin: (context: Context) => string | null;
}) {
  const secure = publicOrigin.startsWith("https:");
  function clear(context: Context) {
    const token = controlPlaneBrowserToken(context);
    if (token) registry.revoke(digest(token));
    deleteCookie(context, cookieName, {
      path: "/",
      secure,
      sameSite: "Strict",
    });
    context.header("clear-site-data", '"cache", "storage"');
  }
  return {
    clear,
    usesCookie: (context: Context) =>
      context.req.header("authorization") === undefined &&
      controlPlaneBrowserToken(context) !== null,
    install(app: Hono, signOutAdministrator: (context: Context) => void) {
      const path = "/control-plane/user/login";
      app.use(path, bodyLimit({ maxSize: 1024 }));
      app.get(path, (context) => {
        const login = certificateLogin(context);
        if (!login)
          return context.html(
            '<!doctype html><html lang="ru"><meta charset="utf-8"><title>BB</title><p>Для входа нужен пользовательский сертификат.</p><a href="/control-plane/login">Вход администратора</a></html>',
            403,
          );
        return context.html(
          `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BB</title><main><h1>Вход в BB</h1><form method="post" action="${path}"><button type="submit">Войти как ${escapeHtml(login)}</button></form><a href="/control-plane/login">Вход администратора</a></main></html>`,
        );
      });
      app.post(path, async (context) => {
        if (context.req.header("origin") !== publicOrigin)
          return context.json({ error: "forbidden_origin" }, 403);
        const login = certificateLogin(context);
        if (!login) return context.json({ error: "certificate_required" }, 403);
        if ((await context.req.text()).length !== 0)
          return context.json({ error: "invalid_request" }, 400);
        const user = registry.reserve(login, now());
        const token = `agt_${randomBytes(32).toString("base64url")}`;
        const old = controlPlaneBrowserToken(context);
        if (
          !registry.createSession(
            user.id,
            digest(token),
            now() + lifetimeMs,
            now(),
            old ? digest(old) : null,
          )
        )
          return context.json({ error: "authorization_unavailable" }, 403);
        signOutAdministrator(context);
        setCookie(context, cookieName, token, {
          httpOnly: true,
          secure,
          sameSite: "Strict",
          path: "/",
          maxAge: lifetimeMs / 1000,
        });
        context.header("clear-site-data", '"cache", "storage"');
        return context.redirect("/control-plane/user", 303);
      });
    },
  };
}
