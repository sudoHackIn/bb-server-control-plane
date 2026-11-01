import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createMigratedConnection } from "@bb/db/testing";
import {
  createControlPlaneJobBinding,
  publishControlPlaneProfileVersion,
  requireControlPlaneJobDispatch,
  requireControlPlaneJobWorkerProfile,
  setControlPlaneProfileAccess,
} from "@bb/db";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { createControlPlaneBackgroundJobs } from "../../src/control-plane/background-jobs.js";
import { withControlPlaneUser } from "../../src/control-plane/access.js";

it("checks pinned worker policy at resolution, binding, resume and result authority independently of user grants", async () => {
  const db = createMigratedConnection();
  try {
    const { alice, bob } = seedControlPlaneJobSubjects(db);
    setControlPlaneProfileAccess(
      db,
      bob.profile.profileId,
      alice.user.id,
      true,
    );
    const definition = {
      prompt: "Delegate only to the reviewed version",
      providerId: "qwen-server" as const,
      model: "qwen-test",
      reasoningLevel: "none" as const,
      permissionMode: "full" as const,
      tools: [],
      mcpServers: [],
    };
    const root = publishControlPlaneProfileVersion(
      db,
      alice.profile.profileId,
      {
        ...definition,
        delegation: { allowedVersionIds: [bob.profile.versionId] },
      },
    );
    const jobs = createControlPlaneBackgroundJobs(db, "workflows", true);
    const parent = await withControlPlaneUser(alice.user.id, () =>
      jobs.bind({
        ...alice.input,
        profileVersionId: root.id,
      }),
    );
    const worker = (versionId: string) =>
      createControlPlaneJobBinding(db, {
        ...alice.input,
        kind: "workflow-worker",
        userId: alice.user.id,
        objectId: randomUUID(),
        sourceBindingId: parent.id,
        profileVersionId: versionId,
      });
    withControlPlaneUser(alice.user.id, () => {
      expect(jobs.resolveWorkerProfile(parent.id, null).profileVersionId).toBe(
        root.id,
      );
      expect(
        jobs.resolveWorkerProfile(parent.id, bob.profile.versionId)
          .profileVersionId,
      ).toBe(bob.profile.versionId);
      expect(() =>
        jobs.resolveWorkerProfile(parent.id, alice.profile.versionId),
      ).toThrow("not authorized");
    });
    expect(() => worker(alice.profile.versionId)).toThrow("not authorized");
    const child = worker(bob.profile.versionId);
    expect(requireControlPlaneJobDispatch(db, child.id).user.id).toBe(
      alice.user.id,
    );
    const newTarget = publishControlPlaneProfileVersion(
      db,
      bob.profile.profileId,
      definition,
    );
    expect(() =>
      requireControlPlaneJobWorkerProfile(db, parent.id, newTarget.id),
    ).toThrow("not authorized");
    expect(() => worker(newTarget.id)).toThrow("not authorized");
    await withControlPlaneUser(bob.user.id, async () => {
      expect(() =>
        jobs.resolveWorkerProfile(parent.id, bob.profile.versionId),
      ).toThrow("not authorized");
    });
    setControlPlaneProfileAccess(
      db,
      bob.profile.profileId,
      alice.user.id,
      false,
    );
    expect(() =>
      requireControlPlaneJobWorkerProfile(db, parent.id, bob.profile.versionId),
    ).toThrow("not authorized");
    expect(() => requireControlPlaneJobDispatch(db, child.id)).toThrow(
      "not authorized",
    );
    setControlPlaneProfileAccess(
      db,
      bob.profile.profileId,
      alice.user.id,
      true,
    );
    expect(requireControlPlaneJobDispatch(db, child.id).binding.id).toBe(
      child.id,
    );
    const closed = publishControlPlaneProfileVersion(
      db,
      alice.profile.profileId,
      {
        ...definition,
        delegation: { allowedVersionIds: [] },
      },
    );
    const closedParent = await withControlPlaneUser(alice.user.id, () =>
      jobs.bind({
        ...alice.input,
        objectId: randomUUID(),
        profileVersionId: closed.id,
      }),
    );
    expect(
      requireControlPlaneJobWorkerProfile(db, closedParent.id, null)
        .profileVersion.id,
    ).toBe(closed.id);
    expect(() =>
      requireControlPlaneJobWorkerProfile(
        db,
        closedParent.id,
        bob.profile.versionId,
      ),
    ).toThrow("not authorized");
    expect(requireControlPlaneJobDispatch(db, child.id).binding.id).toBe(
      child.id,
    );
  } finally {
    db.$client.close();
  }
});
