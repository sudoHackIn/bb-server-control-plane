import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import {
  controlPlaneProfileCreateSchema,
  controlPlaneProfileDefinitionSchema,
  controlPlaneProfilePublicationSchema,
  type ControlPlaneProfileDefinition,
} from "@bb/domain";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import {
  controlPlaneProfiles as profiles,
  controlPlaneProfileVersions as versions,
  controlPlaneProfileAccess as access,
  controlPlaneUsers as users,
} from "../schema.js";

export class ControlPlaneProfileError extends Error {
  constructor() {
    super("Profile is unavailable");
    this.name = "ControlPlaneProfileError";
  }
}

function catalog(db: DbQueryConnection, userId: string | null) {
  return db
    .select({
      id: profiles.id,
      slug: profiles.slug,
      name: profiles.name,
      enabled: profiles.enabled,
      createdAt: profiles.createdAt,
      latestVersionId: sql<string>`${versions.id}`.as("latest_version_id"),
      latestVersion: sql<number>`${versions.version}`.as("latest_version"),
    })
    .from(profiles)
    .innerJoin(
      versions,
      and(
        eq(versions.profileId, profiles.id),
        sql`${versions.version} = (SELECT MAX(v.version) FROM control_plane_profile_versions v WHERE v.profile_id = ${profiles.id} ${userId === null ? sql`` : sql`AND v.enabled = 1`})`,
      ),
    )
    .where(
      userId === null
        ? undefined
        : and(
            eq(profiles.enabled, true),
            sql`EXISTS (SELECT 1 FROM control_plane_profile_access a JOIN control_plane_users u ON u.id = a.user_id WHERE a.profile_id = ${profiles.id} AND a.user_id = ${userId} AND u.enabled = 1)`,
          ),
    )
    .$dynamic();
}

export function listControlPlaneProfiles(
  db: DbQueryConnection,
  userId: string | null,
  options: { cursor: string | null; limit: number },
) {
  const rows = catalog(db, userId).as("catalog");
  const found = db
    .select()
    .from(rows)
    .where(options.cursor ? gt(rows.id, options.cursor) : undefined)
    .orderBy(asc(rows.id))
    .limit(options.limit + 1)
    .all();
  return {
    profiles: found.slice(0, options.limit),
    nextCursor:
      found.length > options.limit
        ? (found[options.limit - 1]?.id ?? null)
        : null,
  };
}

export function getControlPlaneProfile(
  db: DbQueryConnection,
  userId: string | null,
  profileId: string,
  versionId: string | null = null,
) {
  const rows = catalog(db, userId).as("catalog");
  const profile = db.select().from(rows).where(eq(rows.id, profileId)).get();
  if (!profile) return null;
  const version = db
    .select()
    .from(versions)
    .where(
      and(
        eq(versions.id, versionId ?? profile.latestVersionId),
        eq(versions.profileId, profile.id),
        userId === null ? undefined : eq(versions.enabled, true),
      ),
    )
    .get();
  return version
    ? {
        profile,
        version: {
          ...version,
          definition: controlPlaneProfileDefinitionSchema.parse(
            version.definition,
          ),
        },
      }
    : null;
}

export function createControlPlaneProfile(
  db: DbConnection,
  input: {
    slug: string;
    name: string;
    definition: ControlPlaneProfileDefinition;
  },
) {
  const parsed = controlPlaneProfileCreateSchema.parse(input);
  return db.transaction(
    (tx) => {
      const id = randomUUID();
      tx.insert(profiles)
        .values({
          id,
          slug: parsed.slug,
          name: parsed.name,
          enabled: true,
          createdAt: Date.now(),
        })
        .run();
      const version = tx
        .insert(versions)
        .values({
          id: randomUUID(),
          profileId: id,
          version: 1,
          enabled: true,
          definition: parsed.definition,
          createdAt: Date.now(),
        })
        .returning()
        .get();
      return { profileId: id, versionId: version.id };
    },
    { behavior: "immediate" },
  );
}

