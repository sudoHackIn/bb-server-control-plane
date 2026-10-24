import { join } from "node:path";
import {
  createControlPlaneProject,
  ControlPlaneProjectError,
  getControlPlaneProject,
  type ControlPlaneRegistry,
  type ControlPlaneUser,
  type DbNotifier,
} from "@bb/db";
import { prepareUserProject } from "./provisioning.js";

export function createControlPlaneProjectService(args: {
  registry: ControlPlaneRegistry;
  notifier: DbNotifier;
  hostId: () => string;
  prepare?: typeof prepareUserProject;
}) {
  const prepare = args.prepare ?? prepareUserProject;
  const pending = new Map<
    string,
    Promise<{ projectId: string; created: boolean }>
  >();
  return {
    create(user: ControlPlaneUser, input: { name: string; slug: string }) {
      const key = `${user.id}/${input.slug}`;
      const existing = pending.get(key);
      if (existing)
        return existing.then((result) => {
          const project = getControlPlaneProject(
            args.registry.db,
            user.id,
            result.projectId,
          );
          if (project?.name !== input.name)
            throw new ControlPlaneProjectError("project_conflict");
          return result;
        });
      const operation = (async () => {
        const current = args.registry.user(user.login);
        if (
          !current ||
          current.id !== user.id ||
          !current.enabled ||
          current.environmentStatus !== "ready"
        )
          throw new Error("Environment is not ready");
        const hostId = args.hostId();
        const cwd = await prepare(current, input.slug);
        if (cwd !== join(current.projectsRoot, input.slug))
          throw new Error("Unexpected project directory");
        const result = createControlPlaneProject(
          args.registry.db,
          args.notifier,
          { userId: current.id, hostId, ...input },
        );
        return { projectId: result.project.id, created: result.created };
      })();
      pending.set(key, operation);
      void operation.finally(() => pending.delete(key)).catch(() => {});
      return operation;
    },
  };
}

export type ControlPlaneProjectService = ReturnType<
  typeof createControlPlaneProjectService
>;
