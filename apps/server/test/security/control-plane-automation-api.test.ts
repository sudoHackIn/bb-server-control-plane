import { expect, it } from "vitest";
import {
  installedPlugins,
  createControlPlaneJobBinding,
  controlPlaneProjectAccess,
} from "@bb/db";
import { eq } from "drizzle-orm";
import {
  createControlPlaneAutomationService,
  createControlPlaneAutomationRpc,
} from "../../src/control-plane/automations.js";
import { withTestHarness } from "../helpers/test-app.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";

it("rejects a same-ID plugin without builtin provenance before calling it", async () => {
  await withTestHarness(async ({ db }) => {
    db.insert(installedPlugins)
      .values({
        id: "automations",
        source: "builtin:automations",
        rootDir: "/untrusted",
        version: "0.1.0",
        provenance: "direct",
        sourceKind: "builtin",
        sourceBuiltinName: "automations",
        installedAt: 1,
        updatedAt: 1,
      })
      .run();
    const rpc = createControlPlaneAutomationRpc(db, () => {
      throw new Error("Untrusted plugin invoked");
    });
    await expect(
      rpc("controlPlaneAutomationReads", { ids: ["id"] }),
    ).rejects.toMatchObject({ status: 503 });
  });
});
it("rechecks project visibility after an awaited RPC and rejects substituted native identities", async () => {
  await withTestHarness(async ({ db }) => {
    const { alice, bob } = seedControlPlaneJobSubjects(db);
    createControlPlaneJobBinding(db, {
      kind: "automation",
      objectId: "auto_test",
      revision: 1,
      userId: alice.user.id,
      projectId: alice.project.id,
      originThreadId: alice.thread.id,
      profileVersionId: alice.profile.versionId,
      sourceBindingId: null,
    });
    const value = {
      id: "auto_test",
      projectId: alice.project.id,
      createdByThreadId: alice.thread.id,
      name: "Test",
      enabled: true,
      revision: 1,
      execution: { mode: "agent", prompt: "owned prompt" },
      trigger: { triggerType: "once", runAt: 1000 },
      nextRunAt: 1000,
      lastRunAt: null,
      runCount: 0,
      lastRunStatus: null,
      lastRunThreadId: null,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    };
    for (const changed of [
      { id: "foreign" },
      { projectId: bob.project.id },
      { createdByThreadId: bob.thread.id },
    ]) {
      const service = createControlPlaneAutomationService(db, async () => [
        {
          ...value,
          ...changed,
        },
      ]);
      await expect(service.get(alice.user.id, value.id)).rejects.toMatchObject({
        status: 502,
      });
    }
    const duplicate = createControlPlaneAutomationService(db, async () => [
      value,
      value,
    ]);
    await expect(duplicate.get(alice.user.id, value.id)).rejects.toMatchObject({
      status: 502,
    });
    const history = createControlPlaneAutomationService(db, async (method) =>
      method === "controlPlaneAutomationReads"
        ? [value]
        : {
            runs: [
              {
                id: "run",
                automationId: "foreign",
                threadId: null,
                status: "skipped",
                trigger: "manual",
                skipReason: null,
                error: null,
                scheduledFor: 1,
                startedAt: 1,
                finishedAt: 1,
              },
            ],
            nextCursor: null,
          },
    );
    await expect(
      history.history(alice.user.id, value.id, { limit: 20 }),
    ).rejects.toMatchObject({ status: 502 });
    const revoked = createControlPlaneAutomationService(db, async () => {
      db.delete(controlPlaneProjectAccess)
        .where(eq(controlPlaneProjectAccess.projectId, alice.project.id))
        .run();
      return [value];
    });
    await expect(revoked.get(alice.user.id, value.id)).rejects.toMatchObject({
      status: 404,
    });
  });
});

it("omits orphaned native definitions and returns an opaque not-found result", async () => {
  await withTestHarness(async ({ db }) => {
    const { alice } = seedControlPlaneJobSubjects(db);
    createControlPlaneJobBinding(db, {
      kind: "automation",
      objectId: "reserved",
      revision: 1,
      userId: alice.user.id,
      projectId: alice.project.id,
      originThreadId: alice.thread.id,
      profileVersionId: alice.profile.versionId,
      sourceBindingId: null,
    });
    const service = createControlPlaneAutomationService(db, async () => []);
    expect(
      await service.list(alice.user.id, { cursor: null, limit: 20 }),
    ).toEqual({ automations: [], nextCursor: null });
    await expect(service.get(alice.user.id, "reserved")).rejects.toMatchObject({
      status: 404,
    });
  });
});
