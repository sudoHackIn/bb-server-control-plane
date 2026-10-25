import {
  installControlPlaneDefinitionRoutes,
  isControlPlaneDefinitionPath,
} from "./definition-routes.js";
import {
  controlPlaneBodyLimit,
  readControlPlaneJson,
  readControlPlaneForm,
  hasControlPlaneEmptyBody,
} from "./request-body.js";
import {
  installControlPlaneWorkflowRoutes,
  isControlPlaneWorkflowPath,
} from "./workflow-routes.js";
import type { ControlPlaneWorkflowService } from "./workflows.js";
import {
  createControlPlaneBrowserAccess,
  controlPlaneBrowserToken,
} from "./browser-access.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { IncomingMessage } from "node:http";
import { TLSSocket } from "node:tls";
import {
  ControlPlaneRegistry,
  ControlPlaneProjectError,
  getControlPlaneProject,
  listControlPlaneProjects,
  listControlPlaneProfiles,
} from "@bb/db";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { createControlPlaneProvisioner } from "./provisioning.js";
import type { ControlPlaneProjectService } from "./projects.js";
import {
  isControlPlaneThreadPath,
  installControlPlaneThreadRoutes,
} from "./thread-routes.js";
import type { ControlPlaneThreadService } from "./threads.js";
import { installControlPlaneProfileRoutes } from "./profile-routes.js";

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
  if (
    isControlPlaneThreadPath(path, method) ||
    isControlPlaneDefinitionPath(path, method) ||
    isControlPlaneWorkflowPath(path, method)
  )
    return true;
  if (
    /^\/control-plane\/user\/profiles(?:\/[^/]+(?:\/versions(?:\/[^/]+)?)?)?$/u.test(
      path,
    )
  )
    return method === "GET";
  if (path === "/control-plane/user/projects")
    return ["GET", "POST"].includes(method);
  if (/^\/control-plane\/user\/projects\/[^/]+$/u.test(path))
    return method === "GET";
  if (path === "/control-plane/user/environment")
    return ["GET", "POST"].includes(method);
  if (path === "/control-plane/user/login")
    return ["GET", "POST"].includes(method);
  if (["/control-plane/user", "/control-plane/user/bootstrap"].includes(path))
    return method === "GET";
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
  projects?: ControlPlaneProjectService,
  threads?: ControlPlaneThreadService,
  workflows?: ControlPlaneWorkflowService,
) {
  const provision = createControlPlaneProvisioner(registry);
  const authenticate = (context: Context) => {
    const authorization = context.req.header("authorization");
    const token =
      authorization === undefined
        ? controlPlaneBrowserToken(context)
        : /^Bearer agt_[A-Za-z0-9_-]{43}$/u.test(authorization)
          ? authorization.slice(7)
          : null;
    if (!token) return null;
    const value = registry.authenticate(digest(token), now());
    return value ? { ...value, digest: digest(token) } : null;
  };
  const browser = createControlPlaneBrowserAccess({
    registry,
    publicOrigin,
    now,
    certificateLogin,
  });
  return {
    usesBrowserCredential: browser.usesCookie,
    clearBrowserSession: browser.clear,
    close: () => threads?.close(),
    authenticate,
    install(
      app: Hono,
      signOutAdministrator: (context: Context) => void = () => {},
    ) {
      browser.install(app, signOutAdministrator);
      installControlPlaneProfileRoutes(app, registry.db, authenticate);
      if (threads) installControlPlaneThreadRoutes(app, threads, authenticate);
      if (workflows) {
        installControlPlaneWorkflowRoutes(app, workflows, authenticate);
        installControlPlaneDefinitionRoutes(
          app,
          workflows.definitions,
          authenticate,
        );
      }
      const projectResponse = (
        row: NonNullable<ReturnType<typeof getControlPlaneProject>>,
        userId: string,
      ) => ({
        projectId: row.projectId,
        name: row.name,
        slug: row.slug,
        hostId: row.hostId,
        cwd: row.cwd,
        role: row.role,
        canRun:
          row.ownerUserId === userId && ["owner", "runner"].includes(row.role),
        canManage: row.ownerUserId === userId && row.role === "owner",
      });
      app.get("/control-plane/user/bootstrap", (context) => {
        const identity = authenticate(context);
        if (!identity)
          return context.json({ error: "authentication_required" }, 401);
        if (Object.keys(context.req.query()).length)
          return context.json({ error: "invalid_request" }, 400);
        if (!threads)
          return context.json({ error: "execution_unavailable" }, 503);
        const page = { cursor: null, limit: 50 };
        const projects = listControlPlaneProjects(
          registry.db,
          identity.user.id,
          page,
        );
        return context.json({
          session: {
            role: "user",
            user: {
              id: identity.user.id,
              login: identity.user.login,
              environmentStatus: identity.user.environmentStatus,
            },
            expiresAt: identity.expiresAt,
          },
          projects: {
            projects: projects.projects.map((row) =>
              projectResponse(row, identity.user.id),
            ),
            nextCursor: projects.nextCursor,
          },
          threads: threads.list(identity.user.id, page),
          profiles: listControlPlaneProfiles(
            registry.db,
            identity.user.id,
            page,
          ),
          capabilities: {
            canCreateProjects: identity.user.environmentStatus === "ready",
            canInstallPlugins: false,
            canUseTerminals: false,
          },
        });
      });
      app.use("/control-plane/user/projects", controlPlaneBodyLimit(4096));
      app.get("/control-plane/user/projects", (context) => {
        const value = authenticate(context);
        if (!value)
          return context.json({ error: "authentication_required" }, 401);
        const parsed = z
          .object({
            cursor: z.string().min(1).max(200).optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          })
          .strict()
          .safeParse(context.req.query());
        if (!parsed.success)
          return context.json({ error: "invalid_request" }, 400);
        const result = listControlPlaneProjects(registry.db, value.user.id, {
          cursor: parsed.data.cursor ?? null,
          limit: parsed.data.limit,
        });
        return context.json({
          projects: result.projects.map((row) =>
            projectResponse(row, value.user.id),
          ),
          nextCursor: result.nextCursor,
        });
      });
      app.get("/control-plane/user/projects/:id", (context) => {
        const value = authenticate(context);
        if (!value)
          return context.json({ error: "authentication_required" }, 401);
        const project = getControlPlaneProject(
          registry.db,
          value.user.id,
          context.req.param("id"),
        );
        return project
          ? context.json(projectResponse(project, value.user.id))
          : context.json({ error: "project_not_found" }, 404);
      });
      app.post("/control-plane/user/projects", async (context) => {
        const value = authenticate(context);
        if (!value)
          return context.json({ error: "authentication_required" }, 401);
        const parsed = z
          .object({
            name: z.string().trim().min(1).max(100),
            slug: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/u),
          })
          .strict()
          .safeParse(await readControlPlaneJson(context));
        if (!parsed.success)
          return context.json({ error: "invalid_request" }, 400);
        if (!projects || value.user.environmentStatus !== "ready")
          return context.json({ error: "environment_unavailable" }, 503);
        try {
          const result = await projects.create(value.user, parsed.data);
          const project = getControlPlaneProject(
            registry.db,
            value.user.id,
            result.projectId,
          );
          if (!project)
            return context.json({ error: "project_not_found" }, 404);
          return context.json(
            projectResponse(project, value.user.id),
            result.created ? 201 : 200,
          );
        } catch (error) {
          return error instanceof ControlPlaneProjectError &&
            error.kind === "project_conflict"
            ? context.json({ error: "project_conflict" }, 409)
            : context.json({ error: "project_unavailable" }, 503);
        }
      });
      app.use("/control-plane/user/environment", controlPlaneBodyLimit(1024));
      app.get("/control-plane/user/environment", (context) => {
        const value = authenticate(context);
        if (!value)
          return context.json({ error: "authentication_required" }, 401);
        const user = value.user;
        return context.json({
          userId: user.id,
          uid: user.uid,
          gid: user.gid,
          home: user.home,
          projectsRoot: user.projectsRoot,
          status: user.environmentStatus,
        });
      });
      app.post("/control-plane/user/environment", async (context) => {
        const value = authenticate(context);
        if (!value)
          return context.json({ error: "authentication_required" }, 401);
        const text = await context.req.text();
        let body: unknown = {};
        try {
          if (text) body = JSON.parse(text);
        } catch {
          body = null;
        }
        if (!z.object({}).strict().safeParse(body).success)
          return context.json({ error: "invalid_request" }, 400);
        try {
          const user = await provision(value.user);
          return context.json({
            userId: user.id,
            uid: user.uid,
            gid: user.gid,
            home: user.home,
            projectsRoot: user.projectsRoot,
            status: user.environmentStatus,
          });
        } catch {
          return context.json({ error: "environment_unavailable" }, 503);
        }
      });
      app.use("/control-plane/auth/*", controlPlaneBodyLimit(4096));
      app.post("/control-plane/auth/start", async (context) => {
        const parsed = startSchema.safeParse(
          await readControlPlaneJson(context),
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
          await readControlPlaneForm(context),
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
          await readControlPlaneJson(context),
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
      app.use("/control-plane/user/logout", controlPlaneBodyLimit(1024));
      app.post("/control-plane/user/logout", async (context) => {
        const value = authenticate(context);
        if (!value)
          return context.json({ error: "authentication_required" }, 401);
        if (!(await hasControlPlaneEmptyBody(context)))
          return context.json({ error: "invalid_request" }, 400);
        registry.revoke(value.digest);
        if (browser.usesCookie(context)) {
          browser.clear(context);
          if (context.req.header("accept")?.includes("text/html"))
            return context.redirect("/control-plane/user/login", 303);
        }
        return context.json({ ok: true });
      });
    },
  };
}

export type ControlPlaneUserAccess = ReturnType<
  typeof createControlPlaneUserAccess
>;
