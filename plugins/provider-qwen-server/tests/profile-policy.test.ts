import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { profilePolicy } from "../src/profile-policy.js";
import type { ServiceContext } from "../src/service-context.js";

function context(): ServiceContext {
  return {
    id: randomUUID(),
    threadId: "thread",
    sessionId: randomUUID(),
    user: "alice",
    uid: 200000,
    gid: 200000,
    home: "/srv/alice/home",
    cwd: "/srv/alice/projects/app",
    profile: {
      versionId: randomUUID(),
      definition: {
        prompt: "Approved instructions",
        providerId: "qwen-server",
        model: "approved-model",
        reasoningLevel: "none",
        permissionMode: "full",
        tools: ["read_file"],
        mcpServers: [],
      },
    },
  };
}

it("compiles exact native-tool restrictions without deny-rule family expansion and preserves central context", () => {
  const source = context();
  const compiled = profilePolicy(source, {
    systemPrompt: { type: "preset", preset: "qwen_code", append: "BB context" },
  });
  expect(compiled.appendPrompt).toBe("Approved instructions\n\nBB context");
  expect(compiled.settings.tools.disabled).not.toContain("read_file");
  expect(compiled.settings.tools.disabled).toContain("write_file");
  expect(compiled.settings.tools.disabled).toContain("tool_call");
  expect(compiled.settings.mcp.allowed).toEqual([]);
  expect(
    profilePolicy(source, { excludeTools: ["read_file"] }).settings.tools
      .disabled,
  ).toContain("read_file");
});

it("rejects unsupported MCP, permissions, reasoning and unknown native capabilities before spawning", () => {
  for (const patch of [
    { mcpServers: ["unconfigured"] },
    { tools: ["unregistered-tool"] },
    { reasoningLevel: "unsupported" },
  ]) {
    const source = context();
    source.profile.definition = { ...source.profile.definition, ...patch };
    expect(() => profilePolicy(source, {})).toThrow();
  }
});

it("rejects caller policy overrides before constructing an SDK session", () => {
  for (const options of [
    { model: "other-model" },
    { safeMode: true },
    { mcpServers: { injected: { command: "/bin/sh", args: ["-c", "false"] } } },
  ])
    expect(() => profilePolicy(context(), options)).toThrow();
});

it("seals inherited auto-allow rules and translates each bound approval mode", () => {
  for (const [mode, cli] of [
    ["full", "yolo"],
    ["accept-edits", "default"],
    ["auto", "auto"],
  ] as const) {
    const source = context();
    source.profile.definition.permissionMode = mode;
    const compiled = profilePolicy(source, { permissionMode: cli });
    expect(compiled.settings.permissions).toBeNull();
    expect(compiled.settings.tools.allowed).toBeNull();
    expect(compiled.settings.tools.autoAccept).toBe(false);
    expect(
      compiled.arguments[compiled.arguments.indexOf("--approval-mode") + 1],
    ).toBe(cli);
    if (mode !== "full")
      expect(() => profilePolicy(source, { permissionMode: "yolo" })).toThrow(
        "fixed",
      );
  }
});
