import { expect, it, vi, onTestFinished } from "vitest";
import { eq } from "drizzle-orm";
import {
  environments,
  getEnvironment,
  projectSources,
  controlPlaneUsers,
  threads,
} from "@bb/db";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import { validatePluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { controlPlaneEnvironmentProviderRefusal } from "../../src/control-plane/environment-provider-authority.js";
import {
  advanceEnvironmentProvisioning,
  sweepProviderEnvironment,
  sweepProviderLifecycles,
  cleanupEnvironment,
  recoverEnvironmentCleanup,
  type ProviderOperationContext,
} from "../../src/services/environments/environment-engine.js";
import {
  completeProviderSelection,
  resolveProviderOperationContext,
  prepareProviderEnvironment,
} from "../../src/services/threads/thread-environment-placement.js";
import {
  environmentProviderMatchesContext,
  resolvePluginEnvironmentProviderAvailability,
} from "../../src/services/environments/provider-availability.js";
import { setPluginEnvironmentProviderBridge } from "../../src/services/plugins/plugin-environment-provider-registry.js";
import { requirePublicProject } from "../../src/services/lib/entity-lookup.js";
import { toThreadResponseFromThread } from "../../src/services/threads/thread-runtime-display.js";
import { toEnvironmentResponse } from "../../src/services/environments/environment-response.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { installDefaultEnvironmentProviders } from "../helpers/environment-provider.js";
import {
  seedProjectWithSource,
  seedEnvironment,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function provider(beforeInvoke: () => void = () => {}) {
  const create = vi.fn(async () => ({
    status: "created" as const,
    path: "/tmp/provider-workspace",
    ownsPath: true,
  }));
  const restore = vi.fn(async () => ({
    status: "created" as const,
    path: "/tmp/provider-workspace",
    ownsPath: true,
  }));
  const remove = vi.fn(async () => ({ status: "removed" as const }));
  const availability = vi.fn(() => ({ status: "available" as const }));
  const record = {
    pluginId: "fixture-provider",
    provider: validatePluginEnvironmentProviderDeclaration({
      id: "fixture-provider",
      displayName: "Fixture",
      description: "Lifecycle authority",
      icon: "Folder",
      create,
      restore,
      remove,
      availability,
      policy: { retireGraceMs: 0 },
    }),
  };
  setPluginEnvironmentProviderBridge({
    listEnvironmentProviders: () => [record],
    getEnvironmentProvider: (id) =>
      id === record.provider.id ? record : undefined,
    invokeProvider: async (_pluginId, _label, run) => {
      beforeInvoke();
      return { ok: true, value: await run() };
    },
    decisionTimeoutMs: 10000,
  });
  onTestFinished(installDefaultEnvironmentProviders);
  return { record, create, restore, remove, availability };
}

function context(
  harness: TestAppHarness,
  thread: ReturnType<typeof seedThread>,
  environment: ReturnType<typeof seedEnvironment> | null = null,
): ProviderOperationContext {
  return {
    thread: toThreadResponseFromThread(harness.deps, { thread }),
    project: requirePublicProject(harness.db, thread.projectId),
    host: makeHost({
      id: thread.environmentId
        ? getEnvironment(harness.db, thread.environmentId)!.hostId
        : "unused",
    }),
    machine: {
      type: "existing",
      hostId: thread.environmentId
        ? getEnvironment(harness.db, thread.environmentId)!.hostId
        : "unused",
    },
    projectCheckout: null,
    gitRemote: null,
    inputs: null,
    suggestedBranchName: "bb/fixture",
    environment: environment
      ? toEnvironmentResponse(harness.db, environment)
      : null,
  };
}

it("refuses managed and aliased registered directories independently of user availability", async () => {
  await withTestHarness(async (harness) => {
    const { alice, bob } = seedControlPlaneJobSubjects(harness.db);
    const { project, source } = seedProjectWithSource(harness.deps, {
      hostId: alice.environment.hostId,
      path: "/tmp/operator",
    });
    expect(
      controlPlaneEnvironmentProviderRefusal(harness.db, project.id),
    ).toBeNull();
    for (const path of [
      alice.user.home,
      alice.user.projectsRoot,
      `${bob.user.projectsRoot}/unknown`,
      `${alice.user.home}/../projects/unknown`,
    ])
      expect(
        controlPlaneEnvironmentProviderRefusal(harness.db, project.id, [path]),
      ).toBeTruthy();
    harness.db
      .update(projectSources)
      .set({ path: `${bob.user.projectsRoot}/unknown` })
      .where(eq(projectSources.id, source.id))
      .run();
    expect(
      controlPlaneEnvironmentProviderRefusal(harness.db, project.id),
    ).toBeTruthy();
    harness.db
      .update(controlPlaneUsers)
      .set({ enabled: false })
      .where(eq(controlPlaneUsers.id, alice.user.id))
      .run();
    expect(
      controlPlaneEnvironmentProviderRefusal(harness.db, alice.project.id),
    ).toBeTruthy();
  });
});

it("blocks managed selection, preparation, recovery context and availability before plugin invocation", async () => {
  await withTestHarness(async (harness) => {
    const { alice } = seedControlPlaneJobSubjects(harness.db);
    const probe = provider();
    const selection = {
      machine: { type: "existing" as const, hostId: alice.environment.hostId },
      inputs: null,
    };
    await expect(
      completeProviderSelection(
        harness.deps,
        probe.record,
        alice.project.id,
        selection,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      resolveProviderOperationContext(
        harness.deps,
        alice.thread,
        {
          type: "provider",
          environmentProviderId: probe.record.provider.id,
          ...selection,
          selectionResolved: true,
        },
        probe.record,
      ),
    ).rejects.toMatchObject({ status: 403 });
    const operation = context(harness, alice.thread);
    expect(() =>
      prepareProviderEnvironment(harness.deps, probe.record, operation),
    ).toThrow("not authorized");
    expect(
      environmentProviderMatchesContext(harness.deps, probe.record, {
        projectId: alice.project.id,
      }),
    ).toBe(false);
    await expect(
      resolvePluginEnvironmentProviderAvailability(
        harness.deps,
        probe.record,
        operation,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(probe.availability).not.toHaveBeenCalled();
    expect(probe.create).not.toHaveBeenCalled();
  });
});

it.each([false, true])(
  "quarantines legacy creation without invoking create/restore (previous=%s)",
  async (previous) => {
    await withTestHarness(async (harness) => {
      const { alice } = seedControlPlaneJobSubjects(harness.db);
      const probe = provider();
      const older = previous
        ? seedEnvironment(harness.deps, {
            hostId: alice.environment.hostId,
            projectId: alice.project.id,
            path: `${alice.user.projectsRoot}/old`,
            status: "destroyed",
            environmentProviderId: probe.record.provider.id,
            environmentProviderPluginId: probe.record.pluginId,
          })
        : null;
      harness.db
        .update(environments)
        .set({
          status: "creating",
          environmentProviderId: probe.record.provider.id,
          environmentProviderPluginId: probe.record.pluginId,
          resource: { retained: true },
        })
        .where(eq(environments.id, alice.environment.id))
        .run();
      if (previous) await sweepProviderLifecycles(harness.deps);
      for (let attempt = 0; attempt < 2; attempt++)
        await advanceEnvironmentProvisioning(harness.deps, {
          environmentId: alice.environment.id,
          creation: {
            record: probe.record,
            context: context(harness, alice.thread, older),
          },
        });
      const row = getEnvironment(harness.db, alice.environment.id)!;
      expect(row).toMatchObject({
        status: "error",
        path: alice.environment.path,
        resource: { retained: true },
        environmentProviderId: probe.record.provider.id,
      });
      expect(row.statusMessage).toContain("Needs operator review");
      expect(probe.create).not.toHaveBeenCalled();
      expect(probe.restore).not.toHaveBeenCalled();
    });
  },
);

it("quarantines periodic removal and refuses explicit recovery without discarding resources or consuming retries", async () => {
  await withTestHarness(async (harness) => {
    const { alice } = seedControlPlaneJobSubjects(harness.db);
    const probe = provider();
    harness.db
      .update(environments)
      .set({
        environmentProviderId: probe.record.provider.id,
        environmentProviderPluginId: probe.record.pluginId,
        providerOwnsPath: true,
        claimPath: alice.environment.path,
        resource: { retained: true },
        retireAt: 1,
      })
      .where(eq(environments.id, alice.environment.id))
      .run();
    harness.db
      .update(threads)
      .set({ archivedAt: 1 })
      .where(eq(threads.id, alice.thread.id))
      .run();
    await sweepProviderEnvironment(harness.deps, alice.environment.id);
    const before = getEnvironment(harness.db, alice.environment.id)!;
    expect(before).toMatchObject({
      path: alice.environment.path,
      claimPath: alice.environment.path,
      teardownStatus: "failed",
      retireAt: null,
      teardownAttempt: 0,
      resource: { retained: true },
    });
    expect(before.teardownMessage).toContain("Needs operator review");
    await sweepProviderLifecycles(harness.deps);
    expect(() =>
      cleanupEnvironment(harness.deps, alice.environment.id),
    ).toThrow();
    await expect(
      recoverEnvironmentCleanup(harness.deps, alice.environment.id),
    ).rejects.toThrow();
    expect(getEnvironment(harness.db, alice.environment.id)).toEqual(before);
    expect(probe.remove).not.toHaveBeenCalled();
  });
});

it.each([false, true])(
  "rechecks persisted namespace at actual plugin create/restore callback after bridge wait (restore=%s)",
  async (restoring) => {
    await withTestHarness(async (harness) => {
      const { alice } = seedControlPlaneJobSubjects(harness.db);
      const { project, source } = seedProjectWithSource(harness.deps, {
        hostId: alice.environment.hostId,
        path: "/tmp/operator",
      });
      const probe = provider(() => {
        harness.db
          .update(projectSources)
          .set({ path: alice.environment.path })
          .where(eq(projectSources.id, source.id))
          .run();
      });
      const environment = seedEnvironment(harness.deps, {
        projectId: project.id,
        hostId: alice.environment.hostId,
        path: "/tmp/operator-target",
        status: "creating",
        environmentProviderId: probe.record.provider.id,
        environmentProviderPluginId: probe.record.pluginId,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "starting",
      });
      const previous = restoring
        ? seedEnvironment(harness.deps, {
            hostId: alice.environment.hostId,
            projectId: project.id,
            path: "/tmp/operator-previous",
            status: "destroyed",
            environmentProviderId: probe.record.provider.id,
            environmentProviderPluginId: probe.record.pluginId,
          })
        : null;
      await advanceEnvironmentProvisioning(harness.deps, {
        environmentId: environment.id,
        creation: {
          record: probe.record,
          context: context(harness, thread, previous),
        },
      });
      await expect
        .poll(() => getEnvironment(harness.db, environment.id)?.status)
        .toBe("error");
      expect(
        harness.db
          .select({ path: projectSources.path })
          .from(projectSources)
          .where(eq(projectSources.id, source.id))
          .get()?.path,
      ).toBe(alice.environment.path);
      expect(probe.create).not.toHaveBeenCalled();
      expect(probe.restore).not.toHaveBeenCalled();
    });
  },
);

it("rechecks namespace before an actual remove callback after bridge admission", async () => {
  await withTestHarness(async (harness) => {
    const { alice } = seedControlPlaneJobSubjects(harness.db);
    const { project, source } = seedProjectWithSource(harness.deps, {
      hostId: alice.environment.hostId,
      path: "/tmp/operator-remove",
    });
    const probe = provider(() => {
      harness.db
        .update(projectSources)
        .set({ path: alice.environment.path })
        .where(eq(projectSources.id, source.id))
        .run();
    });
    const environment = seedEnvironment(harness.deps, {
      projectId: project.id,
      hostId: alice.environment.hostId,
      path: "/tmp/operator-remove-target",
      environmentProviderId: probe.record.provider.id,
      environmentProviderPluginId: probe.record.pluginId,
      providerOwnsPath: false,
    });
    await sweepProviderEnvironment(harness.deps, environment.id);
    expect(
      harness.db
        .select({ path: projectSources.path })
        .from(projectSources)
        .where(eq(projectSources.id, source.id))
        .get()?.path,
    ).toBe(alice.environment.path);
    expect(getEnvironment(harness.db, environment.id)).toMatchObject({
      teardownStatus: "failed",
      path: environment.path,
    });
    expect(probe.remove).not.toHaveBeenCalled();
  });
});

it("rechecks namespace before an actual availability callback after bridge admission", async () => {
  await withTestHarness(async (harness) => {
    const { alice } = seedControlPlaneJobSubjects(harness.db);
    const { project, source } = seedProjectWithSource(harness.deps, {
      hostId: alice.environment.hostId,
      path: "/tmp/operator-availability",
    });
    const probe = provider(() => {
      harness.db
        .update(projectSources)
        .set({ path: alice.environment.path })
        .where(eq(projectSources.id, source.id))
        .run();
    });
    await expect(
      resolvePluginEnvironmentProviderAvailability(harness.deps, probe.record, {
        project: requirePublicProject(harness.db, project.id),
        host: makeHost({ id: alice.environment.hostId }),
        projectCheckout: { path: "/tmp/operator-availability" },
        gitRemote: null,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      harness.db
        .select({ path: projectSources.path })
        .from(projectSources)
        .where(eq(projectSources.id, source.id))
        .get()?.path,
    ).toBe(alice.environment.path);
    expect(probe.availability).not.toHaveBeenCalled();
  });
});
