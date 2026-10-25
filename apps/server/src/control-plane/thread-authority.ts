import {
  ControlPlaneThreadError,
  getControlPlaneProjectOwner,
  getEnvironment,
  requireControlPlaneThreadOwner,
  type DbQueryConnection,
} from "@bb/db";
import { currentControlPlanePrincipal } from "./access.js";
import { ApiError } from "../errors.js";
import type { ThreadCreateServiceRequestInput } from "../services/threads/thread-create-request.js";

export function controlPlaneThreadOwnerForCreate(
  db: DbQueryConnection,
  request: Pick<
    ThreadCreateServiceRequestInput,
    | "projectId"
    | "providerId"
    | "environment"
    | "parentThreadId"
    | "sourceThreadId"
    | "lifecycleOwnerThreadId"
    | "senderThreadId"
    | "controlPlaneProfileVersionId"
    | "controlPlaneJobBindingId"
    | "originPluginId"
  >,
): string | undefined {
  const managed = getControlPlaneProjectOwner(db, request.projectId);
  const principal = currentControlPlanePrincipal();
  if (!managed) {
    if (
      principal?.kind === "user" ||
      request.providerId === "qwen-server" ||
      request.controlPlaneProfileVersionId !== undefined ||
      request.controlPlaneJobBindingId !== undefined
    )
      throw new ApiError(404, "project_not_found", "Project not found");
    return undefined;
  }
  const userId =
    principal?.kind === "admin"
      ? managed.ownerUserId
      : principal?.kind === "user"
        ? principal.userId
        : undefined;
  try {
    const context = requireControlPlaneThreadOwner(db, {
      projectId: request.projectId,
      ownerUserId: userId,
      profileVersionId: request.controlPlaneProfileVersionId,
      providerId: request.providerId ?? "",
      jobBindingId: request.controlPlaneJobBindingId,
      originPluginId: request.originPluginId,
      relatedThreadIds: [
        request.parentThreadId,
        request.sourceThreadId,
        request.lifecycleOwnerThreadId,
        request.senderThreadId,
      ],
    });
    if (!context) throw new ControlPlaneThreadError();
    const environment = request.environment;
    if (environment.type === "reuse") {
      const existing = getEnvironment(db, environment.environmentId);
      if (
        !existing ||
        existing.projectId !== request.projectId ||
        existing.hostId !== context.project.hostId ||
        existing.path !== context.project.cwd
      )
        throw new ControlPlaneThreadError();
    } else if (
      environment.type !== "host" ||
      environment.hostId !== context.project.hostId ||
      environment.workspace.type !== "unmanaged" ||
      environment.workspace.path !== context.project.cwd ||
      environment.workspace.branch !== undefined
    ) {
      throw new ControlPlaneThreadError();
    }
    return context.user.id;
  } catch (error) {
    if (error instanceof ControlPlaneThreadError)
      throw new ApiError(
        404,
        "project_not_found",
        "Project not found or execution not permitted",
      );
    throw error;
  }
}
