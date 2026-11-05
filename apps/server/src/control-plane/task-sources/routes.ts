import type { Context, Hono } from "hono";
import { z } from "zod";
import { ControlPlaneThreadError } from "@bb/db";
import { controlPlaneTaskSourceCreateSchema } from "@bb/domain";
import {
  controlPlaneBodyLimit,
  readControlPlaneJson,
  hasControlPlaneEmptyBody,
} from "../request-body.js";
import type { ControlPlaneTaskSourceService } from "./service.js";
const base = "/control-plane/user/task-sources";
export function isControlPlaneTaskSourcePath(path: string, method: string) {
  if (path === base) return ["GET", "POST"].includes(method);
  if (/^\/control-plane\/user\/task-sources\/[0-9a-f-]{36}$/u.test(path))
    return ["GET", "PUT"].includes(method);
  return method === "GET"
    ? /^\/control-plane\/user\/task-sources\/[0-9a-f-]{36}\/history$/u.test(
        path,
      )
    : method === "POST" &&
        /^\/control-plane\/user\/task-sources\/[0-9a-f-]{36}\/poll$/u.test(
          path,
        );
}
export function installControlPlaneTaskSourceRoutes(
  app: Hono,
  service: ControlPlaneTaskSourceService,
  authenticate: (c: Context) => { user: { id: string } } | null,
) {
  app.use(base, controlPlaneBodyLimit(4096));
  app.use(`${base}/*`, controlPlaneBodyLimit(4096));
  const route =
    (fn: (c: Context, userId: string) => Promise<Response>) =>
    async (c: Context) => {
      c.header("cache-control", "no-store");
      const auth = authenticate(c);
      if (!auth) return c.json({ error: "authentication_required" }, 401);
      if (
        Object.keys(c.req.query()).length &&
        !(
          c.req.method === "GET" &&
          (c.req.path === base || c.req.path.endsWith("/history"))
        )
      )
        return c.json({ error: "invalid_request" }, 400);
      try {
        return await fn(c, auth.user.id);
      } catch (error) {
        if (error instanceof ControlPlaneThreadError)
          return c.json({ error: "execution_not_authorized" }, 403);
        throw error;
      }
    };
  const page = z.object({ cursor: z.string().uuid().optional() }).strict();
  app.get(
    base,
    route(async (c, userId) => {
      const q = page
        .extend({ projectId: z.string().min(1).max(200) })
        .safeParse(c.req.query());
      return q.success
        ? c.json(service.list(userId, q.data.projectId, q.data.cursor))
        : c.json({ error: "invalid_request" }, 400);
    }),
  );
  app.post(
    base,
    route(async (c, userId) => {
      const input = controlPlaneTaskSourceCreateSchema.safeParse(
        await readControlPlaneJson(c),
      );
      return input.success
        ? c.json(service.create(userId, input.data), 201)
        : c.json({ error: "invalid_request" }, 400);
    }),
  );
  app.get(
    `${base}/:id`,
    route(async (c, userId) =>
      c.json(service.get(userId, c.req.param("id") ?? "")),
    ),
  );
  app.put(
    `${base}/:id`,
    route(async (c, userId) => {
      const input = z
        .object({ enabled: z.boolean() })
        .strict()
        .safeParse(await readControlPlaneJson(c));
      return input.success
        ? c.json(
            service.setEnabled(
              userId,
              c.req.param("id") ?? "",
              input.data.enabled,
            ),
          )
        : c.json({ error: "invalid_request" }, 400);
    }),
  );
  app.post(
    `${base}/:id/poll`,
    route(async (c, userId) =>
      (await hasControlPlaneEmptyBody(c))
        ? c.json(await service.pollNow(userId, c.req.param("id") ?? ""))
        : c.json({ error: "invalid_request" }, 400),
    ),
  );
  app.get(
    `${base}/:id/history`,
    route(async (c, userId) => {
      const q = page.safeParse(c.req.query());
      return q.success
        ? c.json(
            service.history(userId, c.req.param("id") ?? "", q.data.cursor),
          )
        : c.json({ error: "invalid_request" }, 400);
    }),
  );
}
