import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ControlPlaneRegistry,
  createControlPlaneProject,
  controlPlaneProjectAccess,
  controlPlaneProjects,
  controlPlaneProjectPolicies,
  controlPlaneUsers,
  getControlPlaneProjectAccessPolicy,
  acknowledgeControlPlaneProjectAccessPolicy,
  hosts,
  projects,
  projectSources,
  migrate,
  noopNotifier,
  upsertHost,
} from "../src/index.js";
import { createMigratedConnection } from "../src/testing.js";
import { dropProjectPolicySchemaForRewind } from "./helpers/rewind.js";

function fixture() {
  const db = createMigratedConnection();
  const registry = new ControlPlaneRegistry(db, {
    usersRoot: "/srv/users",
    firstUid: 200000,
    lastUid: 299999,
  });
  const alice = registry.reserve("policy-alice", 1),
    bob = registry.reserve("policy-bob", 1),
    charlie = registry.reserve("policy-charlie", 1);
  for (const user of [alice, bob, charlie])
    registry.environmentState(user.id, "ready");
  const host = upsertHost(db, noopNotifier, { name: "Policy host" });
  const { project } = createControlPlaneProject(db, noopNotifier, {
    userId: alice.id,
    hostId: host.id,
    name: "Shared",
    slug: "shared",
  });
  const policy = () => {
    const row = getControlPlaneProjectAccessPolicy(db, project.id);
    if (!row) throw new Error("Missing policy");
    return row;
  };
  const grant = (role: "runner" | "viewer" | "owner") =>
    db
      .insert(controlPlaneProjectAccess)
      .values({ projectId: project.id, userId: bob.id, role })
      .onConflictDoUpdate({
        target: [
          controlPlaneProjectAccess.projectId,
          controlPlaneProjectAccess.userId,
        ],
        set: { role },
      })
      .run();
  return { db, registry, alice, bob, charlie, host, project, policy, grant };
}
let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
afterEach(() => f.db.$client.close());

it("derives registered runner identities, excluding viewers, disabled users and forged owners", () => {
  expect(f.policy().members).toEqual([]);
  f.grant("viewer");
  expect(f.policy().members).toEqual([]);
  f.grant("owner");
  expect(f.policy().members).toEqual([]);
  f.grant("runner");
  expect(f.policy().members.map((u) => [u.id, u.uid, u.home])).toEqual([
    [f.bob.id, f.bob.uid, f.bob.home],
  ]);
  f.db
    .update(controlPlaneUsers)
    .set({ enabled: false })
    .where(eq(controlPlaneUsers.id, f.bob.id))
    .run();
  expect(f.policy().members).toEqual([]);
  f.db
    .update(controlPlaneUsers)
    .set({ enabled: true, environmentStatus: "failed" })
    .where(eq(controlPlaneUsers.id, f.bob.id))
    .run();
  expect(f.policy().members).toEqual([]);
});

it("fences stale acknowledgement and tracks direct SQL grant mutation, removal and regrant", () => {
  const initial = f.policy().revision;
  expect(
    acknowledgeControlPlaneProjectAccessPolicy(f.db, f.project.id, initial),
  ).toBe(true);
  f.grant("runner");
  const granted = f.policy().revision;
  expect(granted).toBeGreaterThan(initial);
  expect(
    acknowledgeControlPlaneProjectAccessPolicy(f.db, f.project.id, initial),
  ).toBe(false);
  expect(f.policy().appliedRevision).toBe(initial);
  f.db.$client
    .prepare(
      "UPDATE control_plane_project_access SET role = 'viewer' WHERE project_id = ? AND user_id = ?",
    )
    .run(f.project.id, f.bob.id);
  expect(f.policy().revision).toBeGreaterThan(granted);
  expect(f.policy().members).toEqual([]);
  const beforeDelete = f.policy().revision;
  f.db
    .delete(controlPlaneProjectAccess)
    .where(
      and(
        eq(controlPlaneProjectAccess.projectId, f.project.id),
        eq(controlPlaneProjectAccess.userId, f.bob.id),
      ),
    )
    .run();
  expect(f.policy().revision).toBeGreaterThan(beforeDelete);
  f.grant("runner");
  const current = f.policy();
  expect(
    acknowledgeControlPlaneProjectAccessPolicy(
      f.db,
      f.project.id,
      current.revision,
    ),
  ).toBe(true);
  expect(f.policy().appliedRevision).toBe(current.revision);
});

it("does not change policy for unrelated users, display edits or no-op grant writes", () => {
  f.grant("runner");
  const revision = f.policy().revision;
  f.grant("runner");
  f.db
    .update(controlPlaneUsers)
    .set({ enabled: false })
    .where(eq(controlPlaneUsers.id, f.charlie.id))
    .run();
  f.db
    .update(projects)
    .set({ name: "Renamed" })
    .where(eq(projects.id, f.project.id))
    .run();
  expect(f.policy().revision).toBe(revision);
});

