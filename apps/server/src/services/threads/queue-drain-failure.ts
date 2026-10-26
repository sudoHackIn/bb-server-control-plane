import { isControlPlaneMaintenanceError } from "../../control-plane/maintenance-errors.js";
import { isExecutionStoppingError } from "../system/execution-admission.js";
import {
  setQueuedThreadMessageFailureReason,
  setQueuedThreadMessageWaitingOn,
} from "@bb/db";
import {
  QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH,
  type Thread,
} from "@bb/domain";
import { sliceUtf16Head } from "@bb/text-utils";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { dispatchEnvironmentAndHost } from "./dispatch-hooks.js";
import { isParentNotifiableChildThread } from "./thread-parent.js";
import { queueChildThreadTurnNotificationBestEffort } from "./child-thread-notifications.js";

type QueueDrainFailureDeps = LoggedPendingInteractionWorkSessionDeps;

export const QUEUED_MESSAGE_RETRY_DELAYS_MS: readonly number[] = [
  15_000, 60_000, 300_000,
];

export function describeDispatchFailure(error: unknown): string {
  const message =
    error instanceof ApiError
      ? error.body.message
      : "The message could not be sent.";
  return message.length <= QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH
    ? message
    : `${sliceUtf16Head(message, QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH - 1)}…`;
}

export function recordQueuedMessageDrainFailure(
  deps: QueueDrainFailureDeps,
  args: {
    error: unknown;
    now: number;
    row: { id: string; threadId: string };
    thread: Thread;
  },
): void {
  if (
    isExecutionStoppingError(args.error) ||
    isControlPlaneMaintenanceError(args.error)
  )
    return;
  const { host } = dispatchEnvironmentAndHost(deps, args.thread.environmentId);
  if (host !== null && !deps.hub.hasDaemonForHost(host.id)) {
    setQueuedThreadMessageWaitingOn(deps.db, deps.hub, {
      id: args.row.id,
      threadId: args.row.threadId,
      waitingOn: { kind: "host-offline", hostName: host.name },
      sendAt: null,
    });
    return;
  }

  const updated = setQueuedThreadMessageFailureReason(deps.db, deps.hub, {
    id: args.row.id,
    threadId: args.row.threadId,
    failureReason: describeDispatchFailure(args.error),
    now: args.now,
    retryDelaysMs: QUEUED_MESSAGE_RETRY_DELAYS_MS,
  });
  if (
    updated !== null &&
    updated.state === "failed_exhausted" &&
    isParentNotifiableChildThread(args.thread, "failed")
  ) {
    void queueChildThreadTurnNotificationBestEffort(deps, {
      childThread: args.thread,
      parentThreadId: args.thread.parentThreadId,
      turnStatus: "failed",
      failureContext: "could not send a queued message after retrying",
    });
  }
}