export function publishControlPlaneProfileVersion(
  db: DbConnection,
  profileId: string,
  definition: ControlPlaneProfileDefinition,
) {
  const parsed = controlPlaneProfilePublicationSchema.parse(definition);
  return db.transaction(
    (tx) => {
      const last = tx
        .select()
        .from(versions)
        .where(eq(versions.profileId, profileId))
        .orderBy(desc(versions.version))
        .limit(1)
        .get();
      if (!last) throw new ControlPlaneProfileError();
      return tx
        .insert(versions)
        .values({
          id: randomUUID(),
          profileId,
          version: last.version + 1,
          enabled: true,
          definition: parsed,
          createdAt: Date.now(),
        })
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );
}

export function setControlPlaneProfileEnabled(
  db: DbConnection,
  profileId: string,
  enabled: boolean,
  versionId: string | null = null,
) {
  const updated =
    versionId === null
      ? db
          .update(profiles)
          .set({ enabled })
          .where(eq(profiles.id, profileId))
          .returning()
          .get()
      : db
          .update(versions)
          .set({ enabled })
          .where(
            and(eq(versions.id, versionId), eq(versions.profileId, profileId)),
          )
          .returning()
          .get();
  if (!updated) throw new ControlPlaneProfileError();
}

export function setControlPlaneProfileAccess(
  db: DbConnection,
  profileId: string,
  userId: string,
  allowed: boolean,
) {
  db.transaction(
    (tx) => {
      if (
        !tx.select().from(profiles).where(eq(profiles.id, profileId)).get() ||
        !tx.select().from(users).where(eq(users.id, userId)).get()
      )
        throw new ControlPlaneProfileError();
      if (allowed)
        tx.insert(access)
          .values({ profileId, userId })
          .onConflictDoNothing()
          .run();
      else
        tx.delete(access)
          .where(
            and(eq(access.profileId, profileId), eq(access.userId, userId)),
          )
          .run();
    },
    { behavior: "immediate" },
  );
}

export function listControlPlaneProfileAccess(
  db: DbQueryConnection,
  profileId: string,
  options: { cursor: string | null; limit: number },
) {
  if (!db.select().from(profiles).where(eq(profiles.id, profileId)).get())
    throw new ControlPlaneProfileError();
  const found = db
    .select({ userId: users.id, login: users.login, enabled: users.enabled })
    .from(access)
    .innerJoin(users, eq(users.id, access.userId))
    .where(
      and(
        eq(access.profileId, profileId),
        options.cursor ? gt(users.id, options.cursor) : undefined,
      ),
    )
    .orderBy(asc(users.id))
    .limit(options.limit + 1)
    .all();
  return {
    users: found.slice(0, options.limit),
    nextCursor:
      found.length > options.limit
        ? (found[options.limit - 1]?.userId ?? null)
        : null,
  };
}

export function listControlPlaneProfileVersions(
  db: DbQueryConnection,
  userId: string | null,
  profileId: string,
  options: { cursor: number | null; limit: number },
) {
  if (!getControlPlaneProfile(db, userId, profileId))
    throw new ControlPlaneProfileError();
  const found = db
    .select({
      id: versions.id,
      profileId: versions.profileId,
      version: versions.version,
      enabled: versions.enabled,
      createdAt: versions.createdAt,
    })
    .from(versions)
    .where(
      and(
        eq(versions.profileId, profileId),
        userId === null ? undefined : eq(versions.enabled, true),
        options.cursor === null
          ? undefined
          : lt(versions.version, options.cursor),
      ),
    )
    .orderBy(desc(versions.version))
    .limit(options.limit + 1)
    .all();
  return {
    versions: found.slice(0, options.limit),
    nextCursor:
      found.length > options.limit
        ? (found[options.limit - 1]?.version ?? null)
        : null,
  };
}
