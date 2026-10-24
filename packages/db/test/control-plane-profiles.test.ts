import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import type { ControlPlaneProfileDefinition } from "@bb/domain";
import { createMigratedConnection } from "../src/testing.js";
import {
  ControlPlaneRegistry,
  ControlPlaneProfileError,
  createControlPlaneProfile,
  publishControlPlaneProfileVersion,
  getControlPlaneProfile,
  listControlPlaneProfiles,
  listControlPlaneProfileVersions,
  setControlPlaneProfileAccess,
  setControlPlaneProfileEnabled,
  controlPlaneUsers,
  controlPlaneProfiles,
  controlPlaneProfileVersions,
  createConnection,
} from "../src/index.js";

const definition: ControlPlaneProfileDefinition = {
  prompt: "Approved instructions",
  providerId: "qwen-server",
  model: "qwen-test",
  reasoningLevel: "none",
  permissionMode: "full",
  tools: ["read_file"],
  mcpServers: ["approved-server"],
};

it("preserves immutable definitions, scopes grants and old versions, and applies profile/version/user revocation", () => {
  const db = createMigratedConnection();
  try {
    const registry = new ControlPlaneRegistry(db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 299999,
    });
    const alice = registry.reserve("alice", 1),
      bob = registry.reserve("bob", 1);
    const first = createControlPlaneProfile(db, {
      slug: "review",
      name: "Review",
      definition,
    });
    const other = createControlPlaneProfile(db, {
      slug: "other",
      name: "Other",
      definition,
    });
    expect(
      listControlPlaneProfiles(db, alice.id, { cursor: null, limit: 50 })
        .profiles,
    ).toEqual([]);
    setControlPlaneProfileAccess(db, first.profileId, alice.id, true);
    const second = publishControlPlaneProfileVersion(db, first.profileId, {
      ...definition,
      prompt: "New instructions",
      tools: [],
    });
    const third = publishControlPlaneProfileVersion(db, first.profileId, {
      ...definition,
      model: "next-model",
    });
    expect([second.version, third.version]).toEqual([2, 3]);
    expect(
      getControlPlaneProfile(db, alice.id, first.profileId, first.versionId)
        ?.version.definition,
    ).toEqual(definition);
    expect(getControlPlaneProfile(db, bob.id, first.profileId)).toBeNull();
    expect(
      getControlPlaneProfile(db, alice.id, first.profileId, other.versionId),
    ).toBeNull();
    expect(getControlPlaneProfile(db, alice.id, other.profileId)).toBeNull();
    const page = listControlPlaneProfileVersions(
      db,
      alice.id,
      first.profileId,
      { cursor: null, limit: 2 },
    );
    expect(page.versions.map((version) => version.version)).toEqual([3, 2]);
    expect(page.nextCursor).toBe(2);
    expect(
      listControlPlaneProfileVersions(db, alice.id, first.profileId, {
        cursor: page.nextCursor,
        limit: 2,
      }).versions.map((version) => version.version),
    ).toEqual([1]);
    setControlPlaneProfileEnabled(db, first.profileId, false, third.id);
    expect(
      getControlPlaneProfile(db, alice.id, first.profileId)?.version.id,
    ).toBe(second.id);
    expect(
      getControlPlaneProfile(db, alice.id, first.profileId, third.id),
    ).toBeNull();
    expect(getControlPlaneProfile(db, null, first.profileId)?.version.id).toBe(
      third.id,
    );
    setControlPlaneProfileEnabled(db, first.profileId, false);
    expect(
      getControlPlaneProfile(db, alice.id, first.profileId, first.versionId),
    ).toBeNull();
    setControlPlaneProfileEnabled(db, first.profileId, true);
    setControlPlaneProfileAccess(db, first.profileId, alice.id, false);
    expect(getControlPlaneProfile(db, alice.id, first.profileId)).toBeNull();
    setControlPlaneProfileAccess(db, first.profileId, alice.id, true);
    db.update(controlPlaneUsers)
      .set({ enabled: false })
      .where(eq(controlPlaneUsers.id, alice.id))
      .run();
    expect(getControlPlaneProfile(db, alice.id, first.profileId)).toBeNull();
    const restored = createConnection(db.$client.serialize());
    try {
      expect(
        getControlPlaneProfile(restored, null, first.profileId, first.versionId)
          ?.version.definition,
      ).toEqual(definition);
    } finally {
      restored.$client.close();
    }
  } finally {
    db.$client.close();
  }
});

it("rolls back invalid publications and duplicate profiles, and rejects foreign version mutation", () => {
  const db = createMigratedConnection();
  try {
    const invalid = {
      slug: "invalid",
      name: "Invalid",
      definition: { ...definition, apiKey: "not-a-profile-field" },
    };
    expect(() => createControlPlaneProfile(db, invalid)).toThrow();
    expect(db.select().from(controlPlaneProfiles).all()).toEqual([]);
    const first = createControlPlaneProfile(db, {
      slug: "one",
      name: "One",
      definition,
    });
    const second = createControlPlaneProfile(db, {
      slug: "two",
      name: "Two",
      definition,
    });
    expect(() =>
      createControlPlaneProfile(db, {
        slug: "one",
        name: "Duplicate",
        definition,
      }),
    ).toThrow();
    expect(() =>
      publishControlPlaneProfileVersion(db, randomUUID(), definition),
    ).toThrow(ControlPlaneProfileError);
    expect(() =>
      setControlPlaneProfileEnabled(
        db,
        first.profileId,
        false,
        second.versionId,
      ),
    ).toThrow(ControlPlaneProfileError);
    expect(() =>
      setControlPlaneProfileAccess(db, first.profileId, randomUUID(), true),
    ).toThrow(ControlPlaneProfileError);
    expect(db.select().from(controlPlaneProfiles).all()).toHaveLength(2);
    expect(db.select().from(controlPlaneProfileVersions).all()).toHaveLength(2);
    expect(
      getControlPlaneProfile(db, null, second.profileId)?.version.enabled,
    ).toBe(true);
    const page = listControlPlaneProfiles(db, null, { cursor: null, limit: 1 });
    expect(page.profiles).toHaveLength(1);
    expect(page.nextCursor).toBe(page.profiles[0]?.id);
    expect(
      listControlPlaneProfiles(db, null, { cursor: page.nextCursor, limit: 1 })
        .profiles[0]?.id,
    ).not.toBe(page.nextCursor);
  } finally {
    db.$client.close();
  }
});
