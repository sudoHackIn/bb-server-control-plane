import type { Hono, Context } from "hono";
import { z } from "zod";
import {
  ControlPlaneMcpError,
  createControlPlaneMcpConnector,
  updateControlPlaneMcpConnector,
  listControlPlaneMcpConnectors,
  getControlPlaneMcpConnector,
  setControlPlaneMcpAccess,
  configureControlPlaneMcpConnection,
  listControlPlaneMcpConnections,
  removeControlPlaneMcpConnection,
  type DbConnection,
} from "@bb/db";
import {
  controlPlaneMcpConnectorCreateSchema,
  controlPlaneMcpConnectorUpdateSchema,
  controlPlaneMcpCredentialInputSchema,
  controlPlaneMcpConnectionCreateSchema,
} from "@bb/domain";
import { currentControlPlanePrincipal } from "./access.js";
import { controlPlaneBodyLimit, readControlPlaneJson } from "./request-body.js";
import type { ControlPlaneMcpCredentials } from "./mcp-credentials.js";

const revision = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();
const page = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export function isControlPlaneMcpPath(path: string, method: string): boolean {
  if (/^\/control-plane\/user\/mcp\/connectors(?:\/[^/]+)?$/u.test(path))
    return method === "GET";
  if (/^\/control-plane\/user\/mcp\/connectors\/[^/]+\/credential$/u.test(path))
    return ["GET", "PUT", "DELETE"].includes(method);
  if (/^\/control-plane\/user\/projects\/[^/]+\/mcp$/u.test(path))
    return ["GET", "PUT"].includes(method);
  return (
    /^\/control-plane\/user\/projects\/[^/]+\/mcp\/[^/]+$/u.test(path) &&
    method === "DELETE"
  );
}

async function readBody<T extends z.ZodType>(
  context: Context,
  schema: T,
): Promise<
  { ok: true; value: z.output<T> } | { ok: false; response: Response }
> {
  const parsed = schema.safeParse(await readControlPlaneJson(context));
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, response: context.json({ error: "invalid_request" }, 400) };
}

