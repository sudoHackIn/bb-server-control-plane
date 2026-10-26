import { and, eq, or, sql } from "drizzle-orm";
import {
  controlPlaneUsers,
  getControlPlaneProjectOwner,
  projectSources,
  type DbQueryConnection,
} from "@bb/db";
import { posix } from "node:path";
import { ApiError } from "../errors.js";

export function controlPlaneEnvironmentProviderRefusal(
  db: DbQueryConnection,
  projectId: string,
  paths: readonly (string | null)[] = [],
): string | null {
  if (getControlPlaneProjectOwner(db, projectId))
    return "Managed projects use their registered workspace; service-account environment provider callbacks are not authorized";
  const sources = db
    .select({ path: projectSources.path })
    .from(projectSources)
    .where(
      and(
        eq(projectSources.projectId, projectId),
        eq(projectSources.type, "local_path"),
      ),
    )
    .all();
  const targets = [...paths, ...sources.map((source) => source.path)]
    .filter((path): path is string => path !== null)
    .map((path) => posix.resolve(path));
  if (targets.length === 0) return null;
  const registered = db
    .select({ id: controlPlaneUsers.id })
    .from(controlPlaneUsers)
    .where(
      or(
        ...targets.map(
          (path) =>
            sql`${path} = ${controlPlaneUsers.home} OR substr(${path}, 1, length(${controlPlaneUsers.home}) + 1) = ${controlPlaneUsers.home} || '/' OR ${path} = ${controlPlaneUsers.projectsRoot} OR substr(${path}, 1, length(${controlPlaneUsers.projectsRoot}) + 1) = ${controlPlaneUsers.projectsRoot} || '/'`,
        ),
      ),
    )
    .limit(1)
    .get();
  return registered
    ? "Registered user directories cannot use service-account environment provider callbacks"
    : null;
}

export function assertControlPlaneEnvironmentProviderAllowed(
  db: DbQueryConnection,
  projectId: string,
  paths: readonly (string | null)[] = [],
): void {
  const refusal = controlPlaneEnvironmentProviderRefusal(db, projectId, paths);
  if (refusal)
    throw new ApiError(403, "managed_environment_provider_denied", refusal);
}
