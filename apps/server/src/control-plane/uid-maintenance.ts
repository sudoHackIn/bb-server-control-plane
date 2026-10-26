import { eq } from "drizzle-orm";
import {
  controlPlaneUsers,
  getControlPlaneUidMaintenance,
  reserveControlPlaneUidMaintenance,
  checkpointControlPlaneUidMaintenance,
  type DbConnection,
} from "@bb/db";
import { controlPlaneUidMaintenance } from "./provisioning.js";

export function createControlPlaneUidMaintenanceCoordinator(db: DbConnection) {
  const user = (userId: string) => {
    const row = db
      .select()
      .from(controlPlaneUsers)
      .where(eq(controlPlaneUsers.id, userId))
      .get();
    if (!row) throw new Error("Unknown maintenance user");
    return row;
  };
  const current = (userId: string, operationId: string, generation: number) => {
    const row = getControlPlaneUidMaintenance(db, userId);
    if (
      !row ||
      row.operationId !== operationId ||
      row.generation !== generation
    )
      throw new Error("Stale maintenance operation");
    return row;
  };
  return {
    status(userId: string) {
      return getControlPlaneUidMaintenance(db, userId);
    },
    async begin(input: {
      userId: string;
      projectId: string;
      operationId: string;
      restartGeneration?: number;
    }) {
      const owner = user(input.userId);
      const root = await controlPlaneUidMaintenance(owner, {
        action: "status",
      });
      const row = reserveControlPlaneUidMaintenance(db, {
        ...input,
        rootGeneration: root.generation,
      });
      if (!row || row.phase === "idle" || row.phase === "releasing")
        throw new Error("Maintenance requires finish or explicit restart");
      await controlPlaneUidMaintenance(owner, {
        action: "begin",
        generation: row.generation,
      });
      if (
        !checkpointControlPlaneUidMaintenance(
          db,
          row.userId,
          row.operationId,
          row.generation,
          "blocked",
        )
      )
        throw new Error("Maintenance changed during begin");
      return current(row.userId, row.operationId, row.generation);
    },
    async finish(input: {
      userId: string;
      operationId: string;
      generation: number;
    }) {
      const row = current(input.userId, input.operationId, input.generation);
      if (row.phase === "idle") return row;
      if (
        !checkpointControlPlaneUidMaintenance(
          db,
          row.userId,
          row.operationId,
          row.generation,
          "releasing",
        )
      )
        throw new Error("Maintenance policy is not acknowledged");
      await controlPlaneUidMaintenance(user(row.userId), {
        action: "finish",
        generation: row.generation,
      });
      if (
        !checkpointControlPlaneUidMaintenance(
          db,
          row.userId,
          row.operationId,
          row.generation,
          "idle",
        )
      )
        throw new Error("Maintenance changed during release");
      return current(row.userId, row.operationId, row.generation);
    },
  };
}
