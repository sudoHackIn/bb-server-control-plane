import { expect, it, vi } from "vitest";
import { createControlPlaneClient } from "@bb/sdk/node";
import { registerServerTaskSourceCommands } from "../../commands/server-task-sources.js";
import {
  runCommand,
  setupCommandOutputTestEnvironment,
} from "../helpers/command-output-harness.js";
setupCommandOutputTestEnvironment();
it("routes source creation, pause and polling through the restricted SDK", async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const id = "11111111-1111-4111-8111-111111111111",
    version = "22222222-2222-4222-8222-222222222222";
  const source = {
    id,
    projectId: "project",
    profileVersionId: version,
    kind: "beads",
    name: "Work",
    intervalSeconds: 300,
    enabled: false,
    checkpoint: null,
    nextPollAt: 1,
    lastPollAt: null,
    failures: 0,
    error: null,
    createdAt: 1,
  };
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push({
        path: new URL(request.url).pathname,
        method: request.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json(source);
    },
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  const register = (program: import("commander").Command) =>
    registerServerTaskSourceCommands(program, () => client);
  await runCommand(
    [
      "task-sources",
      "create",
      "project",
      "--profile-version",
      version,
      "--name",
      "Work",
      "--json",
    ],
    register,
  );
  await runCommand(["task-sources", "enable", id, "--json"], register);
  await runCommand(["task-sources", "poll", id, "--json"], register);
  expect(calls.map((call) => call.method)).toEqual(["POST", "PUT", "POST"]);
  expect(calls[0].body).toMatchObject({ kind: "beads", intervalSeconds: 300 });
  expect(calls[1].body).toEqual({ enabled: true });
  expect(calls[2].path).toBe(`/control-plane/user/task-sources/${id}/poll`);
});
