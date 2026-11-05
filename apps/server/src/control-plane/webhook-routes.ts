import type { Context, Hono } from "hono";
import { z } from "zod";
import { ControlPlaneThreadError } from "@bb/db";
import { controlPlaneWebhookCreateSchema } from "@bb/domain";
import {
  controlPlaneBodyLimit,
  readControlPlaneJson,
  hasControlPlaneEmptyBody,
} from "./request-body.js";
import type { ControlPlaneWebhookService } from "./webhooks.js";
const base = "/control-plane/user/webhooks";
export function isControlPlaneWebhookPath(path: string, method: string) {
  if (/^\/control-plane\/webhooks\/[0-9a-f-]{36}\/deliver$/u.test(path))
    return method === "POST";
  if (path === base) return ["GET", "POST"].includes(method);
  if (/^\/control-plane\/user\/webhooks\/[0-9a-f-]{36}$/u.test(path))
    return ["GET", "PUT"].includes(method);
  return method === "GET"
    ? /^\/control-plane\/user\/webhooks\/[0-9a-f-]{36}\/history$/u.test(path)
    : method === "POST" &&
        /^\/control-plane\/user\/webhooks\/[0-9a-f-]{36}\/rotate$/u.test(path);
}
export function installControlPlaneWebhookRoutes(
  app: Hono,
  service: ControlPlaneWebhookService,
  authenticate: (context: Context) => { user: { id: string } } | null,
) {
  const page = z
    .object({
      cursor: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    })
    .strict();
  app.use(base, controlPlaneBodyLimit(4096));
  app.use(`${base}/*`, controlPlaneBodyLimit(4096));
  app.use("/control-plane/webhooks/*", controlPlaneBodyLimit(262144));
  const route =
    (fn: (c: Context, userId: string) => Promise<Response>) =>
    async (c: Context) => {
      c.header("cache-control", "no-store");
      const identity = authenticate(c);
      if (!identity) return c.json({ error: "authentication_required" }, 401);
      if (
        Object.keys(c.req.query()).length &&
        !(
          c.req.method === "GET" &&
          (c.req.path === base || c.req.path.endsWith("/history"))
        )
      )
        return c.json({ error: "invalid_request" }, 400);
      try {
        return await fn(c, identity.user.id);
      } catch (error) {
        if (error instanceof ControlPlaneThreadError)
          return c.json({ error: "execution_not_authorized" }, 403);
        throw error;
      }
    };
  app.get(
    base,
    route(async (c, userId) => {
      const q = page
        .extend({ projectId: z.string().min(1).max(200) })
        .safeParse(c.req.query());
      return q.success
        ? c.json(service.list(userId, q.data))
        : c.json({ error: "invalid_request" }, 400);
    }),
  );
  app.post(
    base,
    route(async (c, userId) => {
      const input = controlPlaneWebhookCreateSchema.safeParse(
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
    `${base}/:id/rotate`,
    route(async (c, userId) =>
      (await hasControlPlaneEmptyBody(c))
        ? c.json(service.rotate(userId, c.req.param("id") ?? ""))
        : c.json({ error: "invalid_request" }, 400),
    ),
  );
  app.get(
    `${base}/:id/history`,
    route(async (c, userId) => {
      const q = page.safeParse(c.req.query());
      return q.success
        ? c.json(service.history(userId, c.req.param("id") ?? "", q.data))
        : c.json({ error: "invalid_request" }, 400);
    }),
  );
  app.post("/control-plane/webhooks/:id/deliver", async (c) => {
    c.header("cache-control", "no-store");
    if (Object.keys(c.req.query()).length)
      return c.json({ error: "invalid_request" }, 400);
    if (c.req.header("content-type")?.split(";")[0] !== "application/json")
      return c.json({ error: "json_required" }, 415);
    const result = await service.deliver(
      c.req.param("id"),
      c.req.header("authorization"),
      c.req.header("x-bb-delivery-id"),
      await c.req.text(),
    );
    return c.json(result, result.state === "failed" ? 422 : 202);
  });
}
