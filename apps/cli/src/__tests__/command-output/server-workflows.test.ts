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

it("manages versioned definitions through the limited SDK with explicit revision and default-argument semantics", async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const script =
    'export const meta={name:"saved",description:"Saved"}; return args;';
  const saved = {
    id: "wfd_saved",
    projectId: "project",
    originThreadId: "origin",
    revision: 1,
    name: "saved",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    script,
    args: { n: 1 },
  };
  const client = createControlPlaneClient({
    origin: "https://agents.example",
    token: () => "test-token",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const text = await request.text();
      const body: unknown = text ? JSON.parse(text) : null;
      calls.push({
        path: url.pathname + url.search,
        method: request.method,
        body,
      });
      if (url.pathname.endsWith("/run"))
        return Response.json({
          id: "wfr_saved",
          projectId: "project",
          originThreadId: "origin",
          name: "saved",
          status: "queued",
          phase: null,
          error: null,
          resultAvailable: false,
          notificationOutcome: "pending",
          createdAt: 1,
          startedAt: null,
          finishedAt: null,
        });
      if (request.method === "DELETE") return Response.json({ deleted: true });
      if (
        request.method === "GET" &&
        url.pathname.endsWith("/workflow-definitions")
      ) {
        const { script: _script, args: _args, ...summary } = saved;
        return Response.json({ definitions: [summary], nextCursor: null });
      }
      return Response.json(saved);
    },
  });
  const register = (program: import("commander").Command) =>
    registerServerWorkflowCommands(program, () => client);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await runCommand(
    [
      "workflows",
      "definitions",
      "create",
      "origin",
      "--script",
      script,
      "--args",
      '{"n":1}',
      "--json",
    ],
    register,
  );
  await runCommand(
    [
      "workflows",
      "definitions",
      "update",
      saved.id,
      "--revision",
      "1",
      "--script",
      script,
      "--args",
      '{"n":2}',
      "--json",
    ],
    register,
  );
  await runCommand(
    ["workflows", "definitions", "get", saved.id, "--revision", "1", "--json"],
    register,
  );
  await runCommand(
    [
      "workflows",
      "definitions",
      "list",
      "--project",
      "project",
      "--limit",
      "1",
      "--json",
    ],
    register,
  );
  await runCommand(
    ["workflows", "definitions", "disable", saved.id, "--json"],
    register,
  );
  await runCommand(
    ["workflows", "definitions", "enable", saved.id, "--json"],
    register,
  );
  await runCommand(
    ["workflows", "definitions", "run", saved.id, "--revision", "1", "--json"],
    register,
  );
  await runCommand(
    [
      "workflows",
      "definitions",
      "run",
      saved.id,
      "--revision",
      "1",
      "--args",
      "null",
      "--json",
    ],
    register,
  );
  await runCommand(
    ["workflows", "definitions", "delete", saved.id, "--json"],
    register,
  );
  expect(calls.map((row) => row.method)).toEqual([
    "POST",
    "PUT",
    "GET",
    "GET",
    "POST",
    "POST",
    "POST",
    "POST",
    "DELETE",
  ]);
  expect(calls[0]?.body).toEqual({
    originThreadId: "origin",
    script,
    args: { n: 1 },
  });
  expect(calls[1]?.body).toEqual({
    expectedRevision: 1,
    script,
    args: { n: 2 },
  });
  expect(calls[2]?.path).toBe(
    "/control-plane/user/workflow-definitions/wfd_saved?revision=1",
  );
  expect(calls[3]?.path).toBe(
    "/control-plane/user/workflow-definitions?projectId=project&limit=1",
  );
  expect(calls[6]?.body).toEqual({ revision: 1 });
  expect(calls[7]?.body).toEqual({ revision: 1, args: null });
  expect(collectLogPayloads(log)).toHaveLength(9);
});
