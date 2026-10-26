import { eq, sql } from "drizzle-orm";
import {
  controlPlaneThreads,
  controlPlaneUsers,
  getControlPlaneProject,
  getControlPlaneProjectOwner,
  getEnvironment,
  getThread,
  isControlPlaneThreadManaged,
  requireControlPlaneThreadDispatch,
  type DbQueryConnection,
} from "@bb/db";
import type { HostDaemonRpcCommand } from "@bb/host-daemon-contract";
import { posix } from "node:path";
import { ApiError } from "../errors.js";

function denied(): never {
  throw new ApiError(
    403,
    "rpc_target_not_authorized",
    "Command target is not authorized",
  );
}

export function assertControlPlaneRpcTarget(
  db: DbQueryConnection,
  hostId: string,
  command: HostDaemonRpcCommand,
): void {
  if (command.type === "environment.hook.run") {
    const target = posix.resolve(command.path);
    const owner = db
      .select({ id: controlPlaneUsers.id })
      .from(controlPlaneUsers)
      .where(
        sql`${target} = ${controlPlaneUsers.home} OR substr(${target}, 1, length(${controlPlaneUsers.home}) + 1) = ${controlPlaneUsers.home} || '/' OR ${target} = ${controlPlaneUsers.projectsRoot} OR substr(${target}, 1, length(${controlPlaneUsers.projectsRoot}) + 1) = ${controlPlaneUsers.projectsRoot} || '/'`,
      )
      .limit(1)
      .get();
    if (owner) denied();
    return;
  }
  if (!("environmentId" in command)) return;
  const environment = getEnvironment(db, command.environmentId);
  const project = environment
    ? getControlPlaneProjectOwner(db, environment.projectId)
    : null;
  if (!("threadId" in command)) {
    if (
      project &&
      environment &&
      "workspaceContext" in command &&
      (hostId !== project.hostId ||
        environment.hostId !== hostId ||
        command.workspaceContext.workspacePath !== project.cwd)
    )
      denied();
    if (!project || command.type !== "environment.attach") return;
    const access = getControlPlaneProject(
      db,
      project.ownerUserId,
      project.projectId,
    );
    if (
      !environment ||
      !access ||
      !["owner", "runner"].includes(access.role) ||
      environment.hostId !== hostId ||
      project.hostId !== hostId ||
      environment.path !== project.cwd ||
      command.path !== project.cwd ||
      environment.providerOwnsPath ||
      command.setupScriptTimeoutMs !== null
    )
      denied();
    if (command.initiator) {
      const context = requireControlPlaneThreadDispatch(
        db,
        command.initiator.threadId,
      );
      if (
        !context ||
        context.thread.environmentId !== environment.id ||
        context.project.projectId !== project.projectId
      )
        denied();
    }
    return;
  }
  if (!project && !isControlPlaneThreadManaged(db, command.threadId)) return;
  const thread = getThread(db, command.threadId);
  const owner = db
    .select()
    .from(controlPlaneThreads)
    .where(eq(controlPlaneThreads.threadId, command.threadId))
    .get();
  const cleanup =
    command.type === "thread.stop" ||
    command.type === "thread.storage.delete" ||
    command.type === "thread.plan.cancel" ||
    command.type === "thread.rewind.discard" ||
    command.type === "thread.archive";
  const threadProject =
    owner && project
      ? getControlPlaneProject(db, owner.ownerUserId, project.projectId)
      : null;
  if (
    !thread ||
    !owner ||
    !environment ||
    !project ||
    thread.environmentId !== environment.id ||
    thread.projectId !== project.projectId ||
    (!cleanup &&
      (!threadProject || !["owner", "runner"].includes(threadProject.role))) ||
    thread.providerId !== "qwen-server" ||
    environment.hostId !== hostId ||
    project.hostId !== hostId ||
    (!cleanup &&
      (environment.path !== project.cwd || environment.providerOwnsPath))
  )
    denied();
  if ("providerId" in command && command.providerId !== thread.providerId)
    denied();
  if ("projectId" in command && command.projectId !== thread.projectId)
    denied();
  if (
    "workspaceContext" in command &&
    command.workspaceContext.workspacePath !== project.cwd
  )
    denied();
  if (
    "providerThreadId" in command &&
    command.providerThreadId !== owner.qwenSessionId
  )
    denied();
  if (
    "resumeContext" in command &&
    (command.resumeContext.projectId !== thread.projectId ||
      command.resumeContext.providerId !== thread.providerId ||
      command.resumeContext.workspaceContext.workspacePath !== project.cwd ||
      command.resumeContext.providerThreadId !== owner.qwenSessionId)
  )
    denied();
  if (
    command.type === "thread.start" ||
    command.type === "turn.submit" ||
    command.type === "thread.rewind.prepare" ||
    command.type === "thread.goal.clear" ||
    command.type === "thread.unarchive"
  )
    requireControlPlaneThreadDispatch(db, thread.id);
}
