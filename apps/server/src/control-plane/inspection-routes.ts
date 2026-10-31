import type { Context, Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { controlPlaneDiagnosticGrantInputSchema } from "@bb/domain";
import {
  controlPlaneTimelinePageSchema,
  controlPlaneTimelineDetailsSchema,
} from "@bb/server-contract";
import {
  controlPlaneProjects,
  controlPlaneUsers,
  getControlPlaneDiagnosticGrant,
  listControlPlaneDiagnosticGrants,
  setControlPlaneDiagnosticGrant,
  type DbConnection,
} from "@bb/db";
import { ApiError } from "../errors.js";
import {
  currentControlPlanePrincipal,
  hasActiveControlPlaneAdministrativeRequest,
} from "./access.js";
import { controlPlaneBodyLimit, readControlPlaneJson } from "./request-body.js";
import type { ControlPlaneInspectionService } from "./inspections.js";
import type { InspectionActor } from "./inspection-policy.js";

export function isControlPlaneInspectionPath(path: string, method: string) {
  return (
    method === "GET" &&
    (path === "/control-plane/user/inspections" ||
      /^\/control-plane\/user\/inspections\/(?:workflows\/[^/]+\/(?:inspection|result|trace|calls\/[^/]+|threads\/[^/]+(?:\/(?:events|stream|timeline|timeline-details|result))?)|threads\/[^/]+(?:\/(?:events|stream|timeline|timeline-details|result))?)$/u.test(
        path,
      ))
  );
}
const page = z
  .object({
    projectId: z.string().min(1).max(200),
    cursor: z.string().max(256).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
const tracePage = z
  .object({
    attemptId: z.string().uuid().optional(),
    after: z.coerce.number().int().min(-1).default(-1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
const historyPage = z
  .object({
    after: z.coerce.number().int().min(-1).default(-1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
const eventPage = z
  .object({
    after: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
function query<T>(schema: z.ZodType<T>, c: Context) {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success)
    throw new ApiError(400, "invalid_request", "Invalid inspection query");
  return parsed.data;
}
export function installControlPlaneInspectionRoutes(
  app: Hono,
  service: ControlPlaneInspectionService,
  authenticate: (c: Context) => { user: { id: string } } | null,
  administrator: (c: Context) => string | null,
) {
  for (const mode of ["user", "admin"] as const) {
    const base = `/control-plane/${mode}/inspections`;
    function actor(c: Context): InspectionActor {
      if (mode === "user") {
        const identity = authenticate(c);
        if (!identity)
          throw new ApiError(
            401,
            "authentication_required",
            "Authentication required",
          );
        return {
          kind: "user",
          userId: identity.user.id,
          authorized: () => authenticate(c)?.user.id === identity.user.id,
        };
      }
      const login = administrator(c);
      if (!login || !hasActiveControlPlaneAdministrativeRequest())
        throw new ApiError(
          403,
          "administrator_required",
          "Administrator required",
        );
      return {
        kind: "admin",
        login,
        authorized: () => administrator(c) === login,
      };
    }
    function reader(c: Context) {
      c.header("cache-control", "no-store");
      return service.forActor(actor(c));
    }
    app.get(base, async (c) => {
      const p = query(page, c);
      return c.json(
        await reader(c).list(p.projectId, p.cursor ?? null, p.limit),
      );
    });
    app.get(`${base}/workflows/:runId/inspection`, async (c) => {
      const p = query(historyPage, c);
      return c.json(
        await reader(c).workflows.inspect(
          c.req.param("runId"),
          p.after,
          p.limit,
        ),
      );
    });
    app.get(`${base}/workflows/:runId/result`, async (c) => {
      query(z.object({}).strict(), c);
      return c.json(await reader(c).workflows.result(c.req.param("runId")));
    });
    app.get(`${base}/workflows/:runId/trace`, async (c) => {
      const p = query(tracePage, c);
      return c.json(
        await reader(c).workflows.trace(
          c.req.param("runId"),
          p.attemptId ?? null,
          p.after,
          p.limit,
        ),
      );
    });
    app.get(`${base}/workflows/:runId/calls/:callId`, async (c) => {
      query(z.object({}).strict(), c);
      return c.json(
        await reader(c).workflows.call(
          c.req.param("runId"),
          c.req.param("callId"),
        ),
      );
    });
    for (const nested of [false, true]) {
      const threadBase = nested
        ? `${base}/workflows/:runId/threads/:threadId`
        : `${base}/threads/:threadId`;
      for (const action of [
        "",
        "events",
        "stream",
        "timeline",
        "timeline-details",
        "result",
      ] as const)
        app.get(`${threadBase}${action ? `/${action}` : ""}`, (c) => {
          const id = c.req.param("threadId") ?? "";
          const source = reader(c).threads(
            nested ? (c.req.param("runId") ?? "") : null,
            nested ? null : id,
          );
          if (action === "events") {
            const p = query(eventPage, c);
            return c.json(source.events(id, p.after, p.limit));
          }
          if (action === "stream") {
            const p = query(
              z
                .object({
                  after: z.coerce.number().int().nonnegative().default(0),
                })
                .strict(),
              c,
            );
            return source.stream(id, p.after, c.req.raw.signal);
          }
          if (action === "timeline") {
            const p = query(controlPlaneTimelinePageSchema, c);
            return c.json(
              p.beforeAnchorId === undefined || p.beforeAnchorSeq === undefined
                ? source.timeline(id)
                : source.olderTimeline(id, {
                    anchorId: p.beforeAnchorId,
                    anchorSeq: p.beforeAnchorSeq,
                  }),
            );
          }
          if (action === "timeline-details")
            return c.json(
              source.details(id, query(controlPlaneTimelineDetailsSchema, c)),
            );
          query(z.object({}).strict(), c);
          return c.json(
            action === "result" ? source.result(id) : source.get(id),
          );
        });
    }
  }
}
export function installControlPlaneDiagnosticGrantRoutes(
  app: Hono,
  db: DbConnection,
) {
  const base = "/control-plane/admin/projects/:projectId/diagnostics";
  app.use(`${base}/*`, controlPlaneBodyLimit(4096));
  function admin() {
    const principal = currentControlPlanePrincipal();
    if (
      !hasActiveControlPlaneAdministrativeRequest() ||
      principal?.kind !== "admin"
    )
      throw new ApiError(
        403,
        "administrator_required",
        "Administrator required",
      );
    return principal.login;
  }
  function target(projectId: string, userId?: string) {
    if (
      !db
        .select({ id: controlPlaneProjects.projectId })
        .from(controlPlaneProjects)
        .where(eq(controlPlaneProjects.projectId, projectId))
        .get()
    )
      throw new ApiError(404, "project_not_found", "Project not found");
    if (
      userId !== undefined &&
      (!z.string().uuid().safeParse(userId).success ||
        !db
          .select({ id: controlPlaneUsers.id })
          .from(controlPlaneUsers)
          .where(eq(controlPlaneUsers.id, userId))
          .get())
    )
      throw new ApiError(404, "user_not_found", "User not found");
  }
  app.get(base, (c) => {
    admin();
    const projectId = c.req.param("projectId");
    target(projectId);
    const p = query(
      z
        .object({
          cursor: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .strict(),
      c,
    );
    const rows = listControlPlaneDiagnosticGrants(
      db,
      projectId,
      p.cursor ?? null,
      p.limit + 1,
    );
    const grants = rows.slice(0, p.limit);
    return c.json({
      grants,
      nextCursor:
        rows.length > p.limit ? (grants.at(-1)?.userId ?? null) : null,
    });
  });
  app.get(`${base}/:userId`, (c) => {
    admin();
    query(z.object({}).strict(), c);
    const projectId = c.req.param("projectId"),
      userId = c.req.param("userId");
    target(projectId, userId);
    const grant = getControlPlaneDiagnosticGrant(db, projectId, userId);
    const login = db
      .select({ login: controlPlaneUsers.login })
      .from(controlPlaneUsers)
      .where(eq(controlPlaneUsers.id, userId))
      .get()?.login;
    return c.json({ grant: grant ? { ...grant, login } : null });
  });
  app.put(`${base}/:userId`, async (c) => {
    const updatedBy = admin();
    query(z.object({}).strict(), c);
    const projectId = c.req.param("projectId"),
      userId = c.req.param("userId");
    target(projectId, userId);
    const body = controlPlaneDiagnosticGrantInputSchema.safeParse(
      await readControlPlaneJson(c),
    );
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    if (
      !setControlPlaneDiagnosticGrant(db, {
        projectId,
        userId,
        ...body.data,
        updatedBy,
      })
    )
      return c.json({ error: "diagnostic_revision_conflict" }, 409);
    return c.json({ ok: true });
  });
}
