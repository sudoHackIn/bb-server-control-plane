import { expect, it } from "vitest";
import { createControlPlaneClient } from "../src/control-plane.js";

it("uses only personal workflow routes, validates ownership-shaped responses and propagates authorization failure", async () => {
  const requests: Request[] = [];
  const run = {
    id: "wfr_owned",
    projectId: "project",
    originThreadId: "origin",
    name: "owned",
    status: "succeeded",
    phase: null,
    error: null,
    resultAvailable: true,
    notificationOutcome: "delivered",
    createdAt: 1,
    startedAt: 2,
    finishedAt: 3,
  };
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    token: () => "private-token",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/foreign"))
        return Response.json({ error: "not_found" }, { status: 404 });
      if (url.pathname.endsWith("/stop"))
        return Response.json({ stopped: true });
      if (url.pathname.endsWith("/history"))
        return Response.json({ runId: run.id, calls: [], nextCursor: null });
      if (url.pathname.endsWith("/result"))
        return Response.json({
          runId: run.id,
          status: "succeeded",
          available: true,
          value: { value: 42 },
        });
      return Response.json(
        url.search ? { runs: [run], nextCursor: null } : run,
      );
    },
  });
  expect(
    (
      await client.workflows.start({
        originThreadId: "origin",
        script:
          'export const meta={name:"test",description:"test"}; return 42;',
      })
    ).id,
  ).toBe(run.id);
  expect(await requests[0]?.clone().json()).toMatchObject({
    args: null,
    resumeRunId: null,
  });
  expect(
    (await client.workflows.list({ projectId: "project", limit: 1 })).runs[0]
      ?.id,
  ).toBe(run.id);
  expect((await client.workflows.result(run.id)).value).toEqual({ value: 42 });
  expect(
    (await client.workflows.history(run.id, { after: 2, limit: 3 })).nextCursor,
  ).toBeNull();
  expect(await client.workflows.stop(run.id)).toEqual({ stopped: true });
  await expect(client.workflows.get("foreign")).rejects.toThrow("404");
  expect(
    requests.every((request) =>
      new URL(request.url).pathname.startsWith("/control-plane/user/workflows"),
    ),
  ).toBe(true);
  expect(
    requests.every(
      (request) =>
        request.headers.get("authorization") === "Bearer private-token",
    ),
  ).toBe(true);
  expect(
    requests.some((request) => request.url.includes("private-token")),
  ).toBe(false);
});
