import { ControlPlaneJobError, ControlPlaneThreadError } from "@bb/db";

export function isControlPlaneMaintenanceError(error: unknown): boolean {
  return (
    (error instanceof ControlPlaneThreadError ||
      error instanceof ControlPlaneJobError) &&
    error.reason === "maintenance"
  );
}
