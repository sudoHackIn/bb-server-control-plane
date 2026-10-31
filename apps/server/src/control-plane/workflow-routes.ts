import {
  controlPlaneBodyLimit,
  readControlPlaneJson,
  hasControlPlaneEmptyBody,
} from "./request-body.js";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { ControlPlaneThreadError } from "@bb/db";
import { controlPlaneWorkflowStartSchema } from "@bb/domain";
import type { ControlPlaneWorkflowService } from "./workflows.js";

export function isControlPlaneWorkflowPath(path: string, method: string) {
  if (path === "/control-plane/user/workflows")
    return ["GET", "POST"].includes(method);
  return method === "GET"
    ? /^\/control-plane\/user\/workflows\/[^/]+(?:\/(?:result|history|inspection|trace|calls\/[^/]+))?$/u.test(
        path,
      )
    : method === "POST" &&
        /^\/control-plane\/user\/workflows\/[^/]+\/stop$/u.test(path);
}
export function installControlPlaneWorkflowRoutes(
  app: Hono,
  service: ControlPlaneWorkflowService,
  authenticate: (context: Context) => { user: { id: string } } | null,
) {
  const base = "/control-plane/user/workflows";
  app.use(`${base}/*`, controlPlaneBodyLimit(4 * 1024 * 1024));
  function route(run: (context: Context, userId: string) => Promise<Response>) {
    return async (context: Context) => {
      const identity = authenticate(context);
      if (!identity)
        return context.json({ error: "authentication_required" }, 401);
      context.header("cache-control", "no-store");
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
      const parsed = z
        .object({
          projectId: z.string().min(1).max(200).optional(),
          cursor: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        })
        .strict()
        .safeParse(context.req.query());
      if (!parsed.success)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        await service.list(userId, {
          ...parsed.data,
          cursor: parsed.data.cursor ?? null,
        }),
      );
    }),
  );
  app.post(
    base,
    route(async (context, userId) => {
      const parsed = controlPlaneWorkflowStartSchema.safeParse(
        await readControlPlaneJson(context),
      );
      if (!parsed.success)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(await service.start(userId, parsed.data), 201);
    }),
  );
  app.get(
    `${base}/:id/trace`,
    route(async (context, userId) => {
      const parsed = z
        .object({
          attemptId: z.string().uuid().optional(),
          after: z.coerce.number().int().min(-1).default(-1),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        })
        .strict()
        .safeParse(context.req.query());
      if (!parsed.success)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        await service.trace(
          userId,
          context.req.param("id") ?? "",
          parsed.data.attemptId ?? null,
          parsed.data.after,
          parsed.data.limit,
        ),
      );
    }),
  );
  app.get(
    `${base}/:id/inspection`,
    route(async (context, userId) => {
      const parsed = z
        .object({
          after: z.coerce.number().int().min(-1).default(-1),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        })
        .strict()
        .safeParse(context.req.query());
      if (!parsed.success)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        await service.inspect(
          userId,
          context.req.param("id") ?? "",
          parsed.data.after,
          parsed.data.limit,
        ),
      );
    }),
  );
  app.get(
    `${base}/:id/calls/:callId`,
    route(async (context, userId) => {
      if (Object.keys(context.req.query()).length)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        await service.inspectCall(
          userId,
          context.req.param("id") ?? "",
          context.req.param("callId") ?? "",
        ),
      );
    }),
  );
  app.get(
    `${base}/:id/history`,
    route(async (context, userId) => {
      const parsed = z
        .object({
          after: z.coerce.number().int().min(-1).default(-1),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        })
        .strict()
        .safeParse(context.req.query());
      if (!parsed.success)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        await service.history(
          userId,
          context.req.param("id") ?? "",
          parsed.data.after,
          parsed.data.limit,
        ),
      );
    }),
  );
  for (const operation of ["get", "result", "stop"] as const) {
    const handler = route(async (context, userId) => {
      if (
        Object.keys(context.req.query()).length ||
        (operation === "stop" && !(await hasControlPlaneEmptyBody(context)))
      )
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        await service[operation](userId, context.req.param("id") ?? ""),
      );
    });
    const path =
      operation === "get" ? `${base}/:id` : `${base}/:id/${operation}`;
    if (operation === "stop") app.post(path, handler);
    else app.get(path, handler);
  }
}
