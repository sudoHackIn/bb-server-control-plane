import { ControlPlaneThreadError } from "@bb/db";
import {
  controlPlaneAutomationCreateSchema,
  controlPlaneAutomationUpdateSchema,
  controlPlaneAutomationRunInputSchema,
} from "@bb/domain";
import {
  controlPlaneBodyLimit,
  readControlPlaneJson,
  hasControlPlaneEmptyBody,
} from "./request-body.js";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { ControlPlaneAutomationService } from "./automations.js";

const base = "/control-plane/user/automations";
export function isControlPlaneAutomationPath(path: string, method: string) {
  if (path === base) return method === "GET" || method === "POST";
  if (/^\/control-plane\/user\/automations\/[^/]+$/u.test(path))
    return ["GET", "PUT", "DELETE"].includes(method);
  return method === "GET"
    ? /^\/control-plane\/user\/automations\/[^/]+\/(?:history|definition|runs\/[^/]+\/output)$/u.test(
        path,
      )
    : method === "POST" &&
        /^\/control-plane\/user\/automations\/[^/]+\/(?:pause|resume|run|runs\/[^/]+\/stop)$/u.test(
          path,
        );
}
export function installControlPlaneAutomationRoutes(
  app: Hono,
  service: ControlPlaneAutomationService,
  authenticate: (context: Context) => { user: { id: string } } | null,
) {
  app.use(`${base}/*`, controlPlaneBodyLimit(1024 * 1024));
  function route(run: (context: Context, userId: string) => Promise<Response>) {
    return async (context: Context) => {
      context.header("cache-control", "no-store");
      const identity = authenticate(context);
      if (!identity)
        return context.json({ error: "authentication_required" }, 401);
      try {
        return await run(context, identity.user.id);
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
  app.get(
    `${base}/:id/definition`,
    route(async (context, userId) => {
      if (Object.keys(context.req.query()).length)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        await service.definition(userId, context.req.param("id") ?? ""),
      );
    }),
  );
  app.get(
    `${base}/:id/runs/:runId/output`,
    route(async (context, userId) => {
      if (Object.keys(context.req.query()).length)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        await service.output(
          userId,
          context.req.param("id") ?? "",
          context.req.param("runId") ?? "",
        ),
      );
    }),
  );
  app.post(
    base,
    route(async (context, userId) => {
      const input = controlPlaneAutomationCreateSchema.safeParse(
        await readControlPlaneJson(context),
      );
      if (!input.success || Object.keys(context.req.query()).length)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(await service.create(userId, input.data), 201);
    }),
  );
  app.put(
    `${base}/:id`,
    route(async (context, userId) => {
      const input = controlPlaneAutomationUpdateSchema.safeParse(
        await readControlPlaneJson(context),
      );
      if (!input.success || Object.keys(context.req.query()).length)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        await service.update(userId, context.req.param("id") ?? "", input.data),
      );
    }),
  );
  app.delete(
    `${base}/:id`,
    route(async (context, userId) => {
      if (
        Object.keys(context.req.query()).length ||
        !(await hasControlPlaneEmptyBody(context))
      )
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        await service.remove(userId, context.req.param("id") ?? ""),
      );
    }),
  );
  for (const operation of ["pause", "resume"] as const)
    app.post(
      `${base}/:id/${operation}`,
      route(async (context, userId) => {
        if (
          Object.keys(context.req.query()).length ||
          !(await hasControlPlaneEmptyBody(context))
        )
          return context.json({ error: "invalid_request" }, 400);
        return context.json(
          await service.enabled(
            userId,
            context.req.param("id") ?? "",
            operation === "resume",
          ),
        );
      }),
    );
  app.post(
    `${base}/:id/run`,
    route(async (context, userId) => {
      const input = controlPlaneAutomationRunInputSchema.safeParse(
        await readControlPlaneJson(context),
      );
      if (!input.success || Object.keys(context.req.query()).length)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        await service.run(userId, context.req.param("id") ?? "", input.data),
        201,
      );
    }),
  );
  app.post(
    `${base}/:id/runs/:runId/stop`,
    route(async (context, userId) => {
      if (
        Object.keys(context.req.query()).length ||
        !(await hasControlPlaneEmptyBody(context))
      )
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        await service.stop(
          userId,
          context.req.param("id") ?? "",
          context.req.param("runId") ?? "",
        ),
      );
    }),
  );
}
