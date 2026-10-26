import { and, asc, eq, isNull } from "drizzle-orm";
import {
  controlPlaneThreads,
  threads,
  getControlPlaneUidMaintenance,
  getControlPlaneProjectAccessPolicy,
  listPendingControlPlaneProjectMaintenance,
  type DbConnection,
} from "@bb/db";
import type { LoggedPendingInteractionWorkSessionDeps } from "../types.js";
import { stopThreadForMaintenance } from "../services/threads/thread-lifecycle.js";
import { resolveThreadHostCommandEnvironment } from "../services/threads/thread-command-environment.js";
import { isExecutionStopping } from "../services/system/execution-admission.js";
import { withControlPlaneUser } from "./access.js";
import { createControlPlaneProjectMaintenanceCoordinator } from "./project-maintenance.js";

export function createControlPlaneNativeProjectMaintenanceCoordinator(
  deps: LoggedPendingInteractionWorkSessionDeps,
) {
  return createControlPlaneProjectMaintenanceCoordinator({
    db: deps.db,
    async stopThreads(userId) {
      const intent = getControlPlaneUidMaintenance(deps.db, userId);
      if (!intent || intent.phase !== "blocked")
        throw new Error("Native maintenance is not blocked");
      const owned = deps.db
        .select({ thread: threads })
        .from(controlPlaneThreads)
        .innerJoin(threads, eq(threads.id, controlPlaneThreads.threadId))
        .where(
          and(
            eq(controlPlaneThreads.ownerUserId, userId),
            isNull(threads.deletedAt),
          ),
        )
        .orderBy(asc(threads.id))
        .all();
      for (const { thread } of owned)
        await withControlPlaneUser(userId, () =>
          stopThreadForMaintenance(
            deps,
            thread,
            resolveThreadHostCommandEnvironment({ db: deps.db, thread }),
            {
              userId,
              operationId: intent.operationId,
              generation: intent.generation,
            },
          ),
        );
    },
  });
}
const coordinators = new WeakMap<
  DbConnection,
  ReturnType<typeof createControlPlaneNativeProjectMaintenanceCoordinator>
>();
export async function runControlPlaneProjectMaintenanceSweep(
  deps: LoggedPendingInteractionWorkSessionDeps,
) {
  if (isExecutionStopping(deps.db)) return;
  const pending = listPendingControlPlaneProjectMaintenance(deps.db, 10);
  if (pending.length === 0) return;
  let coordinator = coordinators.get(deps.db);
  if (!coordinator) {
    coordinator = createControlPlaneNativeProjectMaintenanceCoordinator(deps);
    coordinators.set(deps.db, coordinator);
  }
  for (const operation of pending) {
    if (isExecutionStopping(deps.db)) return;
    if (operation.projectId === null) continue;
    if (operation.phase === "preparing" || operation.phase === "draining") {
      const policy = getControlPlaneProjectAccessPolicy(
        deps.db,
        operation.projectId,
      );
      if (!policy || !deps.hub.hasDaemonForHost(policy.project.hostId))
        continue;
    }
    try {
      await coordinator.reconcile({
        operationId: operation.id,
        projectId: operation.projectId,
      });
    } catch (error) {
      deps.logger.warn(
        { err: error, operationId: operation.id },
        "Project maintenance recovery remains pending",
      );
    }
  }
}
