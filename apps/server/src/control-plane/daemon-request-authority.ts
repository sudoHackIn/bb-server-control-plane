import {
  ControlPlaneThreadError,
  controlPlaneThreads,
  getActiveStoredTurnId,
  getStoredProviderSession,
  getThread,
  getPendingInteraction,
  getEnvironment,
  requireControlPlaneThreadDispatch,
  type DbConnection,
} from "@bb/db";
import { eq } from "drizzle-orm";
import { ApiError } from "../errors.js";
import { assertExecutionAdmission } from "../services/system/execution-admission.js";
import {
  pendingInteractionResolutionSchema,
  type PendingInteractionResolution,
} from "@bb/domain";
import { pendingInteractionResolutionEquals } from "../services/interactions/pending-interaction-validation.js";

function resolutionMatches(
  saved: string | null,
  requested: PendingInteractionResolution,
): boolean {
  if (saved === null) return false;
  try {
    const parsed = pendingInteractionResolutionSchema.safeParse(
      JSON.parse(saved),
    );
    return (
      parsed.success &&
      pendingInteractionResolutionEquals(parsed.data, requested)
    );
  } catch {
    return false;
  }
}

export function assertControlPlaneDaemonRequest(
  db: DbConnection,
  request: {
    threadId: string;
    turnId: string | null;
    providerThreadId: string;
    providerId?: string;
  },
): void {
  assertExecutionAdmission(db);
  if (!getThread(db, request.threadId)) return;
  try {
    const context = requireControlPlaneThreadDispatch(db, request.threadId);
    if (!context) return;
    const owner = db
      .select({ sessionId: controlPlaneThreads.qwenSessionId })
      .from(controlPlaneThreads)
      .where(eq(controlPlaneThreads.threadId, request.threadId))
      .get();
    const session = getStoredProviderSession(db, request.threadId);
    if (
      !["starting", "active"].includes(context.thread.status) ||
      (request.providerId !== undefined &&
        request.providerId !== context.thread.providerId) ||
      request.turnId === null ||
      getActiveStoredTurnId(db, request.threadId) !== request.turnId ||
      session.kind !== "owned" ||
      session.providerThreadId !== request.providerThreadId ||
      owner?.sessionId !== request.providerThreadId
    )
      throw new ControlPlaneThreadError();
  } catch (error) {
    if (!(error instanceof ControlPlaneThreadError)) throw error;
    throw new ApiError(
      403,
      "daemon_request_not_authorized",
      "Request is not authorized for the current thread session and turn",
    );
  }
}

export function assertControlPlaneInteractionResolution(
  db: DbConnection,
  request: {
    interactionId: string;
    environmentId: string;
    hostId: string;
    threadId: string;
    providerId: string;
    providerThreadId: string;
    providerRequestId: string;
    resolution: PendingInteractionResolution;
  },
): void {
  const saved = getPendingInteraction(db, request.interactionId);
  const thread = getThread(db, request.threadId);
  assertControlPlaneDaemonRequest(db, {
    ...request,
    turnId: saved?.turnId ?? null,
  });
  if (
    saved &&
    (saved.originKind !== "provider" ||
      saved.status !== "resolving" ||
      saved.threadId !== request.threadId ||
      saved.providerId !== request.providerId ||
      saved.providerThreadId !== request.providerThreadId ||
      saved.providerRequestId !== request.providerRequestId ||
      !resolutionMatches(saved.resolution, request.resolution) ||
      thread?.environmentId !== request.environmentId ||
      getEnvironment(db, request.environmentId)?.hostId !== request.hostId)
  )
    throw new ApiError(
      403,
      "daemon_request_not_authorized",
      "Resolution does not match the saved pending interaction",
    );
}
