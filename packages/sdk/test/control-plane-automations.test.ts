import { expect, it } from "vitest";
import { createControlPlaneClient } from "../src/control-plane.js";

it("uses only personal routes with bearer credentials, opaque cursors, cancellation and response validation", async () => {
  const requests: Request[] = [];
  const value = {
    id: "auto_owned",
    projectId: "project",
    name: "Owned",
    enabled: true,
    trigger: { triggerType: "once" as const, runAt: 1000 },
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
    token: () => "private-token",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/foreign"))
        return Response.json(
          { error: "automation_not_found" },
          { status: 404 },
        );
      if (url.pathname.endsWith("/bad"))
        return Response.json({ ...value, execution: { prompt: "secret" } });
      if (url.pathname.endsWith("/history"))
        return Response.json({
          automationId: value.id,
          runs: [],
          nextCursor: null,
        });
      return Response.json(
        url.pathname.endsWith("/automations")
          ? { automations: [value], nextCursor: null }
          : value,
      );
    },
  });
  expect(
    (await client.automations.list({ projectId: "project", limit: 1 }))
      .automations[0]?.id,
  ).toBe(value.id);
  expect((await client.automations.get(value.id)).id).toBe(value.id);
  expect(
    (await client.automations.history(value.id, { cursor: "MTph", limit: 2 }))
      .runs,
  ).toEqual([]);
  expect(requests[2]?.url).toContain("/history?cursor=MTph&limit=2");
  await expect(client.automations.get("foreign")).rejects.toThrow("404");
  await expect(client.automations.get("bad")).rejects.toThrow();
  const abort = new AbortController();
  await client.automations.get(value.id, abort.signal);
  expect(requests.at(-1)?.signal.aborted).toBe(false);
  abort.abort();
  expect(requests.at(-1)?.signal.aborted).toBe(true);
  expect(
    requests.every(
      (request) =>
        request.method === "GET" &&
        request.headers.get("authorization") === "Bearer private-token" &&
        request.url.startsWith(
          "https://bb.example/control-plane/user/automations",
        ) &&
        !request.url.includes("private-token"),
    ),
  ).toBe(true);
});

it("validates definition edits and uses only scoped mutation routes with revision and idempotency data", async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const metadata = {
    id: "auto",
    projectId: "project",
    name: "Name",
    enabled: true,
    trigger: { triggerType: "once" as const, runAt: 1000 },
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
  const run = {
    id: "run",
    automationId: "auto",
    threadId: "thread",
    status: "cancelled",
    trigger: "manual",
    skipReason: null,
    error: null,
    scheduledFor: 1,
    startedAt: 1,
    finishedAt: 2,
  };
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    token: () => "secret-token",
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
      if (path.endsWith("/run")) return Response.json(run);
      if (request.method === "PUT" || path.endsWith("/automations"))
        return Response.json({ ...metadata, revision: 1 });
      return Response.json(metadata);
    },
  });
  await client.automations.create({
    originThreadId: "origin",
    name: "Name",
    prompt: "Prompt",
    trigger: metadata.trigger,
  });
  expect(calls[0]?.body).toMatchObject({ enabled: true });
  await client.automations.update("auto", {
    expectedRevision: 1,
    prompt: "Changed",
  });
  expect(calls[1]).toMatchObject({
    method: "PUT",
    body: { expectedRevision: 1, prompt: "Changed" },
  });
  const definition = await client.automations.definition("auto");
  if (definition.executionMode !== "agent")
    throw new Error("Expected an agent definition");
  expect(definition.prompt).toBe("Prompt");
  await client.automations.pause("auto");
  await client.automations.resume("auto");
  expect(
    (await client.automations.run("auto", { idempotencyKey: "once" })).status,
  ).toBe("cancelled");
  expect(await client.automations.stop("auto", "run")).toEqual({
    stopped: true,
  });
  expect(await client.automations.remove("auto")).toEqual({ deleted: true });
  expect(
    calls.every((call) =>
      call.path.startsWith("/control-plane/user/automations"),
    ),
  ).toBe(true);
  const before = calls.length;
  await expect(
    client.automations.update("auto", { expectedRevision: 1 }),
  ).rejects.toThrow();
  await expect(
    client.automations.run("auto", { idempotencyKey: "x".repeat(201) }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(before);
});
