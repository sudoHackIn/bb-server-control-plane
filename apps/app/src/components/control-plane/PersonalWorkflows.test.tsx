// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createControlPlaneClient } from "@bb/sdk/browser";
import { afterEach, expect, it } from "vitest";
import { PersonalWorkflows } from "./PersonalWorkflows";

const queries: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const query of queries.splice(0)) query.clear();
});
function run(id: string, status = "succeeded", projectId = "a") {
  return {
    id,
    projectId,
    originThreadId: `origin-${projectId}`,
    name: `Workflow ${id}`,
    status,
    phase: null,
    error: null,
    resultAvailable: status === "succeeded",
    notificationOutcome: "delivered",
    createdAt: 1,
    startedAt: 2,
    finishedAt: status === "running" ? null : 3,
  };
}
function mount(
  fetcher: typeof fetch,
  originThreadId: string | null = "origin-a",
  canExecute = originThreadId !== null,
) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  queries.push(cache);
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: (input, init) =>
      new URL(input.toString()).pathname.endsWith("/workflow-definitions")
        ? Promise.resolve(Response.json({ definitions: [], nextCursor: null }))
        : fetcher(input, init),
  });
  const view = (projectId: string) => (
    <QueryClientProvider client={cache}>
      <PersonalWorkflows
        key={projectId}
        client={client}
        projectId={projectId}
        originThreadId={originThreadId}
        canExecute={canExecute}
      />
    </QueryClientProvider>
  );
  const rendered = render(view("a"));
  return { cache, switchProject: (id: string) => rendered.rerender(view(id)) };
}
function read(url: URL, rows = [run("one")]) {
  if (url.pathname.endsWith("/result"))
    return Response.json({
      runId: "one",
      status: "succeeded",
      available: true,
      value: null,
    });
  if (url.pathname.endsWith("/history"))
    return Response.json({ runId: "one", nextCursor: null, calls: [] });
  if (url.pathname.endsWith("/one")) return Response.json(rows[0]);
  return Response.json({ runs: rows, nextCursor: null });
}

it("starts and replays through the limited client, validates arguments and renders an available JSON null result", async () => {
  const writes: Array<{ path: string; body: unknown }> = [];
  mount(async (input, init) => {
    const url = new URL(input.toString());
    expect(url.pathname.startsWith("/control-plane/user/workflows")).toBe(true);
    if (init?.method === "POST") {
      writes.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
      return Response.json(run("one"), { status: 201 });
    }
    return read(url);
  });
  fireEvent.change(screen.getByLabelText("Workflow source"), {
    target: {
      value:
        'export const meta={name:"example",description:"Test"}; return null;',
    },
  });
  fireEvent.change(screen.getByLabelText("Workflow arguments (JSON)"), {
    target: { value: "broken" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
  await screen.findByRole("alert");
  expect(writes).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Workflow arguments (JSON)"), {
    target: { value: '{"task":42}' },
  });
  fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
  await screen.findByLabelText("Workflow result");
  expect(screen.getByLabelText("Workflow result").textContent).toBe("null");
  expect(writes[0]?.body).toEqual({
    originThreadId: "origin-a",
    script:
      'export const meta={name:"example",description:"Test"}; return null;',
    args: { task: 42 },
    resumeRunId: null,
  });
  fireEvent.click(screen.getByRole("button", { name: "Prepare replay" }));
  fireEvent.click(screen.getByRole("button", { name: "Resume workflow" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]?.body).toMatchObject({
    resumeRunId: "one",
    originThreadId: "origin-a",
  });
});

it("paginates personal project runs and agent calls without requesting source or general plugin RPC", async () => {
  const paths: string[] = [];
  mount(async (input) => {
    const url = new URL(input.toString());
    paths.push(url.pathname + url.search);
    if (url.pathname.endsWith("/workflows"))
      return Response.json({
        runs: [run(url.searchParams.has("cursor") ? "two" : "one")],
        nextCursor: url.searchParams.has("cursor") ? null : "next",
      });
    if (url.pathname.endsWith("/history")) {
      const index =
        url.searchParams.has("after") && url.searchParams.get("after") !== "-1"
          ? 1
          : 0;
      return Response.json({
        runId: "one",
        nextCursor: index === 0 ? 0 : null,
        calls: [
          {
            id: `call-${index}`,
            index,
            status: "succeeded",
            childThreadId: "worker",
            label: `Agent ${index}`,
            phase: null,
            provider: "qwen",
            model: "model",
            reasoningLevel: "high",
            providerRetryAttempts: 1,
            repairAttempts: 0,
            error: null,
          },
        ],
      });
    }
    return read(url);
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "More workflows" }),
  );
  await screen.findByRole("button", { name: "Workflow two · succeeded" });
  fireEvent.click(
    screen.getByRole("button", { name: "Workflow one · succeeded" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "More agent calls" }),
  );
  await screen.findByText("1: Agent 1 · succeeded");
  expect(paths).toContain(
    "/control-plane/user/workflows?projectId=a&cursor=next",
  );
  expect(paths).toContain("/control-plane/user/workflows/one/history?after=0");
  expect(
    paths.every((path) => path.startsWith("/control-plane/user/workflows")),
  ).toBe(true);
});

it("cancels an active run and keeps cancellation errors explicit", async () => {
  let stopped = false;
  let deny = true;
  const writes: string[] = [];
  mount(async (input, init) => {
    const url = new URL(input.toString());
    if (init?.method === "POST") {
      writes.push(url.pathname);
      if (deny) return Response.json({ error: "unavailable" }, { status: 503 });
      stopped = true;
      return Response.json({ stopped: true });
    }
    return read(url, [run("one", stopped ? "cancelled" : "running")]);
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Workflow one · running" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Stop workflow" }));
  await screen.findByText("Unable to stop workflow. Refresh and retry.");
  deny = false;
  fireEvent.click(screen.getByRole("button", { name: "Stop workflow" }));
  await screen.findByRole("button", { name: "Workflow one · cancelled" });
  expect(writes).toEqual([
    "/control-plane/user/workflows/one/stop",
    "/control-plane/user/workflows/one/stop",
  ]);
});

