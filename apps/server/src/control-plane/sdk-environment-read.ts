import { AsyncLocalStorage } from "node:async_hooks";
import {
  getControlPlaneProject,
  listEnvironments,
  type DbConnection,
} from "@bb/db";
import { environmentStatusValues } from "@bb/domain";
import { toEnvironmentResponses } from "../services/environments/environment-response.js";

type Scope = {
  db: DbConnection;
  userId: string;
  projectId: string;
  hostId: string;
  cwd: string;
};
const scopes = new AsyncLocalStorage<Scope>();
export function withControlPlaneEnvironmentRead<T>(
  scope: Scope,
  run: () => T,
): T {
  return scopes.run(scope, run);
}
export function dispatchControlPlaneEnvironmentRead(
  userId: string,
  request: Request,
): Response | null {
  const scope = scopes.getStore();
  if (!scope || scope.userId !== userId) return null;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.pathname !== "/api/v1/environments" ||
    url.searchParams.size !== 2 ||
    url.searchParams.get("hostId") !== scope.hostId ||
    url.searchParams.get("path") !== scope.cwd
  )
    return null;
  const project = getControlPlaneProject(scope.db, userId, scope.projectId);
  if (
    !project ||
    project.ownerUserId !== userId ||
    !["owner", "runner"].includes(project.role) ||
    project.hostId !== scope.hostId ||
    project.cwd !== scope.cwd
  )
    return null;
  return Response.json(
    toEnvironmentResponses(
      scope.db,
      listEnvironments(scope.db, {
        projectId: scope.projectId,
        hostId: scope.hostId,
        path: scope.cwd,
        statuses: environmentStatusValues.filter(
          (status) => status !== "destroyed",
        ),
      }),
    ),
  );
}
