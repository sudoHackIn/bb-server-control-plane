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

it("maps creation, definition revision edits, run cancellation and deletion to the limited SDK", async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const metadata = {
    id: "auto",
    projectId: "project",
    name: "Name",
    enabled: true,
    trigger: { triggerType: "once", runAt: 1000 },
    createdByThreadId: "origin",
    nextRunAt: 1000,
    lastRunAt: null,
    runCount: 0,
    lastRunStatus: null,
    lastRunThreadId: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: async (input, init) => {
      const request = new Request(input, init),
        path = new URL(request.url).pathname,
        text = await request.text();
      const body: unknown = text ? JSON.parse(text) : null;
      calls.push({ path, method: request.method, body });
      if (path.endsWith("/definition"))
        return Response.json({ ...metadata, revision: 1, prompt: "Prompt" });
      if (request.method === "DELETE") return Response.json({ deleted: true });
      if (path.endsWith("/stop")) return Response.json({ stopped: true });
      if (path.endsWith("/run"))
        return Response.json({
          id: "run",
          automationId: "auto",
          threadId: null,
          status: "running",
          trigger: "manual",
          skipReason: null,
          error: null,
          scheduledFor: 1,
          startedAt: 1,
          finishedAt: null,
        });
      return Response.json(
        request.method === "PUT" || path.endsWith("/automations")
          ? { ...metadata, revision: 1 }
          : metadata,
      );
    },
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  const register = (program: import("commander").Command) =>
    registerServerAutomationCommands(program, () => client);
  await runCommand(
    [
      "automations",
      "create",
      "origin",
      "--name",
      "Name",
      "--prompt",
      "Prompt",
      "--at",
      "1000",
      "--disabled",
    ],
    register,
  );
  expect(calls[0]?.body).toMatchObject({
    enabled: false,
    originThreadId: "origin",
    trigger: { triggerType: "once", runAt: 1000 },
  });
  await runCommand(
    [
      "automations",
      "update",
      "auto",
      "--revision",
      "1",
      "--prompt",
      "Changed",
      "--cron",
      "* * * * *",
      "--timezone",
      "UTC",
    ],
    register,
  );
  expect(calls[1]?.body).toMatchObject({
    expectedRevision: 1,
    prompt: "Changed",
    trigger: { triggerType: "schedule", cron: "* * * * *", timezone: "UTC" },
  });
  for (const operation of ["definition", "pause", "resume", "delete"])
    await runCommand(["automations", operation, "auto"], register);
  await runCommand(
    ["automations", "run", "auto", "--idempotency-key", "same"],
    register,
  );
  await runCommand(["automations", "stop", "auto", "run"], register);
  expect(calls.at(-1)?.path).toBe(
    "/control-plane/user/automations/auto/runs/run/stop",
  );
  const before = calls.length;
  await expect(
    runCommand(["automations", "update", "auto", "--revision", "1"], register),
  ).rejects.toThrow();
  await expect(
    runCommand(
      [
        "automations",
        "create",
        "origin",
        "--name",
        "Name",
        "--prompt",
        "Prompt",
        "--at",
        "1000",
        "--cron",
        "* * * * *",
      ],
      register,
    ),
  ).rejects.toThrow();
  for (const flag of ["--at", "--cron", "--timezone"])
    await expect(
      runCommand(
        [
          "automations",
          "update",
          "auto",
          "--revision",
          "1",
          "--name",
          "Name",
          flag,
          "",
        ],
        register,
      ),
    ).rejects.toThrow();
  expect(calls).toHaveLength(before);
});

it("passes bounded script definitions and output IDs through the personal SDK", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push({
        path: new URL(request.url).pathname,
        body: request.method === "GET" ? null : await request.json(),
      });
      if (request.url.endsWith("/output"))
        return Response.json({
          automationId: "auto",
          runId: "run",
          status: "running",
          result: null,
          cleanupPending: true,
          error: "Cleanup pending",
        });
      return Response.json({
        id: "auto",
        projectId: "p",
        name: "script",
        enabled: true,
        executionMode: "script",
        trigger: { triggerType: "once", runAt: 1000 },
        createdByThreadId: "origin",
        nextRunAt: 1000,
        lastRunAt: null,
        runCount: 0,
        lastRunStatus: null,
        lastRunThreadId: null,
        lastError: null,
        createdAt: 1,
        updatedAt: 1,
        revision: 1,
      });
    },
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  const register = (program: import("commander").Command) =>
    registerServerAutomationCommands(program, () => client);
  await runCommand(
    [
      "automations",
      "create",
      "origin",
      "--name",
      "script",
      "--script",
      "console.log('x')",
      "--timeout-ms",
      "1234",
      "--at",
      "1000",
    ],
    register,
  );
  expect(calls[0]?.body).toMatchObject({
    script: { source: "console.log('x')", timeoutMs: 1234 },
  });
  expect(calls[0]?.body).not.toHaveProperty("prompt");
  await runCommand(["automations", "output", "auto", "run"], register);
  expect(calls.at(-1)?.path).toBe(
    "/control-plane/user/automations/auto/runs/run/output",
  );
  const before = calls.length;
  await expect(
    runCommand(
      [
        "automations",
        "update",
        "auto",
        "--revision",
        "1",
        "--script",
        "x",
        "--prompt",
        "y",
      ],
      register,
    ),
  ).rejects.toThrow();
  await expect(
    runCommand(
      [
        "automations",
        "update",
        "auto",
        "--revision",
        "1",
        "--timeout-ms",
        "1000",
      ],
      register,
    ),
  ).rejects.toThrow();
  expect(calls).toHaveLength(before);
});
