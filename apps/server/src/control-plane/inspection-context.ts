import { AsyncLocalStorage } from "node:async_hooks";
import { ApiError } from "../errors.js";

const reads = new AsyncLocalStorage<boolean>();
export function isControlPlaneInspectionRead() {
  return reads.getStore() === true;
}
export function withControlPlaneInspectionRead<T>(run: () => T): T {
  return reads.run(true, run);
}
export function assertControlPlaneInspectionMutationAllowed() {
  if (isControlPlaneInspectionRead())
    throw new ApiError(
      403,
      "inspection_read_only",
      "Inspection does not authorize execution or mutation",
    );
}
