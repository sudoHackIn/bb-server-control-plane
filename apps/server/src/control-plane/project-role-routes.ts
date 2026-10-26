import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, gte, lt, ne } from "drizzle-orm";
import {
  controlPlaneProjectAccess,
  controlPlaneProjectMaintenance,
  controlPlaneUsers,
  getControlPlaneProjectAccessPolicy,
  getControlPlaneProjectMaintenance,
  type DbConnection,
} from "@bb/db";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { LoggedPendingInteractionWorkSessionDeps } from "../types.js";
import { hasActiveControlPlaneAdministrativeRequest } from "./access.js";
import { getControlPlaneNativeProjectMaintenanceCoordinator } from "./native-project-maintenance.js";
import { controlPlaneBodyLimit, readControlPlaneJson } from "./request-body.js";

const roleSchema = z
  .object({
    role: z.enum(["runner", "viewer"]).nullable(),
    expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const userIdSchema = z.string().uuid();
const userDirectoryQuerySchema = z
  .object({
    prefix: z.string().max(100).default(""),
    cursor: z.string().max(256).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

function pendingProjectOperation(db: DbConnection, projectId: string) {
  return db
    .select({ id: controlPlaneProjectMaintenance.id })
    .from(controlPlaneProjectMaintenance)
    .where(
      and(
        eq(controlPlaneProjectMaintenance.projectId, projectId),
        ne(controlPlaneProjectMaintenance.phase, "complete"),
      ),
    )
    .orderBy(asc(controlPlaneProjectMaintenance.updatedAt))
    .get();
}

export function installControlPlaneProjectRoleRoutes(
  app: Hono,
  deps: LoggedPendingInteractionWorkSessionDeps,
) {
  const base = "/control-plane/admin/projects/:projectId/access";
  const authorized = (context: Context) =>
    hasActiveControlPlaneAdministrativeRequest()
      ? null
      : context.json({ error: "administrator_required" }, 403);
  app.get("/control-plane/admin/users", (context) => {
    const denied = authorized(context);
    if (denied) return denied;
    const query = userDirectoryQuerySchema.safeParse(context.req.query());
    if (!query.success) return context.json({ error: "invalid_request" }, 400);
    const { prefix, cursor, limit } = query.data;
    const rows = deps.db
      .select({
        userId: controlPlaneUsers.id,
        login: controlPlaneUsers.login,
        enabled: controlPlaneUsers.enabled,
        environmentStatus: controlPlaneUsers.environmentStatus,
      })
      .from(controlPlaneUsers)
      .where(
        and(
          gte(controlPlaneUsers.login, prefix),
          lt(controlPlaneUsers.login, `${prefix}\uffff`),
          cursor === undefined
            ? undefined
            : gt(controlPlaneUsers.login, cursor),
        ),
      )
      .orderBy(asc(controlPlaneUsers.login))
      .limit(limit + 1)
      .all();
    const users = rows.slice(0, limit);
    return context.json({
      users,
      nextCursor: rows.length > limit ? users.at(-1)?.login : null,
    });
  });
  app.use(`${base}/*`, controlPlaneBodyLimit(4096));
  app.get(base, (context) => {
    const denied = authorized(context);
    if (denied) return denied;
    if (Object.keys(context.req.query()).length)
      return context.json({ error: "invalid_request" }, 400);
    const projectId = context.req.param("projectId");
    const policy = getControlPlaneProjectAccessPolicy(deps.db, projectId);
    if (!policy) return context.json({ error: "project_not_found" }, 404);
    const grants = deps.db
      .select({
        userId: controlPlaneProjectAccess.userId,
        role: controlPlaneProjectAccess.role,
        login: controlPlaneUsers.login,
        enabled: controlPlaneUsers.enabled,
        environmentStatus: controlPlaneUsers.environmentStatus,
      })
      .from(controlPlaneProjectAccess)
      .innerJoin(
        controlPlaneUsers,
        eq(controlPlaneUsers.id, controlPlaneProjectAccess.userId),
      )
      .where(eq(controlPlaneProjectAccess.projectId, projectId))
      .orderBy(asc(controlPlaneUsers.login))
      .all();
    return context.json({
      projectId,
      revision: policy.revision,
      appliedRevision: policy.appliedRevision,
      grants,
      pendingOperationId:
        pendingProjectOperation(deps.db, projectId)?.id ?? null,
    });
  });
  app.get(`${base}/maintenance/:operationId`, (context) => {
    const denied = authorized(context);
    if (denied) return denied;
    if (Object.keys(context.req.query()).length)
      return context.json({ error: "invalid_request" }, 400);
    const operation = getControlPlaneProjectMaintenance(
      deps.db,
      context.req.param("operationId"),
    );
    if (!operation || operation.projectId !== context.req.param("projectId"))
      return context.json({ error: "operation_not_found" }, 404);
    return context.json({
      operationId: operation.id,
      projectId: operation.projectId,
      revision: operation.projectRevision,
      phase: operation.phase,
      participantCount: operation.participants.length,
    });
  });
  app.put(`${base}/:userId`, async (context) => {
    const denied = authorized(context);
    if (denied) return denied;
    if (Object.keys(context.req.query()).length)
      return context.json({ error: "invalid_request" }, 400);
    const userId = userIdSchema.safeParse(context.req.param("userId"));
    const body = roleSchema.safeParse(await readControlPlaneJson(context));
    if (!userId.success || !body.success)
      return context.json({ error: "invalid_request" }, 400);
    const projectId = context.req.param("projectId");
    if (!getControlPlaneProjectAccessPolicy(deps.db, projectId))
      return context.json({ error: "project_not_found" }, 404);
    const operationId = randomUUID();
    try {
      const result = await getControlPlaneNativeProjectMaintenanceCoordinator(
        deps,
      ).changeRole({
        projectId,
        userId: userId.data,
        role: body.data.role,
        expectedRevision: body.data.expectedRevision,
        operationId,
      });
      if (!result.changed)
        return context.json({
          changed: false,
          revision: result.revision,
          operationId: null,
          phase: null,
        });
      return context.json({
        changed: true,
        revision: result.revision,
        operationId,
        phase: result.operation.phase,
      });
    } catch (error) {
      const saved = getControlPlaneProjectMaintenance(deps.db, operationId);
      if (saved?.projectId === projectId) {
        deps.logger.warn(
          { err: error, operationId },
          "Project role change remains pending",
        );
        return context.json(
          {
            changed: true,
            revision: saved.projectRevision,
            operationId,
            phase: saved.phase,
          },
          202,
        );
      }
      if (error instanceof Error && error.message.includes("unavailable"))
        return context.json({ error: "role_target_unavailable" }, 404);
      return context.json({ error: "role_change_conflict" }, 409);
    }
  });
}
