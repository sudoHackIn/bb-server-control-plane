import type { QueryOptions } from "@qwen-code/sdk";
import type { ServiceContext } from "./service-context.js";
import { nativeTools } from "./native-tools.js";

const known = new Set<string>(nativeTools);
const reasoning = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

export function profilePolicy(
  context: ServiceContext,
  options: QueryOptions,
  delegatedNames: string[] = [],
) {
  const profile = context.profile.definition;
  if (
    options.model &&
    options.model !== profile.model &&
    options.model !== "qwen-configured-default"
  )
    throw new Error("Model is fixed by the selected profile");
  if (options.safeMode)
    throw new Error("Safe mode cannot enforce the selected native tool policy");
  if (options.permissionMode && options.permissionMode !== "yolo")
    throw new Error("Permission mode is fixed by the selected profile");
  if (Object.keys(options.mcpServers ?? {}).length)
    throw new Error(
      "Unverified SDK MCP servers cannot run in the service process",
    );
  if (profile.mcpServers.some((name) => name !== "bb"))
    throw new Error("Unsupported managed MCP server");
  if (!reasoning.has(profile.reasoningLevel))
    throw new Error("Unsupported Qwen reasoning level");
  if (profile.permissionMode !== "full")
    throw new Error(
      "Interactive profile permissions require the approval adapter",
    );
  for (const name of profile.tools)
    if (
      !known.has(name) &&
      !(
        profile.mcpServers.includes("bb") &&
        /^bb:[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) &&
        name !== "bb:update_environment_directory"
      )
    )
      throw new Error("Unknown native Qwen tool in profile");
  const disallowed = new Set(options.excludeTools ?? []);
  const allowed = profile.tools.filter(
    (name) => known.has(name) && !disallowed.has(name),
  );
  const visible = [
    ...allowed,
    ...delegatedNames.map((name) => `mcp__bb__${name}`),
  ];
  const mcpNames = delegatedNames.length ? ["bb"] : [];
  const appended =
    typeof options.systemPrompt === "string"
      ? options.systemPrompt
      : (options.systemPrompt?.append ?? "");
  return {
    appendPrompt: [profile.prompt, appended].filter(Boolean).join("\n\n"),
    settings: {
      model: {
        name: profile.model,
        reasoningEffort: profile.reasoningLevel,
        generationConfig: null,
      },
      modelProviders: null,
      providerProtocol: null,
      modelFallbacks: null,
      tools: {
        core: allowed.length ? allowed : ["bb_no_core_tools"],
        disabled: nativeTools.filter((name) => !allowed.includes(name)),
        visible,
        eager: visible,
        codeModeOnly: false,
        discoveryCommand: "",
        callCommand: "",
      },
      mcpServers: null,
      mcp: {
        allowed: mcpNames,
        excluded: mcpNames.length ? [] : ["*"],
        serverCommand: "",
      },
      disableAllHooks: true,
      memory: {
        enableManagedAutoMemory: false,
        enableManagedAutoDream: false,
        enableTeamMemory: false,
        enableTeamMemorySync: false,
        enableStructuredRecall: false,
        enableAutoSkill: false,
      },
      experimental: { generatedUi: { enabled: false } },
      telemetry: { enabled: false },
    },
    arguments: [
      "--model",
      profile.model,
      "--approval-mode",
      "yolo",
      "--extensions",
      "",
      "--allowed-mcp-server-names",
      mcpNames.join(","),
      ...(options.excludeTools?.length
        ? ["--exclude-tools", options.excludeTools.join(",")]
        : []),
    ],
  };
}