export function installControlPlaneMcpRoutes(
  app: Hono,
  db: DbConnection,
  secrets: ControlPlaneMcpCredentials,
  authenticate: (context: Context) => { user: { id: string } } | null,
) {
  const admin = "/control-plane/admin/mcp";
  const personal = "/control-plane/user/mcp";
  for (const path of [
    admin + "/*",
    personal + "/*",
    "/control-plane/user/projects/:projectId/mcp/*",
  ])
    app.use(path, controlPlaneBodyLimit(65536));
  app.use(admin + "/*", async (context, next) =>
    ["admin", "service"].includes(currentControlPlanePrincipal()?.kind ?? "")
      ? next()
      : context.json({ error: "administrator_required" }, 403),
  );
  const handled =
    (
      run: (
        context: Context,
        userId: string | null,
      ) => Response | Promise<Response>,
      user = false,
    ) =>
    async (context: Context) => {
      if (
        Object.keys(context.req.query()).length &&
        !(
          context.req.method === "GET" &&
          [admin + "/connectors", personal + "/connectors"].includes(
            context.req.path,
          )
        )
      )
        return context.json({ error: "invalid_request" }, 400);
      const id = context.req.param("id");
      if (id && !z.string().uuid().safeParse(id).success)
        return context.json({ error: "invalid_request" }, 400);
      const identity = user ? authenticate(context) : null;
      if (user && !identity)
        return context.json({ error: "authentication_required" }, 401);
      try {
        return await run(context, identity?.user.id ?? null);
      } catch (error) {
        if (error instanceof ControlPlaneMcpError)
          return context.json(
            { error: `mcp_${error.code}` },
            error.code === "not_found"
              ? 404
              : error.code === "conflict"
                ? 409
                : error.code === "forbidden"
                  ? 403
                  : 503,
          );
        throw error;
      }
    };
  for (const [base, user] of [
    [admin, false],
    [personal, true],
  ] as const) {
    app.get(
      base + "/connectors",
      handled((context, userId) => {
        const parsed = page.safeParse(context.req.query());
        if (!parsed.success)
          return context.json({ error: "invalid_request" }, 400);
        return context.json(
          listControlPlaneMcpConnectors(db, userId, {
            cursor: parsed.data.cursor ?? null,
            limit: parsed.data.limit,
          }),
        );
      }, user),
    );
    app.get(
      base + "/connectors/:id",
      handled((context, userId) => {
        if (Object.keys(context.req.query()).length)
          return context.json({ error: "invalid_request" }, 400);
        const connector = getControlPlaneMcpConnector(
          db,
          userId,
          context.req.param("id") ?? "",
        );
        return connector
          ? context.json(connector)
          : context.json({ error: "mcp_not_found" }, 404);
      }, user),
    );
  }
  app.post(
    admin + "/connectors",
    handled(async (context) => {
      const input = await readBody(
        context,
        controlPlaneMcpConnectorCreateSchema,
      );
      return input.ok
        ? context.json(createControlPlaneMcpConnector(db, input.value), 201)
        : input.response;
    }),
  );
  app.put(
    admin + "/connectors/:id",
    handled(async (context) => {
      const input = await readBody(
        context,
        controlPlaneMcpConnectorUpdateSchema,
      );
      return input.ok
        ? context.json(
            updateControlPlaneMcpConnector(
              db,
              context.req.param("id") ?? "",
              input.value,
            ),
          )
        : input.response;
    }),
  );
  app.put(
    admin + "/connectors/:id/access/:userId",
    handled(async (context) => {
      const input = await readBody(
        context,
        z.object({ allowed: z.boolean() }).strict(),
      );
      if (!input.ok) return input.response;
      setControlPlaneMcpAccess(
        db,
        context.req.param("id") ?? "",
        context.req.param("userId") ?? "",
        input.value.allowed,
      );
      return context.json({ ok: true });
    }),
  );
  app.get(
    personal + "/connectors/:id/credential",
    handled(
      (context, userId) =>
        context.json(secrets.metadata(userId!, context.req.param("id") ?? "")),
      true,
    ),
  );
  app.put(
    personal + "/connectors/:id/credential",
    handled(async (context, userId) => {
      const input = await readBody(
        context,
        controlPlaneMcpCredentialInputSchema,
      );
      return input.ok
        ? context.json(
            await secrets.set(
              userId!,
              context.req.param("id") ?? "",
              input.value,
            ),
          )
        : input.response;
    }, true),
  );
  app.delete(
    personal + "/connectors/:id/credential",
    handled(async (context, userId) => {
      const input = await readBody(context, revision);
      return input.ok
        ? context.json(
            secrets.revoke(
              userId!,
              context.req.param("id") ?? "",
              input.value.expectedRevision,
            ),
          )
        : input.response;
    }, true),
  );
  const project = "/control-plane/user/projects/:projectId/mcp";
  app.get(
    project,
    handled(
      (context, userId) =>
        context.json({
          connections: listControlPlaneMcpConnections(
            db,
            userId!,
            context.req.param("projectId") ?? "",
          ),
          executionSupported: false,
        }),
      true,
    ),
  );
  app.put(
    project,
    handled(async (context, userId) => {
      const input = await readBody(
        context,
        controlPlaneMcpConnectionCreateSchema
          .extend({ expectedRevision: z.number().int().nonnegative() })
          .strict(),
      );
      return input.ok
        ? context.json(
            configureControlPlaneMcpConnection(
              db,
              userId!,
              context.req.param("projectId") ?? "",
              input.value.connectorId,
              input.value.connectorRevision,
              input.value.expectedRevision,
            ),
          )
        : input.response;
    }, true),
  );
  app.delete(
    project + "/:id",
    handled(async (context, userId) => {
      const input = await readBody(context, revision);
      if (!input.ok) return input.response;
      removeControlPlaneMcpConnection(
        db,
        userId!,
        context.req.param("projectId") ?? "",
        context.req.param("id") ?? "",
        input.value.expectedRevision,
      );
      return context.json({ ok: true });
    }, true),
  );
}
