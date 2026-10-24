import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  controlPlaneProfileCreateSchema,
  controlPlaneProfileDefinitionSchema,
} from "@bb/domain";
import {
  ControlPlaneProfileError,
  createControlPlaneProfile,
  getControlPlaneProfile,
  listControlPlaneProfiles,
  listControlPlaneProfileAccess,
  listControlPlaneProfileVersions,
  publishControlPlaneProfileVersion,
  setControlPlaneProfileAccess,
  setControlPlaneProfileEnabled,
  isSqliteUniqueConstraintOnColumns,
  type DbConnection,
} from "@bb/db";
import { currentControlPlanePrincipal } from "./access.js";

const pageSchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const enabledSchema = z.object({ enabled: z.boolean() }).strict();
const allowedSchema = z.object({ allowed: z.boolean() }).strict();

export function installControlPlaneProfileRoutes(
  app: Hono,
  db: DbConnection,
  authenticate: (context: Context) => { user: { id: string } } | null,
) {
  const admin = "/control-plane/admin/profiles";
  const user = "/control-plane/user/profiles";
  app.use(`${admin}*`, bodyLimit({ maxSize: 1048576 }));
  app.use(`${admin}*`, async (context, next) => {
    if (
      !["admin", "service"].includes(currentControlPlanePrincipal()?.kind ?? "")
    )
      return context.json({ error: "administrator_required" }, 403);
    return next();
  });
  const handled =
    (run: (context: Context) => Response | Promise<Response>) =>
    async (context: Context) => {
      try {
        return await run(context);
      } catch (error) {
        if (error instanceof ControlPlaneProfileError)
          return context.json({ error: "profile_not_found" }, 404);
        if (
          error instanceof Error &&
          isSqliteUniqueConstraintOnColumns(error, {
            tableName: "control_plane_profiles",
            columnNames: ["slug"],
            indexName: "control_plane_profiles_slug_unique",
          })
        )
          return context.json({ error: "profile_conflict" }, 409);
        throw error;
      }
    };
  for (const [base, personal] of [
    [admin, false],
    [user, true],
  ] as const) {
    app.get(
      `${base}/:id/versions`,
      handled((context) => {
        const identity = personal ? authenticate(context) : null;
        if (personal && !identity)
          return context.json({ error: "authentication_required" }, 401);
        const parsed = z
          .object({
            cursor: z.coerce.number().int().positive().optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          })
          .strict()
          .safeParse(context.req.query());
        if (!parsed.success)
          return context.json({ error: "invalid_request" }, 400);
        return context.json(
          listControlPlaneProfileVersions(
            db,
            identity?.user.id ?? null,
            context.req.param("id") ?? "",
            { cursor: parsed.data.cursor ?? null, limit: parsed.data.limit },
          ),
        );
      }),
    );
    app.get(base, (context) => {
      const identity = personal ? authenticate(context) : null;
      if (personal && !identity)
        return context.json({ error: "authentication_required" }, 401);
      const parsed = pageSchema.safeParse(context.req.query());
      if (!parsed.success)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        listControlPlaneProfiles(db, identity?.user.id ?? null, {
          cursor: parsed.data.cursor ?? null,
          limit: parsed.data.limit,
        }),
      );
    });
    for (const path of [`${base}/:id`, `${base}/:id/versions/:versionId`]) {
      app.get(path, (context) => {
        const identity = personal ? authenticate(context) : null;
        if (personal && !identity)
          return context.json({ error: "authentication_required" }, 401);
        if (Object.keys(context.req.query()).length)
          return context.json({ error: "invalid_request" }, 400);
        const result = getControlPlaneProfile(
          db,
          identity?.user.id ?? null,
          context.req.param("id") ?? "",
          context.req.param("versionId") ?? null,
        );
        return result
          ? context.json(result)
          : context.json({ error: "profile_not_found" }, 404);
      });
    }
  }
  app.post(
    admin,
    handled(async (context) => {
      const parsed = controlPlaneProfileCreateSchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!parsed.success)
        return context.json({ error: "invalid_request" }, 400);
      const result = createControlPlaneProfile(db, parsed.data);
      return context.json(
        getControlPlaneProfile(db, null, result.profileId),
        201,
      );
    }),
  );
  app.post(
    `${admin}/:id/versions`,
    handled(async (context) => {
      const parsed = z
        .object({ definition: controlPlaneProfileDefinitionSchema })
        .strict()
        .safeParse(await context.req.json().catch(() => null));
      if (!parsed.success)
        return context.json({ error: "invalid_request" }, 400);
      const profileId = context.req.param("id") ?? "";
      const version = publishControlPlaneProfileVersion(
        db,
        profileId,
        parsed.data.definition,
      );
      return context.json(
        getControlPlaneProfile(db, null, profileId, version.id),
        201,
      );
    }),
  );
  for (const path of [
    `${admin}/:id/enabled`,
    `${admin}/:id/versions/:versionId/enabled`,
  ]) {
    app.put(
      path,
      handled(async (context) => {
        const parsed = enabledSchema.safeParse(
          await context.req.json().catch(() => null),
        );
        if (!parsed.success)
          return context.json({ error: "invalid_request" }, 400);
        setControlPlaneProfileEnabled(
          db,
          context.req.param("id") ?? "",
          parsed.data.enabled,
          context.req.param("versionId") ?? null,
        );
        return context.json({ ok: true });
      }),
    );
  }
  app.put(
    `${admin}/:id/access/:userId`,
    handled(async (context) => {
      const parsed = allowedSchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!parsed.success)
        return context.json({ error: "invalid_request" }, 400);
      setControlPlaneProfileAccess(
        db,
        context.req.param("id") ?? "",
        context.req.param("userId") ?? "",
        parsed.data.allowed,
      );
      return context.json({ ok: true });
    }),
  );
  app.get(
    `${admin}/:id/access`,
    handled((context) => {
      const parsed = pageSchema.safeParse(context.req.query());
      if (!parsed.success)
        return context.json({ error: "invalid_request" }, 400);
      return context.json(
        listControlPlaneProfileAccess(db, context.req.param("id") ?? "", {
          cursor: parsed.data.cursor ?? null,
          limit: parsed.data.limit,
        }),
      );
    }),
  );
}
