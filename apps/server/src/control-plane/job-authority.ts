import {
  ControlPlaneJobError,
  requireControlPlaneJobDispatch,
  type DbQueryConnection,
} from "@bb/db";
import { ApiError } from "../errors.js";
import {
  currentControlPlanePrincipal,
  withControlPlaneUser,
} from "./access.js";

export function withControlPlaneJobAuthority<T>(
  db: DbQueryConnection,
  bindingId: string,
  run: (context: ReturnType<typeof requireControlPlaneJobDispatch>) => T,
): T {
  let context: ReturnType<typeof requireControlPlaneJobDispatch>;
  try {
    context = requireControlPlaneJobDispatch(db, bindingId);
    const principal = currentControlPlanePrincipal();
    if (principal?.kind === "user" && principal.userId !== context.user.id)
      throw new ControlPlaneJobError();
  } catch (error) {
    if (error instanceof ControlPlaneJobError)
      throw new ApiError(
        403,
        "job_not_authorized",
        "Background execution is not authorized",
      );
    throw error;
  }
  return withControlPlaneUser(context.user.id, () => run(context));
}
