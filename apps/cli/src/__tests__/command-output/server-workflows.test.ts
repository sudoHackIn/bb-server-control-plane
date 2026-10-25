import { expect, it, vi } from "vitest";
import { createControlPlaneClient } from "@bb/sdk/node";
import { registerServerWorkflowCommands } from "../../commands/server-workflows.js";
import {
  collectLogPayloads,
  runCommand,
  setupCommandOutputTestEnvironment,
} from "../helpers/command-output-harness.js";

setupCommandOutputTestEnvironment();
it("routes workflow start/replay and history flags through the limited SDK transport", async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const run = {
    id: "wfr_test",
    projectId: "project",
    originThreadId: "origin",
    name: "test",
    status: "queued",
    phase: null,
    error: null,
    resultAvailable: false,
    notificationOutcome: "pending",
    createdAt: 1,
    startedAt: null,
    finishedAt: null,
  };
  const client = createControlPlaneClient({
    origin: "https://agents.example",
    token: () => "test-token",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push({
        path: url.pathname + url.search,
        method: request.method,
        body:
          request.method === "POST"
            ? JSON.parse((await request.text()) || "null")
            : null,
      });
      return new Response(
        JSON.stringify(
          url.pathname.endsWith("/history")
            ? { runId: run.id, calls: [], nextCursor: null }
            : run,
        ),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const register = (program: import("commander").Command) =>
    registerServerWorkflowCommands(program, () => client);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await runCommand(
    [
      "workflows",
      "start",
      "origin",
      "--script",
      'export const meta={name:"test",description:"test"}; return args;',
      "--args",
      '{"value":42}',
      "--resume",
      "wfr_before",
      "--json",
    ],
    register,
  );
  expect(calls[0]).toMatchObject({
    path: "/control-plane/user/workflows",
    method: "POST",
    body: {
      originThreadId: "origin",
      args: { value: 42 },
      resumeRunId: "wfr_before",
    },
  });
  expect(collectLogPayloads(log)[0]).toContain("wfr_test");
  await runCommand(
    ["workflows", "history", run.id, "--after", "2", "--limit", "3"],
    register,
  );
  expect(calls[1]?.path).toBe(
    `/control-plane/user/workflows/${run.id}/history?after=2&limit=3`,
  );
});
