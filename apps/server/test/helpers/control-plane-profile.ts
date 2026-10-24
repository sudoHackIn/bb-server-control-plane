import { randomUUID } from "node:crypto";
import {
  createControlPlaneProfile,
  setControlPlaneProfileAccess,
  type DbConnection,
} from "@bb/db";

export function seedControlPlaneProfile(
  db: DbConnection,
  userId: string,
  tools = ["run_shell_command"],
) {
  const profile = createControlPlaneProfile(db, {
    slug: `profile-${randomUUID()}`,
    name: "Execution test profile",
    definition: {
      prompt: "Controlled fixture",
      providerId: "qwen-server",
      model: "qwen-job-test",
      reasoningLevel: "none",
      permissionMode: "full",
      tools,
      mcpServers: [],
    },
  });
  setControlPlaneProfileAccess(db, profile.profileId, userId, true);
  return profile;
}
