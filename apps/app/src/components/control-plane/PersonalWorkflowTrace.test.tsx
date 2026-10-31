// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createControlPlaneClient } from "@bb/sdk/browser";
import { afterEach, expect, it } from "vitest";
import { PersonalWorkflowTrace } from "./PersonalWorkflowTrace";

const caches: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const cache of caches.splice(0)) cache.clear();
});
const attemptId = "11111111-1111-4111-8111-111111111111";
const attempt = {
  id: attemptId,
  sequence: 2,
  status: "succeeded",
  createdAt: 1,
  finishedAt: 10,
  truncated: false,
};
function entry(
  index: number,
  kind: "workflow" | "parallel" | "agent",
  scopeId: number | null = null,
) {
  return {
    index,
    nodeId: kind === "agent" ? null : index + 1,
    scopeId,
    kind,
    name:
      kind === "workflow"
        ? "Converter"
        : kind === "parallel"
          ? "Parallel"
          : "Step",
    sourceHash: kind === "workflow" ? "hash" : null,
    branchCount: kind === "parallel" ? 2 : null,
    failedBranches: kind === "parallel" ? 1 : null,
    status: "succeeded",
    error: null,
    createdAt: 2,
    finishedAt: 9,
    callId: kind === "agent" ? "call" : null,
    callIndex: kind === "agent" ? 0 : null,
    source: kind === "agent" ? "cached" : null,
  };
}
function mount(fetcher: typeof fetch) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  caches.push(cache);
  const selected: string[] = [];
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: fetcher,
  });
  render(
    <QueryClientProvider client={cache}>
      <PersonalWorkflowTrace
        client={client}
        runId="run"
        onSelectCall={(id) => selected.push(id)}
        fallback={<p>Flat fallback</p>}
      />
    </QueryClientProvider>,
  );
  return { cache, selected };
}
it("renders workflow scope children while showing parallel boundaries without inventing branch membership", async () => {
  const { selected } = mount(async (_input, init) => {
    expect(init?.method).toBe("GET");
    return Response.json({
      runId: "run",
      attempt,
      entries: [
        entry(0, "workflow"),
        entry(1, "parallel", 1),
        entry(2, "agent", 1),
      ],
      nextCursor: null,
    });
  });
  const title = await screen.findByText("Workflow · Converter");
  const workflow = title.closest("details");
  if (!workflow) throw new Error("Missing workflow scope");
  expect(within(workflow).getByText("2 branches · 1 failed")).toBeTruthy();
  const group = within(workflow)
    .getByText("Parallel group · Parallel")
    .closest("details");
  if (!group) throw new Error("Missing parallel span");
  expect(
    within(group).queryByRole("button", { name: "Inspect step 1" }),
  ).toBeNull();
  fireEvent.click(
    within(workflow).getByRole("button", { name: "Inspect step 1" }),
  );
  expect(selected).toEqual(["call"]);
  expect(screen.getByText("Cached replay · no new worker")).toBeTruthy();
});
it("pins the attempt when loading more structure and includes later children under their recorded parent", async () => {
  const queries: URL[] = [];
  mount(async (input) => {
    const url = new URL(input.toString());
    queries.push(url);
    if (url.searchParams.get("after") === "0")
      return Response.json({
        runId: "run",
        attempt,
        entries: [entry(1, "agent", 1)],
        nextCursor: null,
      });
    return Response.json({
      runId: "run",
      attempt,
      entries: [entry(0, "workflow")],
      nextCursor: 0,
    });
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "More structure" }),
  );
  await screen.findByRole("button", { name: "Inspect step 1" });
  expect(queries[1]?.searchParams.get("attemptId")).toBe(attemptId);
  expect(
    queries.every(
      (url) => url.pathname === "/control-plane/user/workflows/run/trace",
    ),
  ).toBe(true);
});
it("keeps legacy history available and reports explicitly truncated scopes", async () => {
  const { cache } = mount(async () =>
    Response.json({
      runId: "run",
      attempt: null,
      entries: [],
      nextCursor: null,
    }),
  );
  await screen.findByText(
    "No execution structure was recorded. Older runs may have only flat call history.",
  );
  expect(screen.getByText("Flat fallback")).toBeTruthy();
  cache.setQueryData(["personal", "workflow-trace", "run"], {
    pages: [
      {
        runId: "run",
        attempt: { ...attempt, truncated: true },
        entries: [entry(0, "agent", 99)],
        nextCursor: null,
      },
    ],
    pageParams: [{ after: -1, attemptId: undefined }],
  });
  await screen.findByText("Unrecorded workflow scope");
  expect(screen.getByRole("status").textContent).toContain(
    "some scopes are incomplete",
  );
});
it("removes cached structure and flat fallback after a current access denial", async () => {
  let denied = false;
  const { cache } = mount(async () =>
    denied
      ? Response.json({ error: "not_found" }, { status: 404 })
      : Response.json({
          runId: "run",
          attempt,
          entries: [entry(0, "workflow")],
          nextCursor: null,
        }),
  );
  await screen.findByText("Workflow · Converter");
  denied = true;
  await cache.invalidateQueries({
    queryKey: ["personal", "workflow-trace", "run"],
  });
  await waitFor(() =>
    expect(screen.queryByText("Workflow · Converter")).toBeNull(),
  );
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.queryByText("Flat fallback")).toBeNull();
});
