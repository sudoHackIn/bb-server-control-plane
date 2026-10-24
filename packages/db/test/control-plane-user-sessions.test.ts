import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createMigratedConnection } from "../src/testing.js";
import { ControlPlaneRegistry } from "../src/data/control-plane.js";
import { controlPlaneUsers, controlPlaneUserSessions } from "../src/schema.js";

function fixture() {
  const db = createMigratedConnection();
  const registry = new ControlPlaneRegistry(db, {
    usersRoot: "/srv/users",
    firstUid: 200000,
    lastUid: 200010,
  });
  return {
    db,
    registry,
    alice: registry.reserve("alice", 1),
    bob: registry.reserve("bob", 1),
  };
}
it("rotates the previous browser credential across identities without changing their allocated homes", () => {
  const { db, registry, alice, bob } = fixture();
  try {
    expect(registry.createSession(alice.id, "first-digest", 100, 1, null)).toBe(
      true,
    );
    expect(
      registry.createSession(bob.id, "second-digest", 100, 2, "first-digest"),
    ).toBe(true);
    expect(registry.authenticate("first-digest", 3)).toBeUndefined();
    expect(registry.authenticate("second-digest", 3)?.user.id).toBe(bob.id);
    expect(registry.reserve("alice", 4).home).toBe(alice.home);
    expect(registry.reserve("bob", 4).uid).toBe(bob.uid);
    expect(registry.authenticate("second-digest", 100)).toBeUndefined();
    expect(
      registry.createSession(alice.id, "third-digest", 200, 101, null),
    ).toBe(true);
    expect(db.select().from(controlPlaneUserSessions).all()).toHaveLength(1);
  } finally {
    db.$client.close();
  }
});
it("does not retire an existing session when the target is missing, disabled or already expired", () => {
  const { db, registry, alice, bob } = fixture();
  try {
    registry.createSession(bob.id, "existing-digest", 100, 1, null);
    db.update(controlPlaneUsers)
      .set({ enabled: false })
      .where(eq(controlPlaneUsers.id, alice.id))
      .run();
    expect(
      registry.createSession(
        alice.id,
        "disabled-digest",
        100,
        2,
        "existing-digest",
      ),
    ).toBe(false);
    expect(
      registry.createSession(
        "missing-user",
        "missing-digest",
        100,
        2,
        "existing-digest",
      ),
    ).toBe(false);
    expect(
      registry.createSession(bob.id, "expired-digest", 2, 2, "existing-digest"),
    ).toBe(false);
    expect(registry.authenticate("existing-digest", 3)?.user.id).toBe(bob.id);
  } finally {
    db.$client.close();
  }
});
it("rolls back previous-credential revocation when issuing the new session fails", () => {
  const { db, registry, alice, bob } = fixture();
  try {
    registry.createSession(alice.id, "alice-digest", 100, 1, null);
    registry.createSession(bob.id, "bob-digest", 100, 1, null);
    expect(() =>
      registry.createSession(alice.id, "bob-digest", 100, 2, "alice-digest"),
    ).toThrow();
    expect(registry.authenticate("alice-digest", 3)?.user.id).toBe(alice.id);
    expect(registry.authenticate("bob-digest", 3)?.user.id).toBe(bob.id);
  } finally {
    db.$client.close();
  }
});
