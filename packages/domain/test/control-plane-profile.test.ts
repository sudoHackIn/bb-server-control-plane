import { expect, it } from "vitest";
import {
  controlPlaneProfileDefinitionSchema,
  controlPlaneProfilePublicationSchema,
} from "../src/control-plane-profile.js";

const definition = {
  purpose: "Convert project diagrams.",
  prompt: "Help with diagrams",
  providerId: "qwen-server",
  model: "qwen-approved",
  reasoningLevel: "medium",
  permissionMode: "accept-edits",
  tools: ["read_file", "bb:read_diagram", "mcp:diagrams:convert"],
  mcpServers: ["bb", "project"],
};

it("publishes only settings enforceable by the managed Qwen provider while reading legacy definitions", () => {
  expect(controlPlaneProfilePublicationSchema.parse(definition)).toEqual(
    definition,
  );
  for (const changed of [
    { reasoningLevel: "unsupported" },
    { tools: ["unknown_native_tool"] },
    { tools: ["bb:update_environment_directory"] },
    { tools: ["bb:bb_workflow_run"] },
    { tools: ["mcp:diagrams:convert"], mcpServers: [] },
    { tools: ["agent"] },
    { mcpServers: ["unapproved"] },
  ])
    expect(
      controlPlaneProfilePublicationSchema.safeParse({
        ...definition,
        ...changed,
      }).success,
    ).toBe(false);
  expect(
    controlPlaneProfileDefinitionSchema.parse({
      ...definition,
      purpose: undefined,
      mcpServers: ["previous-provider"],
    }).purpose,
  ).toBeUndefined();
});
