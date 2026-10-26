import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { DynamicTool } from "@get-bb/plugin-sdk/provider-bridge";
import type { ServiceContext } from "./service-context.js";

export type DelegatedTools = {
  tools: DynamicTool[];
  invoke(
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<CallToolResult>;
};

export function selectDelegatedTools(
  context: ServiceContext,
  available: DynamicTool[],
  excluded: string[],
) {
  const profile = context.profile.definition;
  const names = profile.tools
    .filter((name) => name.startsWith("bb:"))
    .map((name) => name.slice(3));
  if (names.length && !profile.mcpServers.includes("bb"))
    throw new Error("BB tools require the approved bb MCP server");
  for (const name of names) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) ||
      name === "update_environment_directory"
    )
      throw new Error("Unsupported delegated BB tool");
    if (!available.some((tool) => tool.name === name))
      throw new Error("Approved delegated BB tool is unavailable");
  }
  const project = available
    .filter(
      (tool) =>
        /^project_mcp_[a-f0-9]{40}$/u.test(tool.name) &&
        profile.mcpServers.includes("project") &&
        profile.tools.some((name) => name.startsWith("mcp:")),
    )
    .map((tool) => tool.name);
  const selected = available.filter(
    (tool) =>
      (names.includes(tool.name) ||
        (project.includes(tool.name) && !excluded.includes("mcp:*"))) &&
      ![tool.name, `bb:${tool.name}`, `mcp__bb__${tool.name}`].some((name) =>
        excluded.includes(name),
      ),
  );
  if (new Set(selected.map((tool) => tool.name)).size !== selected.length)
    throw new Error("Duplicate delegated BB tool");
  return selected.map((tool) =>
    ToolSchema.parse({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }),
  );
}

export function delegatedMcpServer({
  context,
  adapter,
  tools,
  authorize,
  excluded,
}: {
  context: ServiceContext;
  adapter: DelegatedTools;
  tools: ReturnType<typeof selectDelegatedTools>;
  authorize(): Promise<ServiceContext>;
  excluded: string[];
}) {
  const server = new McpServer(
    { name: "bb", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  async function current() {
    const latest = await authorize();
    if (
      latest.id !== context.id ||
      latest.threadId !== context.threadId ||
      latest.sessionId !== context.sessionId ||
      latest.profile.versionId !== context.profile.versionId
    )
      throw new Error("Delegated execution context changed");
    return selectDelegatedTools(latest, adapter.tools, excluded).filter(
      (tool) => tools.some((initial) => initial.name === tool.name),
    );
  }
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await current(),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const allowed = await current();
      if (!allowed.some((tool) => tool.name === params.name))
        throw new Error("Delegated tool is not authorized");
      return await adapter.invoke(params.name, params.arguments ?? {});
    } catch {
      return {
        content: [
          {
            type: "text",
            text: "Delegated tool execution is unavailable or not authorized",
          },
        ],
        isError: true,
      };
    }
  });
  return { type: "sdk" as const, name: "bb", instance: server };
}
