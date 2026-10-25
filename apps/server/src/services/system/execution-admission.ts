import type { DbConnection } from "@bb/db";
import { ApiError } from "../../errors.js";

const stopping = new WeakSet<DbConnection>();

export function stopExecutionAdmission(db: DbConnection): void {
  stopping.add(db);
}

export function isExecutionStopping(db: DbConnection): boolean {
  return stopping.has(db);
}

export function assertExecutionAdmission(db: DbConnection): void {
  if (isExecutionStopping(db)) {
    throw new ApiError(
      503,
      "server_stopping",
      "Server is stopping; retry after it restarts",
      true,
    );
  }
}

export function isExecutionStoppingError(error: unknown): boolean {
  return error instanceof ApiError && error.body.code === "server_stopping";
}