it("hides cached run details, results and history when access is revoked", async () => {
  let denied = false;
  const { cache } = mount(async (input) =>
    denied
      ? Response.json({ error: "workflow_not_found" }, { status: 404 })
      : read(new URL(input.toString())),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Workflow one · succeeded" }),
  );
  await screen.findByLabelText("Workflow result");
  denied = true;
  await cache.invalidateQueries({
    queryKey: ["personal", "workflow", "a", "one"],
  });
  await screen.findByRole("alert");
  expect(screen.queryByLabelText("Selected workflow")).toBeNull();
  expect(screen.queryByLabelText("Workflow result")).toBeNull();
  expect(screen.queryByRole("button", { name: "Prepare replay" })).toBeNull();
});

it("fences a delayed old-project response and resets source and selected run on project changes", async () => {
  let complete: ((value: Response) => void) | undefined;
  const { switchProject } = mount(async (input) => {
    const url = new URL(input.toString());
    if (url.searchParams.get("projectId") === "a")
      return new Promise((resolve) => {
        complete = resolve;
      });
    return Response.json({
      runs: [run("bob", "succeeded", "b")],
      nextCursor: null,
    });
  });
  fireEvent.change(screen.getByLabelText("Workflow source"), {
    target: { value: "private draft" },
  });
  await waitFor(() => expect(complete).toBeDefined());
  switchProject("b");
  await screen.findByRole("button", { name: "Workflow bob · succeeded" });
  complete?.(Response.json({ runs: [run("stale")], nextCursor: null }));
  expect(screen.queryByText("Workflow stale · succeeded")).toBeNull();
  expect(screen.getByLabelText("Workflow source")).toHaveProperty("value", "");
});

it("allows viewing without execution permission and requires a conversation before starting", async () => {
  mount(async (input) => read(new URL(input.toString())), null);
  fireEvent.click(
    await screen.findByRole("button", { name: "Workflow one · succeeded" }),
  );
  await screen.findByLabelText("Workflow result");
  expect(screen.queryByLabelText("Workflow source")).toBeNull();
  expect(screen.queryByRole("button", { name: "Run workflow" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Prepare replay" })).toBeNull();
});

it("starts a project workflow with a selected immutable approved profile without an origin", async () => {
  const versionId = "00000000-0000-4000-8000-000000000001";
  const writes: unknown[] = [];
  mount(
    async (input, init) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/profiles"))
        return Response.json({
          profiles: [
            {
              id: "00000000-0000-4000-8000-000000000002",
              slug: "review",
              name: "Review",
              enabled: true,
              createdAt: 1,
              latestVersionId: versionId,
              latestVersion: 2,
            },
          ],
          nextCursor: null,
        });
      if (init?.method === "POST") {
        writes.push(JSON.parse(String(init.body)));
        return Response.json(
          { ...run("one"), originThreadId: null },
          { status: 201 },
        );
      }
      return read(url);
    },
    null,
    true,
  );
  await screen.findByRole("option", { name: "Review · v2" });
  fireEvent.change(screen.getByLabelText("Execution agent"), {
    target: { value: versionId },
  });
  fireEvent.change(screen.getByLabelText("Workflow source"), {
    target: {
      value:
        'export const meta={name:"test",description:"Project"}; return null;',
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({
    projectId: "a",
    profileVersionId: versionId,
    originThreadId: null,
  });
});
