import {
  ControlPlaneThreadError,
  requireControlPlaneThreadDispatch,
  type DbQueryConnection,
} from "@bb/db";
import type { ControlPlaneProfileDefinition } from "@bb/domain";
import { ApiError } from "../errors.js";
import { withControlPlaneUser } from "./access.js";

function allowed(profile: ControlPlaneProfileDefinition, tool: string) {
  return (
    profile.mcpServers.includes("bb") &&
    profile.tools.includes(`bb:${tool}`) &&
    tool !== "update_environment_directory"
  );
}

export function filterControlPlaneTools<T>(
  db: DbQueryConnection,
  threadId: string,
  tools: T[],
  name: (tool: T) => string,
): T[] {
  const context = requireControlPlaneThreadDispatch(db, threadId);
  if (!context) return tools;
  return tools.filter((tool) =>
    allowed(context.profileVersion.definition, name(tool)),
  );
}

export function withControlPlaneToolAuthority<T>(
  db: DbQueryConnection,
  threadId: string,
  tool: string,
  run: () => T,
): T {
  let context: ReturnType<typeof requireControlPlaneThreadDispatch>;
  try {
    context = requireControlPlaneThreadDispatch(db, threadId);

    if (
      context &&
      (!["starting", "active"].includes(context.thread.status) ||
        !allowed(context.profileVersion.definition, tool))
    )
      throw new ControlPlaneThreadError();
  } catch (error) {
    if (!(error instanceof ControlPlaneThreadError)) throw error;
    throw new ApiError(
      403,
      "tool_not_authorized",
      "Tool execution is not authorized",
    );
  }
  return context ? withControlPlaneUser(context.user.id, run) : run();
}
