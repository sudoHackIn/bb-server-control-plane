import {
  ControlPlaneThreadError,
  getEnvironment,
  requireControlPlaneThreadDispatch,
  requireControlPlaneThreadRelation,
  type DbQueryConnection,
} from "@bb/db";
import type { SystemMessageKind, SystemMessageSubject } from "@bb/domain";
import { ApiError } from "../errors.js";

export function assertControlPlaneSystemMessage(
  db: DbQueryConnection,
  threadId: string,
  kind: SystemMessageKind,
  subject: SystemMessageSubject | null,
): void {
  const context = requireControlPlaneThreadDispatch(db, threadId);
  if (!context) return;
  try {
    if (kind === "tool-result-delivered") {
      if (subject?.kind !== "tool-call" || !subject.toolName)
        throw new ControlPlaneThreadError();
      return;
    }
    if (kind === "environment-directory-updated") {
      const environment = context.thread.environmentId
        ? getEnvironment(db, context.thread.environmentId)
        : null;
      if (
        subject?.kind !== "directory" ||
        subject.path !== environment?.path ||
        subject.path !== context.project.cwd
      )
        throw new ControlPlaneThreadError();
      return;
    }
    if (kind === "unlabeled") throw new ControlPlaneThreadError();
    if (kind === "child-outcome-batch") {
      if (
        subject?.kind !== "thread-batch" ||
        !subject.outcomes?.length ||
        subject.count !== subject.outcomes.length
      )
        throw new ControlPlaneThreadError();
    } else if (subject?.kind !== "thread" || !subject.threadId)
      throw new ControlPlaneThreadError();
    const ids = new Set<string>();
    if (subject?.kind === "thread") ids.add(subject.threadId);
    if (subject?.kind === "thread" || subject?.kind === "thread-batch")
      for (const outcome of subject.outcomes ?? []) ids.add(outcome.threadId);
    for (const id of ids)
      requireControlPlaneThreadRelation(db, threadId, id, true);
  } catch (error) {
    if (!(error instanceof ControlPlaneThreadError)) throw error;
    throw new ApiError(
      403,
      "message_source_not_authorized",
      "Message source is not authorized",
    );
  }
}
