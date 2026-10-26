import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  delegatedMcpServer,
  selectDelegatedTools,
} from "../src/delegated-mcp.js";
import { profilePolicy } from "../src/profile-policy.js";
import type { ServiceContext } from "../src/service-context.js";

function context(): ServiceContext {
  return {
    id: randomUUID(),
    uid: 200000,
    maintenanceGeneration: 0,
    gid: 200000,
    user: "alice",
    home: "/srv/alice/home",
    cwd: "/srv/alice/projects/app",
    threadId: "thread",
    sessionId: randomUUID(),
    profile: {
      versionId: randomUUID(),
      definition: {
        prompt: "Approved",
        providerId: "qwen-server",
        model: "model",
        reasoningLevel: "none",
        permissionMode: "full",
        tools: ["bb:approved"],
        mcpServers: ["bb"],
      },
    },
  };
}
const available = ["approved", "foreign"].map((name) => ({
  name,
  description: "Fixture",
  inputSchema: { type: "object", properties: {} },
}));

it("exposes only exact profile tools and rechecks context before every MCP request", async () => {
  const initial = context();
  let latest = initial,
    revoked = false,
    calls = 0;
  const tools = selectDelegatedTools(initial, available, []);
  const mcp = delegatedMcpServer({
    context: initial,
    tools,
    excluded: [],
    adapter: {
      tools: available,
      invoke: async (name) => {
        calls++;
        return { content: [{ type: "text", text: name }] };
      },
    },
    authorize: async () => {
      if (revoked) throw new Error("Revoked");
      return latest;
    },
  });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  try {
    await mcp.instance.connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "approved",
    ]);
    expect(
      await client.callTool({ name: "approved", arguments: {} }),
    ).toMatchObject({ content: [{ text: "approved" }] });
    expect(
      await client.callTool({ name: "foreign", arguments: {} }),
    ).toMatchObject({ isError: true });
    expect(calls).toBe(1);
    revoked = true;
    expect(
      await client.callTool({ name: "approved", arguments: {} }),
    ).toMatchObject({ isError: true });
    await expect(client.listTools()).rejects.toThrow();
    revoked = false;
    for (const patch of [
      { id: randomUUID() },
      { threadId: "foreign" },
      { sessionId: randomUUID() },
      { profile: { ...initial.profile, versionId: randomUUID() } },
    ]) {
      latest = { ...initial, ...patch };
      expect(
        await client.callTool({ name: "approved", arguments: {} }),
      ).toMatchObject({ isError: true });
    }
    expect(calls).toBe(1);
  } finally {
    await client.close();
    await mcp.instance.close();
  }
});

it("rejects unavailable, ambiguous and unsupported delegated names and permits only capability reduction", () => {
  const source = context();
  expect(() => selectDelegatedTools(source, [], [])).toThrow("unavailable");
  expect(() =>
    selectDelegatedTools(source, [available[0]!, available[0]!], []),
  ).toThrow("Duplicate");
  for (const tools of [
    ["bb:update_environment_directory"],
    ["bb:invalid-name.with.dots"],
  ]) {
    expect(() =>
      selectDelegatedTools(
        {
          ...source,
          profile: {
            ...source.profile,
            definition: { ...source.profile.definition, tools },
          },
        },
        available,
        [],
      ),
    ).toThrow("Unsupported");
  }
  const selected = selectDelegatedTools(source, available, ["approved"]);
  expect(selected).toEqual([]);
  const policy = profilePolicy(
    source,
    {},
    selected.map((tool) => tool.name),
  );
  expect(policy.settings.mcp.allowed).toEqual([]);
  expect(policy.settings.mcpServers).toBeNull();
  expect(policy.settings.tools.disabled).toContain("run_shell_command");
  const enabled = profilePolicy(source, {}, ["approved"]);
  expect(enabled.settings.mcp.allowed).toEqual(["bb"]);
  expect(enabled.settings.tools.visible).toEqual(["mcp__bb__approved"]);
});

it("transports server-resolved project tools only with profile opt-in and honors capability reduction", () => {
  const source = context();
  source.profile.definition.tools = ["mcp:fixture:lookup"];
  source.profile.definition.mcpServers = ["project"];
  const project = { ...available[0]!, name: "project_mcp_" + "a".repeat(40) };
  const catalog = [
    ...available,
    project,
    { ...project, name: "project_mcp_forged" },
  ];
  expect(
    selectDelegatedTools(source, catalog, []).map((tool) => tool.name),
  ).toEqual([project.name]);
  expect(selectDelegatedTools(source, catalog, ["mcp:*"])).toEqual([]);
  expect(selectDelegatedTools(source, catalog, [project.name])).toEqual([]);
  expect(
    profilePolicy(source, {}, [project.name]).settings.tools.visible,
  ).toEqual(["mcp__bb__" + project.name]);
  expect(() =>
    profilePolicy(source, { excludeTools: ["mcp:fixture:lookup"] }),
  ).toThrow("exclusions");
  source.profile.definition.mcpServers = [];
  expect(selectDelegatedTools(source, catalog, [])).toEqual([]);
  expect(() => profilePolicy(source, {})).toThrow();
});
