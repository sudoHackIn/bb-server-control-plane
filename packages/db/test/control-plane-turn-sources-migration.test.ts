import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createMigratedConnection } from "../src/testing.js";
import {
  ControlPlaneRegistry,
  createControlPlaneProject,
  createControlPlaneProfile,
  createControlPlaneJobBinding,
  createThread,
  controlPlaneJobNotifications,
  controlPlaneTurnSources,
  migrate,
  noopNotifier,
  setControlPlaneProfileAccess,
  threads,
  upsertHost,
} from "../src/index.js";

it("upgrades a real legacy notification without inventing a request reference and preserves new source rows on repeated migration", () => {
  const db = createMigratedConnection();
  try {
    const registry = new ControlPlaneRegistry(db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 299999,
    });
    const user = registry.reserve("alice", 1);
    registry.environmentState(user.id, "ready");
    const host = upsertHost(db, noopNotifier, { name: "Migration fixture" });
    const { project } = createControlPlaneProject(db, noopNotifier, {
      userId: user.id,
      hostId: host.id,
      name: "Project",
      slug: "app",
    });
    const profile = createControlPlaneProfile(db, {
      slug: "profile",
      name: "Profile",
      definition: {
        prompt: "Fixture",
        providerId: "qwen-server",
        model: "qwen-test",
        reasoningLevel: "none",
        permissionMode: "full",
        tools: [],
        mcpServers: [],
      },
    });
    setControlPlaneProfileAccess(db, profile.profileId, user.id, true);
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "qwen-server",
      controlPlaneOwnerUserId: user.id,
      controlPlaneProfileVersionId: profile.versionId,
    });
    const binding = createControlPlaneJobBinding(db, {
      userId: user.id,
      kind: "workflow-run",
      objectId: randomUUID(),
      revision: 1,
      projectId: project.id,
      profileVersionId: profile.versionId,
      originThreadId: thread.id,
      sourceBindingId: null,
    });
    db.$client.exec(
      "DROP TABLE control_plane_turn_sources; DROP INDEX control_plane_job_notifications_request_idx; ALTER TABLE control_plane_job_notifications DROP COLUMN request_id; DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations);",
    );
    db.$client
      .prepare(
        "INSERT INTO control_plane_job_notifications (binding_id,thread_id,accepted_at) VALUES (?,?,?)",
      )
      .run(binding.id, thread.id, 1234);
    migrate(db);
    expect(db.select().from(controlPlaneJobNotifications).get()).toEqual({
      bindingId: binding.id,
      threadId: thread.id,
      acceptedAt: 1234,
      requestId: null,
    });
    expect(db.select().from(controlPlaneTurnSources).all()).toEqual([]);
    db.insert(controlPlaneTurnSources)
      .values({
        threadId: thread.id,
        requestId: "request-new",
        sourceRequestId: "request-source",
      })
      .run();
    migrate(db);
    expect(db.select().from(controlPlaneTurnSources).get()).toEqual({
      threadId: thread.id,
      requestId: "request-new",
      sourceRequestId: "request-source",
    });
    expect(() =>
      db
        .insert(controlPlaneTurnSources)
        .values({
          threadId: thread.id,
          requestId: "request-new",
          sourceRequestId: null,
        })
        .run(),
    ).toThrow();
    db.delete(threads).where(eq(threads.id, thread.id)).run();
    expect(db.select().from(controlPlaneTurnSources).all()).toEqual([]);
  } finally {
    db.$client.close();
  }
});
