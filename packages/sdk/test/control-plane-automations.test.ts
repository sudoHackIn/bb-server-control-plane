import { expect, it } from "vitest";
import { createControlPlaneClient } from "../src/control-plane.js";

it("uses only personal routes with bearer credentials, opaque cursors, cancellation and response validation", async () => {
  const requests: Request[] = [];
  const value = {
    id: "auto_owned",
    projectId: "project",
    name: "Owned",
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
