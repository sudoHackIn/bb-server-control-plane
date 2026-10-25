import type { Context, Hono } from "hono";
import { z } from "zod";
import { ControlPlaneThreadError } from "@bb/db";
import {
  controlPlaneWorkflowDefinitionCreateSchema,
  controlPlaneWorkflowDefinitionUpdateSchema,
  controlPlaneWorkflowDefinitionRunSchema,
} from "@bb/domain";
import type { ControlPlaneWorkflowService } from "./workflows.js";
import {
  controlPlaneBodyLimit,
  readControlPlaneJson,
  hasControlPlaneEmptyBody,
} from "./request-body.js";
const base = "/control-plane/user/workflow-definitions";
export function isControlPlaneDefinitionPath(path: string, method: string) {
  if (path === base) return method === "GET" || method === "POST";
  if (/^\/control-plane\/user\/workflow-definitions\/[^/]+$/u.test(path))
    return ["GET", "PUT", "DELETE"].includes(method);
  return (
    method === "POST" &&
    /^\/control-plane\/user\/workflow-definitions\/[^/]+\/(?:enabled|run)$/u.test(
      path,
    )
  );
}
export function installControlPlaneDefinitionRoutes(
  app: Hono,
  service: ControlPlaneWorkflowService["definitions"],
  authenticate: (context: Context) => { user: { id: string } } | null,
) {
  app.use(`${base}/*`, controlPlaneBodyLimit(4 * 1024 * 1024));
  function route(
    run: (context: Context, userId: string, id: string) => Promise<Response>,
  ) {
    return async (context: Context) => {
      const identity = authenticate(context);
      if (!identity)
        return context.json({ error: "authentication_required" }, 401);
      context.header("cache-control", "no-store");
      try {
        return await run(
          context,
          identity.user.id,
          context.req.param("id") ?? "",
        );
      } catch (error) {
        if (error instanceof ControlPlaneThreadError)
          return context.json({ error: "execution_not_authorized" }, 403);
        throw error;
      }
    };
  }
  app.get(
    base,
    route(async (context, userId) => {
      const query = z
        .object({
          projectId: z.string().min(1).max(200).optional(),
          cursor: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        })
        .strict()
        .safeParse(context.req.query());
      if (!query.success)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        await service.list(userId, {
          ...query.data,
          cursor: query.data.cursor ?? null,
        }),
      );
    }),
  );
  app.post(
    base,
    route(async (context, userId) => {
      const input = controlPlaneWorkflowDefinitionCreateSchema.safeParse(
        await readControlPlaneJson(context),
      );
      if (!input.success || Object.keys(context.req.query()).length)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(await service.create(userId, input.data), 201);
    }),
  );
  app.get(
    `${base}/:id`,
    route(async (context, userId, id) => {
      const query = z
        .object({
          revision: z.coerce
            .number()
            .int()
            .min(1)
            .max(Number.MAX_SAFE_INTEGER)
            .optional(),
        })
        .strict()
        .safeParse(context.req.query());
      if (!query.success)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(await service.get(userId, id, query.data.revision));
    }),
  );
  app.put(
    `${base}/:id`,
    route(async (context, userId, id) => {
      const input = controlPlaneWorkflowDefinitionUpdateSchema.safeParse(
        await readControlPlaneJson(context),
      );
      if (!input.success || Object.keys(context.req.query()).length)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(await service.update(userId, id, input.data));
    }),
  );
  app.delete(
    `${base}/:id`,
    route(async (context, userId, id) => {
      if (
        Object.keys(context.req.query()).length ||
        !(await hasControlPlaneEmptyBody(context))
      )
        return context.json({ error: "invalid_request" }, 400);
      return context.json(await service.remove(userId, id));
    }),
  );
  app.post(
    `${base}/:id/enabled`,
    route(async (context, userId, id) => {
      const input = z
        .object({ enabled: z.boolean() })
        .strict()
        .safeParse(await readControlPlaneJson(context));
      if (!input.success || Object.keys(context.req.query()).length)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        await service.setEnabled(userId, id, input.data.enabled),
      );
    }),
  );
  app.post(
    `${base}/:id/run`,
    route(async (context, userId, id) => {
      const input = controlPlaneWorkflowDefinitionRunSchema.safeParse(
        await readControlPlaneJson(context),
      );
      if (!input.success || Object.keys(context.req.query()).length)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(await service.run(userId, id, input.data), 201);
    }),
  );
}
