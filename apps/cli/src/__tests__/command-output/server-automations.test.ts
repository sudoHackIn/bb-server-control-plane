import { expect, it, vi } from "vitest";
import { createControlPlaneClient } from "@bb/sdk/node";
import { registerServerAutomationCommands } from "../../commands/server-automations.js";
import {
  runCommand,
  setupCommandOutputTestEnvironment,
} from "../helpers/command-output-harness.js";

setupCommandOutputTestEnvironment();
it("passes personal automation project filters and opaque history cursors through the limited SDK", async () => {
  const urls: string[] = [];
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      urls.push(request.url);
      return Response.json(
        request.url.includes("/history")
          ? { automationId: "auto", runs: [], nextCursor: null }
          : { automations: [], nextCursor: null },
      );
    },
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  const register = (program: import("commander").Command) =>
    registerServerAutomationCommands(program, () => client);
  await runCommand(
    ["automations", "list", "--project", "project", "--limit", "2", "--json"],
    register,
  );
  await runCommand(
    [
      "automations",
      "history",
      "auto",
      "--cursor",
      "MTph",
      "--limit",
      "3",
      "--json",
    ],
    register,
  );
  expect(urls).toEqual([
    "https://bb.example/control-plane/user/automations?projectId=project&limit=2",
    "https://bb.example/control-plane/user/automations/auto/history?cursor=MTph&limit=3",
  ]);
  await expect(
    runCommand(["automations", "list", "--limit", "51"], register),
  ).rejects.toThrow();
  expect(urls).toHaveLength(2);
});
