import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  controlPlaneTimelinePageSchema,
  controlPlaneTimelineDetailsSchema,
} from "@bb/server-contract";
import {
  controlPlaneThreadStartSchema,
  controlPlaneThreadSendSchema,
  controlPlaneThreadResolutionSchema,
} from "@bb/domain";
import { ControlPlaneThreadError } from "@bb/db";
import type { ControlPlaneThreadService } from "./threads.js";

const page = z
  .object({
    projectId: z.string().min(1).max(200).optional(),
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const eventPage = z
  .object({
    after: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export function isControlPlaneThreadPath(path: string, method: string) {
  if (path === "/control-plane/user/threads")
    return ["GET", "POST"].includes(method);
  if (
    /^\/control-plane\/user\/threads\/[^/]+(?:\/(?:events|result|interactions|stream|timeline|timeline-details))?$/u.test(
      path,
    )
  )
    return method === "GET";
  if (/^\/control-plane\/user\/threads\/[^/]+\/(?:send|stop)$/u.test(path))
    return method === "POST";
  return (
    method === "POST" &&
    /^\/control-plane\/user\/threads\/[^/]+\/interactions\/[^/]+\/resolve$/u.test(
      path,
    )
  );
}
export function installControlPlaneThreadRoutes(
  app: Hono,
  service: ControlPlaneThreadService,
  authenticate: (context: Context) => { user: { id: string } } | null,
) {
  const base = "/control-plane/user/threads";
  app.use(`${base}*`, async (context, next) => {
    if (!authenticate(context))
      return context.json({ error: "authentication_required" }, 401);
    context.header("cache-control", "no-store");
    return next();
  });
  app.use(`${base}*`, bodyLimit({ maxSize: 1048576 }));
  const handled =
    (run: (context: Context, userId: string) => Response | Promise<Response>) =>
    async (context: Context) => {
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
  app.get(
    base,
    handled((context, userId) => {
      const parsed = page.safeParse(context.req.query());
      if (!parsed.success)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        service.list(userId, {
          ...parsed.data,
          cursor: parsed.data.cursor ?? null,
        }),
      );
    }),
  );
  app.post(
    base,
    handled(async (context, userId) => {
      const parsed = controlPlaneThreadStartSchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!parsed.success)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(await service.start(userId, parsed.data), 201);
    }),
  );
  app.get(
    `${base}/:id`,
    handled((context, userId) =>
      context.json(service.get(userId, context.req.param("id") ?? "")),
    ),
  );
  app.get(
    `${base}/:id/events`,
    handled((context, userId) => {
      const id = context.req.param("id") ?? "";
      service.get(userId, id);
      const parsed = eventPage.safeParse(context.req.query());
      if (!parsed.success)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(service.events(userId, id, parsed.data));
    }),
  );
  app.get(
    `${base}/:id/stream`,
    handled((context, userId) => {
      const id = context.req.param("id") ?? "";
      service.get(userId, id);
      const parsed = z
        .object({ after: z.coerce.number().int().nonnegative().default(0) })
        .strict()
        .safeParse(context.req.query());
      if (!parsed.success)
        return context.json({ error: "invalid_request" }, 400);
      return service.stream(userId, id, {
        after: parsed.data.after,
        signal: context.req.raw.signal,
        authorized: () => authenticate(context)?.user.id === userId,
      });
    }),
  );
  app.get(
    `${base}/:id/timeline`,
    handled((context, userId) => {
      const id = context.req.param("id") ?? "";
      service.get(userId, id);
      const parsed = controlPlaneTimelinePageSchema.safeParse(
        context.req.query(),
      );
      if (!parsed.success)
        return context.json({ error: "invalid_request" }, 400);
      const { beforeAnchorId, beforeAnchorSeq } = parsed.data;
      return context.json(
        beforeAnchorId === undefined || beforeAnchorSeq === undefined
          ? service.timeline(userId, id)
          : service.olderTimeline(userId, id, {
              anchorId: beforeAnchorId,
              anchorSeq: beforeAnchorSeq,
            }),
      );
    }),
  );
  app.get(
    `${base}/:id/timeline-details`,
    handled((context, userId) => {
      const id = context.req.param("id") ?? "";
      service.get(userId, id);
      const parsed = controlPlaneTimelineDetailsSchema.safeParse(
        context.req.query(),
      );
      if (!parsed.success)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(service.timelineDetails(userId, id, parsed.data));
    }),
  );
  app.get(
    `${base}/:id/result`,
    handled((context, userId) =>
      context.json(service.result(userId, context.req.param("id") ?? "")),
    ),
  );
  app.post(
    `${base}/:id/send`,
    handled(async (context, userId) => {
      const id = context.req.param("id") ?? "";
      service.get(userId, id);
      const parsed = controlPlaneThreadSendSchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!parsed.success)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(await service.send(userId, id, parsed.data));
    }),
  );
  app.post(
    `${base}/:id/stop`,
    handled(async (context, userId) =>
      context.json(await service.stop(userId, context.req.param("id") ?? "")),
    ),
  );
  app.get(
    `${base}/:id/interactions`,
    handled((context, userId) =>
      context.json(service.interactions(userId, context.req.param("id") ?? "")),
    ),
  );
  app.post(
    `${base}/:id/interactions/:interactionId/resolve`,
    handled(async (context, userId) => {
      const id = context.req.param("id") ?? "";
      service.get(userId, id);
      const parsed = controlPlaneThreadResolutionSchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!parsed.success)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        service.resolve(
          userId,
          id,
          context.req.param("interactionId") ?? "",
          parsed.data,
        ),
      );
    }),
  );
}
