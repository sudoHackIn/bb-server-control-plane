import type { ClientTurnRequestId } from "@bb/domain";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  ControlPlaneJobError,
  ControlPlaneThreadError,
  controlPlaneJobNotifications,
  getThread,
  getEnvironment,
  requireControlPlaneThreadDispatch,
  type DbQueryConnection,
} from "@bb/db";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { sendThreadMessage } from "../services/threads/thread-send.js";
import { withControlPlaneJobAuthority } from "./job-authority.js";

class NotificationAlreadyAccepted extends Error {}
class NotificationOriginUnavailable extends Error {}

function receipt(db: DbQueryConnection, bindingId: string) {
  return db
    .select()
    .from(controlPlaneJobNotifications)
    .where(eq(controlPlaneJobNotifications.bindingId, bindingId))
    .get();
}

export function acceptControlPlaneWorkflowNotification(
  db: DbQueryConnection,
  bindingId: string,
  threadId: string,
  requestId: ClientTurnRequestId,
): void {
  withControlPlaneJobAuthority(db, bindingId, ({ binding }) => {
    if (binding.kind !== "workflow-run" || binding.originThreadId !== threadId)
      throw new ControlPlaneJobError();
    const context = requireControlPlaneThreadDispatch(db, threadId);
    if (
      !context ||
      context.user.id !== binding.ownerUserId ||
      context.project.projectId !== binding.projectId
    )
      throw new ControlPlaneJobError();
    const thread = getThread(db, threadId);
    if (!thread || thread.archivedAt !== null || thread.deletedAt !== null)
      throw new NotificationOriginUnavailable();
    if (receipt(db, bindingId)) throw new NotificationAlreadyAccepted();
    db.insert(controlPlaneJobNotifications)
      .values({ bindingId, threadId, requestId, acceptedAt: Date.now() })
      .run();
  });
}

export async function notifyControlPlaneWorkflowOrigin(
  deps: AppDeps,
  bindingId: string,
  message: string,
): Promise<"accepted" | "unavailable" | "denied"> {
  const text = z.string().min(1).max(262144).parse(message);
  try {
    return await withControlPlaneJobAuthority(
      deps.db,
      bindingId,
      async ({ binding }) => {
        if (binding.kind !== "workflow-run" || binding.originThreadId === null)
          throw new ControlPlaneJobError();
        const thread = getThread(deps.db, binding.originThreadId);
        if (!thread || thread.archivedAt !== null || thread.deletedAt !== null)
          return "unavailable";
        const context = requireControlPlaneThreadDispatch(deps.db, thread.id);
        if (
          !context ||
          context.user.id !== binding.ownerUserId ||
          context.project.projectId !== binding.projectId
        )
          throw new ControlPlaneJobError();
        if (receipt(deps.db, bindingId)) return "accepted";
        const environment = thread.environmentId
          ? getEnvironment(deps.db, thread.environmentId)
          : undefined;
        if (!environment) return "unavailable";
        const definition = context.profileVersion.definition;
        await sendThreadMessage(deps, {
          thread,
          environment,
          trigger: "auto-dispatch",
          payload: {
            input: [
              { type: "text", text, mentions: [], visibility: "agent-only" },
            ],
            mode: "steer-if-active",
            model: definition.model,
            reasoningLevel: definition.reasoningLevel,
            permissionMode: definition.permissionMode,
            originPluginId: "workflows",
          },
          beforeAppendInTransaction: ({ tx, requestId }) => {
            acceptControlPlaneWorkflowNotification(
              tx,
              bindingId,
              thread.id,
              requestId,
            );
          },
        });
        return "accepted";
      },
    );
  } catch (error) {
    if (error instanceof NotificationAlreadyAccepted) return "accepted";
    if (error instanceof NotificationOriginUnavailable) return "unavailable";
    if (
      error instanceof ControlPlaneJobError ||
      error instanceof ControlPlaneThreadError ||
      (error instanceof ApiError && error.status === 403)
    )
      return "denied";
    throw error;
  }
}
