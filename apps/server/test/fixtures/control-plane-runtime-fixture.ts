import { and, eq } from "drizzle-orm";
import {
  createConnection,
  createEnvironment,
  createThread,
  controlPlaneProjects,
  environments,
  noopNotifier,
} from "@bb/db";
import { startControlPlaneQwenContextService } from "../../src/control-plane/qwen-context.js";
import { seedControlPlaneProfile } from "../helpers/control-plane-profile.js";

export async function createRuntimeFixture(config: {
  id: string;
  cwd: string;
  threadId?: string;
  tools?: string[];
}) {
  const db = createConnection("/srv/bb/bb.db");
  try {
    let threadId = config.threadId;
    if (!threadId) {
      const project = db
        .select()
        .from(controlPlaneProjects)
        .where(
          and(
            eq(controlPlaneProjects.ownerUserId, config.id),
            eq(controlPlaneProjects.cwd, config.cwd),
          ),
        )
        .get();
      if (!project) throw new Error("Missing runtime fixture project");
      const environment =
        db
          .select()
          .from(environments)
          .where(
            and(
              eq(environments.projectId, project.projectId),
              eq(environments.hostId, project.hostId),
              eq(environments.path, project.cwd),
            ),
          )
          .get() ??
        createEnvironment(db, noopNotifier, {
          projectId: project.projectId,
          hostId: project.hostId,
          path: project.cwd,
          status: "ready",
          providerOwnsPath: false,
        });
      threadId = createThread(db, noopNotifier, {
        projectId: project.projectId,
        environmentId: environment.id,
        providerId: "qwen-server",
        controlPlaneOwnerUserId: config.id,
        controlPlaneProfileVersionId: seedControlPlaneProfile(
          db,
          config.id,
          config.tools,
        ).versionId,
        status: "starting",
      }).id;
    }
    const service = await startControlPlaneQwenContextService(db, "/srv/bb");
    return {
      threadId,
      socketPath: service.socketPath,
      async close() {
        await service.close();
        db.$client.close();
      },
    };
  } catch (error) {
    db.$client.close();
    throw error;
  }
}
