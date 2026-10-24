import { randomUUID } from "node:crypto";
import {
  ControlPlaneRegistry,
  createControlPlaneProfile,
  createControlPlaneProject,
  createThread,
  createEnvironment,
  noopNotifier,
  setControlPlaneProfileAccess,
  upsertHost,
  type DbConnection,
} from "@bb/db";

export function seedControlPlaneJobSubjects(db: DbConnection) {
  const registry = new ControlPlaneRegistry(db, {
    usersRoot: "/srv/users",
    firstUid: 200000,
    lastUid: 299999,
  });
  const host = upsertHost(db, noopNotifier, {
    name: "Background authority host",
  });
  function subject(login: string) {
    const user = registry.reserve(login, 1);
    registry.environmentState(user.id, "ready");
    const { project } = createControlPlaneProject(db, noopNotifier, {
      userId: user.id,
      hostId: host.id,
      name: login,
      slug: "app",
    });
    const profile = createControlPlaneProfile(db, {
      slug: login,
      name: login,
      definition: {
        prompt: "Authority fixture",
        providerId: "qwen-server",
        model: "qwen-test",
        reasoningLevel: "none",
        permissionMode: "full",
        tools: [],
        mcpServers: [],
      },
    });
    setControlPlaneProfileAccess(db, profile.profileId, user.id, true);
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: `${user.projectsRoot}/app`,
      providerOwnsPath: false,
      status: "ready",
    });
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "qwen-server",
      controlPlaneOwnerUserId: user.id,
      controlPlaneProfileVersionId: profile.versionId,
    });
    return {
      user,
      project,
      environment,
      profile,
      thread,
      input: {
        kind: "workflow-run" as const,
        objectId: randomUUID(),
        revision: 1,
        projectId: project.id,
        profileVersionId: null,
        originThreadId: thread.id,
        sourceBindingId: null,
      },
    };
  }
  return { alice: subject("alice"), bob: subject("bob") };
}
