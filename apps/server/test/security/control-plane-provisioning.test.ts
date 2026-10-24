import { eq } from "drizzle-orm";
import {
  ControlPlaneRegistry,
  controlPlaneUsers,
  type ControlPlaneUser,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { expect, it } from "vitest";
import { createControlPlaneProvisioner } from "../../src/control-plane/provisioning.js";

const prepared = (user: ControlPlaneUser) => ({
  userId: user.id,
  uid: user.uid,
  gid: user.gid,
  home: user.home,
  projectsRoot: user.projectsRoot,
  cwd: `${user.projectsRoot}/default`,
});

it("deduplicates concurrent provisioning, rejects a different helper identity and permits recovery with the same UID", async () => {
  const db = createMigratedConnection();
  try {
    const registry = new ControlPlaneRegistry(db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 299999,
    });
    const alice = registry.reserve("alice", 1);
    let calls = 0;
    let fail = true;
    const provision = createControlPlaneProvisioner(registry, async (user) => {
      calls++;
      await Promise.resolve();
      return { ...prepared(user), uid: fail ? user.uid + 1 : user.uid };
    });
    const first = provision(alice);
    expect(provision(alice)).toBe(first);
    await expect(first).rejects.toThrow("provisioning failed");
    expect(calls).toBe(1);
    expect(registry.user("alice")?.environmentStatus).toBe("failed");
    fail = false;
    await expect(provision(alice)).resolves.toMatchObject({
      uid: alice.uid,
      id: alice.id,
      environmentStatus: "ready",
    });
    expect(calls).toBe(2);
  } finally {
    db.$client.close();
  }
});

it("does not admit disabled users or mark an environment ready after revocation during provisioning", async () => {
  const db = createMigratedConnection();
  try {
    const registry = new ControlPlaneRegistry(db, {
      usersRoot: "/srv/users",
      firstUid: 200000,
      lastUid: 299999,
    });
    const alice = registry.reserve("alice", 1);
    const provision = createControlPlaneProvisioner(registry, async (user) => {
      db.update(controlPlaneUsers)
        .set({ enabled: false })
        .where(eq(controlPlaneUsers.id, user.id))
        .run();
      return prepared(user);
    });
    await expect(provision(alice)).rejects.toThrow("provisioning failed");
    expect(registry.user("alice")?.environmentStatus).not.toBe("ready");
    await expect(provision(alice)).rejects.toThrow("disabled");
  } finally {
    db.$client.close();
  }
});
