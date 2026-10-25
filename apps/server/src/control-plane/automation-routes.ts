import type { Context, Hono } from "hono";
import { z } from "zod";
import type { ControlPlaneAutomationService } from "./automations.js";

const base = "/control-plane/user/automations";
export function isControlPlaneAutomationPath(path: string, method: string) {
  return (
    method === "GET" &&
    (path === base ||
      /^\/control-plane\/user\/automations\/[^/]+(?:\/history)?$/u.test(path))
  );
}
export function installControlPlaneAutomationRoutes(
  app: Hono,
  service: ControlPlaneAutomationService,
  authenticate: (context: Context) => { user: { id: string } } | null,
) {
  function route(run: (context: Context, userId: string) => Promise<Response>) {
    return async (context: Context) => {
      context.header("cache-control", "no-store");
      const identity = authenticate(context);
      if (!identity)
        return context.json({ error: "authentication_required" }, 401);
      return run(context, identity.user.id);
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
  app.get(
    `${base}/:id`,
    route(async (context, userId) => {
      if (Object.keys(context.req.query()).length)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        await service.get(userId, context.req.param("id") ?? ""),
      );
    }),
  );
  app.get(
    `${base}/:id/history`,
    route(async (context, userId) => {
      const query = z
        .object({
          cursor: z
            .string()
            .min(1)
            .max(1024)
            .regex(/^[A-Za-z0-9_-]+$/u)
            .optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        })
        .strict()
        .safeParse(context.req.query());
      if (!query.success)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        await service.history(
          userId,
          context.req.param("id") ?? "",
          query.data,
        ),
      );
    }),
  );
}
