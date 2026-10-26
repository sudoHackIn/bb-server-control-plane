import type { ControlPlaneProfileDefinition } from "@bb/domain";
export const isProjectMcpTool = (name: string) =>
  /^project_mcp_[a-f0-9]{40}$/u.test(name);
export function allowsProjectMcp(
  profile: ControlPlaneProfileDefinition,
  slug: string,
  tool?: string,
) {
  return (
    profile.mcpServers.includes("project") &&
    (profile.tools.includes("mcp:*") ||
      profile.tools.some((name) =>
        tool === undefined
          ? name.startsWith(`mcp:${slug}:`)
          : name === `mcp:${slug}:${tool}`,
      ))
  );
}
