import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  ControlPlaneRegistry,
  controlPlaneMcpCredentials,
  createControlPlaneMcpConnector,
  setControlPlaneMcpAccess,
  configureControlPlaneMcpConnection,
  createControlPlaneProject,
  migrate,
  noopNotifier,
  upsertHost,
  listControlPlaneMcpConnections,
} from "../src/index.js";
import { createMigratedConnection } from "../src/testing.js";
import { dropProjectMcpSchemaForRewind } from "./helpers/rewind.js";

it("upgrades existing registered users/projects and preserves encrypted MCP rows across repeated migration", () => {
  const db = createMigratedConnection();
  try {
    const registry = new ControlPlaneRegistry(db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 299999,
    });
    const user = registry.reserve("alice", 1);
    registry.environmentState(user.id, "ready");
    const host = upsertHost(db, noopNotifier, { name: "MCP migration" });
    const { project } = createControlPlaneProject(db, noopNotifier, {
      userId: user.id,
      hostId: host.id,
      name: "Existing",
      slug: "existing",
    });
    dropProjectMcpSchemaForRewind(db);
    const hash = createHash("sha256")
      .update(
        readFileSync(
          new URL(
            "../drizzle/0157_control_plane_project_mcp.sql",
            import.meta.url,
          ),
        ),
      )
      .digest("hex");
    expect(
      db.$client
        .prepare(
          "DELETE FROM __drizzle_migrations WHERE created_at >= (SELECT created_at FROM __drizzle_migrations WHERE hash = ?)",
        )
        .run(hash).changes,
    ).toBeGreaterThanOrEqual(1);
    migrate(db);
    expect(registry.reserve("alice", 2).uid).toBe(user.uid);
    const connector = createControlPlaneMcpConnector(db, {
      slug: "jira",
      name: "Jira",
      endpoint: "https://mcp.example/jira",
    });
    setControlPlaneMcpAccess(db, connector.id, user.id, true);
    const connection = configureControlPlaneMcpConnection(
      db,
      user.id,
      project.id,
      connector.id,
      1,
      0,
    );
    db.insert(controlPlaneMcpCredentials)
      .values({
        userId: user.id,
        connectorId: connector.id,
        connectorRevision: 1,
        revision: 1,
        ciphertext: "opaque-encrypted-storage",
        updatedAt: 1,
      })
      .run();
    migrate(db);
    migrate(db);
    expect(listControlPlaneMcpConnections(db, user.id, project.id)).toEqual([
      { ...connection, readiness: "configured" },
    ]);
    expect(db.select().from(controlPlaneMcpCredentials).get()?.ciphertext).toBe(
      "opaque-encrypted-storage",
    );
    expect(() =>
      db.update(controlPlaneMcpCredentials).set({ revision: 0 }).run(),
    ).toThrow();
    expect(db.select().from(controlPlaneMcpCredentials).get()?.revision).toBe(
      1,
    );
  } finally {
    db.$client.close();
  }
});