describe.each([
  "enabled",
  "environment",
  "identity",
  "home",
  "owner-grant",
  "source",
  "ownership",
  "host",
  "project",
])("invalidates %s authority", (kind) => {
  it("advances the desired revision before an old apply can be acknowledged", () => {
    f.grant("runner");
    const before = f.policy().revision;
    switch (kind) {
      case "enabled":
        f.db
          .update(controlPlaneUsers)
          .set({ enabled: false })
          .where(eq(controlPlaneUsers.id, f.alice.id))
          .run();
        break;
      case "environment":
        f.db
          .update(controlPlaneUsers)
          .set({ environmentStatus: "failed" })
          .where(eq(controlPlaneUsers.id, f.alice.id))
          .run();
        break;
      case "identity":
        f.db
          .update(controlPlaneUsers)
          .set({ uid: 250000, gid: 250000 })
          .where(eq(controlPlaneUsers.id, f.bob.id))
          .run();
        break;
      case "home":
        f.db
          .update(controlPlaneUsers)
          .set({ home: "/srv/changed-home" })
          .where(eq(controlPlaneUsers.id, f.bob.id))
          .run();
        break;
      case "owner-grant":
        f.db
          .update(controlPlaneProjectAccess)
          .set({ role: "viewer" })
          .where(
            and(
              eq(controlPlaneProjectAccess.projectId, f.project.id),
              eq(controlPlaneProjectAccess.userId, f.alice.id),
            ),
          )
          .run();
        break;
      case "source":
        f.db
          .update(projectSources)
          .set({ path: "/srv/another-project" })
          .where(eq(projectSources.projectId, f.project.id))
          .run();
        break;
      case "ownership":
        f.db
          .update(projectSources)
          .set({ ownsPath: true })
          .where(eq(projectSources.projectId, f.project.id))
          .run();
        break;
      case "host":
        f.db
          .update(hosts)
          .set({ destroyedAt: 2 })
          .where(eq(hosts.id, f.host.id))
          .run();
        break;
      case "project":
        f.db
          .update(projects)
          .set({ deletedAt: 2 })
          .where(eq(projects.id, f.project.id))
          .run();
        break;
    }
    expect(f.policy().revision).toBeGreaterThan(before);
    expect(
      acknowledgeControlPlaneProjectAccessPolicy(f.db, f.project.id, before),
    ).toBe(false);
    if (kind !== "identity" && kind !== "home")
      expect(f.policy().members).toEqual([]);
  });
});

it("invalidates both scopes when a grant moves and preserves rollback", () => {
  const other = createControlPlaneProject(f.db, noopNotifier, {
    userId: f.alice.id,
    hostId: f.host.id,
    name: "Other",
    slug: "other",
  }).project;
  f.grant("runner");
  const original = f.policy().revision;
  const otherRevision = getControlPlaneProjectAccessPolicy(
    f.db,
    other.id,
  )?.revision;
  expect(() =>
    f.db.transaction((tx) => {
      tx.update(controlPlaneProjectAccess)
        .set({ projectId: other.id })
        .where(
          and(
            eq(controlPlaneProjectAccess.projectId, f.project.id),
            eq(controlPlaneProjectAccess.userId, f.bob.id),
          ),
        )
        .run();
      throw new Error("Rollback");
    }),
  ).toThrow("Rollback");
  expect(f.policy().revision).toBe(original);
  f.db
    .update(controlPlaneProjectAccess)
    .set({ projectId: other.id })
    .where(
      and(
        eq(controlPlaneProjectAccess.projectId, f.project.id),
        eq(controlPlaneProjectAccess.userId, f.bob.id),
      ),
    )
    .run();
  expect(f.policy().revision).toBeGreaterThan(original);
  expect(
    getControlPlaneProjectAccessPolicy(f.db, other.id)?.revision,
  ).toBeGreaterThan(otherRevision ?? 0);
  expect(f.policy().members).toEqual([]);
});

it("refuses revision overflow without changing the authority or accepting an unsafe receipt", () => {
  f.db
    .update(controlPlaneProjectPolicies)
    .set({ revision: Number.MAX_SAFE_INTEGER })
    .where(eq(controlPlaneProjectPolicies.projectId, f.project.id))
    .run();
  expect(() => f.grant("runner")).toThrow();
  expect(f.policy().members).toEqual([]);
  expect(() =>
    acknowledgeControlPlaneProjectAccessPolicy(
      f.db,
      f.project.id,
      Number.MAX_SAFE_INTEGER + 1,
    ),
  ).toThrow();
});

it("backfills old registered projects and preserves applied revisions across repeated migration", () => {
  f.grant("runner");
  dropProjectPolicySchemaForRewind(f.db);
  const hash = createHash("sha256")
    .update(
      readFileSync(new URL("../drizzle/0159_misty_veda.sql", import.meta.url)),
    )
    .digest("hex");
  expect(
    f.db.$client
      .prepare(
        "DELETE FROM __drizzle_migrations WHERE created_at >= (SELECT created_at FROM __drizzle_migrations WHERE hash = ?)",
      )
      .run(hash).changes,
  ).toBeGreaterThanOrEqual(1);
  migrate(f.db);
  expect(f.policy().revision).toBe(1);
  expect(f.policy().members.map((u) => u.id)).toEqual([f.bob.id]);
  expect(
    acknowledgeControlPlaneProjectAccessPolicy(f.db, f.project.id, 1),
  ).toBe(true);
  migrate(f.db);
  expect(f.policy().appliedRevision).toBe(1);
  f.db
    .delete(projectSources)
    .where(eq(projectSources.projectId, f.project.id))
    .run();
  expect(f.policy().revision).toBeGreaterThan(1);
  expect(f.policy().members).toEqual([]);
});

it("keeps missing policy bindings closed and advances immutable association changes", () => {
  f.grant("runner");
  const before = f.policy().revision;
  f.db
    .update(controlPlaneProjects)
    .set({ slug: "renamed" })
    .where(eq(controlPlaneProjects.projectId, f.project.id))
    .run();
  expect(f.policy().revision).toBeGreaterThan(before);
  expect(f.policy().members).toEqual([]);
  expect(getControlPlaneProjectAccessPolicy(f.db, "missing")).toBeNull();
  expect(acknowledgeControlPlaneProjectAccessPolicy(f.db, "missing", 1)).toBe(
    false,
  );
});
