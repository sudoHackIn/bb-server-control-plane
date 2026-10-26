import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import {
  controlPlaneMcpConnectorCreateSchema,
  controlPlaneMcpConnectorUpdateSchema,
  controlPlaneMcpConnectorSchema,
  controlPlaneMcpConnectionSchema,
  type ControlPlaneMcpConnectorCreate,
  type ControlPlaneMcpConnectorUpdate,
} from "@bb/domain";
import {
  controlPlaneMcpConnectors as connectors,
  controlPlaneMcpAccess as access,
  controlPlaneMcpCredentials as credentials,
  controlPlaneMcpConnections as connections,
  controlPlaneUsers as users,
} from "../schema.js";
import { getControlPlaneProject } from "./control-plane-projects.js";
import type { DbConnection, DbQueryConnection } from "../connection.js";

export class ControlPlaneMcpError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "conflict"
      | "forbidden"
      | "credential_unavailable",
  ) {
    super(`MCP ${code}`);
    this.name = "ControlPlaneMcpError";
  }
}
const transport = {
  transport: "streamable-http" as const,
  authentication: "bearer" as const,
};
function visible(userId: string | null) {
  return userId === null
    ? undefined
    : and(
        eq(connectors.enabled, true),
        sql`EXISTS (SELECT 1 FROM ${access} a JOIN ${users} u ON u.id = a.user_id WHERE a.connector_id = ${connectors.id} AND a.user_id = ${userId} AND u.enabled = 1)`,
      );
}
export function getControlPlaneMcpConnector(
  db: DbQueryConnection,
  userId: string | null,
  id: string,
) {
  const row = db
    .select()
    .from(connectors)
    .where(and(eq(connectors.id, id), visible(userId)))
    .get();
  return row
    ? controlPlaneMcpConnectorSchema.parse({ ...row, ...transport })
    : null;
}
export function requireControlPlaneMcpConnector(
  db: DbQueryConnection,
  userId: string,
  id: string,
  revision: number,
) {
  const row = getControlPlaneMcpConnector(db, userId, id);
  if (!row) throw new ControlPlaneMcpError("not_found");
  if (row.revision !== revision) throw new ControlPlaneMcpError("conflict");
  return row;
}
export function listControlPlaneMcpConnectors(
  db: DbQueryConnection,
  userId: string | null,
  options: { cursor: string | null; limit: number },
) {
  const rows = db
    .select()
    .from(connectors)
    .where(
      and(
        visible(userId),
        options.cursor ? gt(connectors.id, options.cursor) : undefined,
      ),
    )
    .orderBy(asc(connectors.id))
    .limit(options.limit + 1)
    .all();
  return {
    connectors: rows
      .slice(0, options.limit)
      .map((row) =>
        controlPlaneMcpConnectorSchema.parse({ ...row, ...transport }),
      ),
    nextCursor:
      rows.length > options.limit ? rows[options.limit - 1]!.id : null,
  };
}
export function createControlPlaneMcpConnector(
  db: DbConnection,
  input: ControlPlaneMcpConnectorCreate,
) {
  const parsed = controlPlaneMcpConnectorCreateSchema.parse(input);
  const now = Date.now();
  const row = db
    .insert(connectors)
    .values({
      ...parsed,
      id: randomUUID(),
      revision: 1,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning()
    .get();
  if (!row) throw new ControlPlaneMcpError("conflict");
  return controlPlaneMcpConnectorSchema.parse({ ...row, ...transport });
}
export function updateControlPlaneMcpConnector(
  db: DbConnection,
  id: string,
  input: ControlPlaneMcpConnectorUpdate,
) {
  const { expectedRevision, ...definition } =
    controlPlaneMcpConnectorUpdateSchema.parse(input);
  const row = db
    .update(connectors)
    .set({
      ...definition,
      revision: expectedRevision + 1,
      updatedAt: Date.now(),
    })
    .where(
      and(eq(connectors.id, id), eq(connectors.revision, expectedRevision)),
    )
    .returning()
    .get();
  if (!row) throw new ControlPlaneMcpError("conflict");
  return controlPlaneMcpConnectorSchema.parse({ ...row, ...transport });
}
export function setControlPlaneMcpAccess(
  db: DbConnection,
  connectorId: string,
  userId: string,
  allowed: boolean,
) {
  if (
    !getControlPlaneMcpConnector(db, null, connectorId) ||
    !db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get()
  )
    throw new ControlPlaneMcpError("not_found");
  if (allowed)
    db.insert(access)
      .values({ connectorId, userId })
      .onConflictDoNothing()
      .run();
  else
    db.delete(access)
      .where(
        and(eq(access.connectorId, connectorId), eq(access.userId, userId)),
      )
      .run();
}
export function controlPlaneMcpCredentialMetadata(
  db: DbQueryConnection,
  userId: string,
  connectorId: string,
) {
  const row = db
    .select({
      revision: credentials.revision,
      connectorRevision: credentials.connectorRevision,
      configured: sql<boolean>`${credentials.ciphertext} IS NOT NULL`.mapWith(
        Boolean,
      ),
      updatedAt: credentials.updatedAt,
    })
    .from(credentials)
    .where(
      and(
        eq(credentials.userId, userId),
        eq(credentials.connectorId, connectorId),
      ),
    )
    .get();
  return {
    connectorId,
    revision: row?.revision ?? 0,
    connectorRevision: row?.connectorRevision ?? null,
    configured: row?.configured ?? false,
    updatedAt: row?.updatedAt ?? null,
  };
}
function project(
  db: DbQueryConnection,
  userId: string,
  projectId: string,
  manage: boolean,
) {
  const row = getControlPlaneProject(db, userId, projectId);
  if (!row) throw new ControlPlaneMcpError("not_found");
  if (manage && row.role !== "owner")
    throw new ControlPlaneMcpError("forbidden");
  return row;
}
export function listControlPlaneMcpConnections(
  db: DbQueryConnection,
  userId: string,
  projectId: string,
) {
  project(db, userId, projectId, false);
  const rows = db
    .select({
      connection: connections,
      name: connectors.name,
      slug: connectors.slug,
      currentRevision: connectors.revision,
      connectorEnabled: connectors.enabled,
      allowed:
        sql<boolean>`EXISTS (SELECT 1 FROM ${access} a WHERE a.connector_id = ${connectors.id} AND a.user_id = ${userId})`.mapWith(
          Boolean,
        ),
      credentialRevision: credentials.connectorRevision,
      ciphertextPresent:
        sql<boolean>`${credentials.ciphertext} IS NOT NULL`.mapWith(Boolean),
    })
    .from(connections)
    .innerJoin(connectors, eq(connectors.id, connections.connectorId))
    .leftJoin(
      credentials,
      and(
        eq(credentials.connectorId, connectors.id),
        eq(credentials.userId, userId),
      ),
    )
    .where(eq(connections.projectId, projectId))
    .orderBy(asc(connections.id))
    .all();
  return rows.map((row) =>
    controlPlaneMcpConnectionSchema.parse({
      ...row.connection,
      name: row.name,
      slug: row.slug,
      readiness: !row.allowed
        ? "access_denied"
        : !row.connectorEnabled
          ? "connector_unavailable"
          : row.currentRevision !== row.connection.connectorRevision
            ? "revision_mismatch"
            : !row.ciphertextPresent ||
                row.credentialRevision !== row.currentRevision
              ? "credentials_required"
              : "configured",
      executionState: "not_activated",
    }),
  );
}
export function configureControlPlaneMcpConnection(
  db: DbConnection,
  userId: string,
  projectId: string,
  connectorId: string,
  connectorRevision: number,
  expectedRevision: number,
) {
  return db.transaction(
    (tx) => {
      project(tx, userId, projectId, true);
      requireControlPlaneMcpConnector(
        tx,
        userId,
        connectorId,
        connectorRevision,
      );
      const old = tx
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.projectId, projectId),
            eq(connections.connectorId, connectorId),
          ),
        )
        .get();
      if ((old?.revision ?? 0) !== expectedRevision)
        throw new ControlPlaneMcpError("conflict");
      const now = Date.now();
      if (old)
        tx.update(connections)
          .set({
            connectorRevision,
            revision: old.revision + 1,
            enabled: false,
            updatedAt: now,
          })
          .where(eq(connections.id, old.id))
          .run();
      else
        tx.insert(connections)
          .values({
            id: randomUUID(),
            projectId,
            connectorId,
            connectorRevision,
            revision: 1,
            enabled: false,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      return listControlPlaneMcpConnections(tx, userId, projectId).find(
        (row) => row.connectorId === connectorId,
      )!;
    },
    { behavior: "immediate" },
  );
}
export function removeControlPlaneMcpConnection(
  db: DbConnection,
  userId: string,
  projectId: string,
  id: string,
  expectedRevision: number,
) {
  return db.transaction(
    (tx) => {
      project(tx, userId, projectId, true);
      const removed = tx
        .delete(connections)
        .where(
          and(
            eq(connections.id, id),
            eq(connections.projectId, projectId),
            eq(connections.revision, expectedRevision),
          ),
        )
        .returning({ id: connections.id })
        .get();
      if (!removed) throw new ControlPlaneMcpError("conflict");
    },
    { behavior: "immediate" },
  );
}
