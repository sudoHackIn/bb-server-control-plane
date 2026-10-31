// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createControlPlaneClient } from "@bb/sdk/browser";
import { PersonalRunInspection } from "./PersonalRunInspection";

vi.mock("./PersonalTimeline", () => ({
  PersonalTimeline: ({ threadId }: { threadId: string }) => (
    <p>Native timeline {threadId}</p>
  ),
}));
const caches: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const cache of caches.splice(0)) cache.clear();
});
const profileVersionId = "11111111-1111-4111-8111-111111111111";
function summary(source: "live" | "cached" = "live") {
  return {
    id: "call",
    index: 0,
    status: "succeeded",
    childThreadId: source === "live" ? "worker" : null,
    label: "Convert diagram",
    phase: "Conversion",
    provider: "qwen-server",
    model: "qwen",
    reasoningLevel: "high",
    permissionMode: "full",
    profileVersionId,
    source,
    replaySource: source === "cached" ? "resumed-run" : null,
    providerRetryAttempts: 1,
    repairAttempts: 0,
    error: null,
    createdAt: 1,
    startedAt: 2,
    finishedAt: 3,
  };
}
function mount(
  options: {
    source?: "live" | "cached";
    foreignThread?: boolean;
    deny?: boolean;
  } = {},
) {
  const paths: string[] = [];
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  caches.push(cache);
  const call = summary(options.source);
  const run = {
    id: "run",
    projectId: "project",
    originThreadId: null,
    name: "Diagram task",
    status: "succeeded",
    phase: "Conversion",
    error: null,
    resultAvailable: true,
    notificationOutcome: "abandoned",
    createdAt: 1,
    startedAt: 2,
    finishedAt: 3,
  };
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: async (input, init) => {
      expect(init?.method).toBe("GET");
      const path = new URL(input.toString()).pathname;
      paths.push(path);
      if (options.deny)
        return Response.json({ error: "not_found" }, { status: 404 });
      if (path.endsWith("/inspection"))
        return Response.json({
          run,
          input: "Convert source",
          sourceHash: "hash",
          resumedFromRunId: null,
          outputSchema: { type: "string" },
          profileVersionId,
          workflowRevision: { definitionId: "definition", revision: 3 },
          nextCursor: null,
          callCounts: {
            total: 1,
            queued: 0,
            running: 0,
            succeeded: 1,
            failed: 0,
            cancelled: 0,
          },
          calls: [call],
        });
      if (path.endsWith("/calls/call"))
        return Response.json({
          runId: "run",
          call,
          input: "Recorded prompt",
          outputAvailable: true,
          output: "PlantUML",
          outputSchema: { type: "string" },
          replayedFrom: null,
          workers:
            options.source === "cached"
              ? []
              : [{ threadId: "worker", archived: true }],
          workersTruncated: false,
        });
      if (path.endsWith("/result"))
        return Response.json({
          runId: "run",
          status: "succeeded",
          available: true,
          value: "Converted",
        });
      if (path.endsWith("/threads/worker"))
        return Response.json({
          id: "worker",
          projectId: "project",
          profileVersionId,
          title: "Worker",
          status: "idle",
          createdAt: 1,
          updatedAt: 3,
          archived: false,
        });
      throw new Error(`Unexpected request ${path}`);
    },
  });
  render(
    <MemoryRouter
      initialEntries={[
        `/projects/project?view=agents&inspectRun=run${options.foreignThread ? "&inspectCall=call&inspectThread=foreign" : ""}`,
      ]}
    >
      <QueryClientProvider client={cache}>
        <PersonalRunInspection
          client={client}
          runId="run"
          projectId="project"
          cwd="/home/project"
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return paths;
}
it("opens the actual worker timeline read-only and navigates back through the same recorded run", async () => {
  const paths = mount();
  await screen.findByRole("heading", { name: "Agent calls" });
  expect(paths.some((path) => path.includes("/calls/"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: /Convert diagram/ }));
  await screen.findByText("Recorded prompt");
  expect(screen.getByText("PlantUML")).toBeTruthy();
  expect(screen.getByText("high / full")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "worker · archived" }));
  await screen.findByText("Native timeline worker");
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to step" }));
  await screen.findByText("Recorded prompt");
  fireEvent.click(screen.getByRole("button", { name: "Back to run" }));
  await screen.findByRole("heading", { name: "Agent calls" });
  expect(paths.every((path) => path.startsWith("/control-plane/user/"))).toBe(
    true,
  );
});
it("distinguishes cached results without inventing a conversation or exposing unavailable provenance", async () => {
  const paths = mount({ source: "cached" });
  fireEvent.click(
    await screen.findByRole("button", { name: /Convert diagram/ }),
  );
  await screen.findByText("Cached replay · no new model invocation");
  expect(
    screen.queryByRole("button", { name: "Inspect original work" }),
  ).toBeNull();
  expect(
    screen.getByText("No worker conversation was created for this call."),
  ).toBeTruthy();
  expect(paths.some((path) => path.includes("/threads/"))).toBe(false);
});
it("does not request a worker supplied in the URL unless it belongs to the selected call", async () => {
  const paths = mount({ foreignThread: true });
  await waitFor(() =>
    expect(paths.some((path) => path.endsWith("/calls/call"))).toBe(true),
  );
  await screen.findByText("This conversation is unavailable.");
  expect(paths.some((path) => path.includes("/threads/"))).toBe(false);
});
it("hides execution details when current access is denied", async () => {
  const paths = mount({ deny: true });
  await screen.findByRole("alert");
  expect(screen.queryByText("Converted")).toBeNull();
  expect(paths).toEqual(["/control-plane/user/workflows/run/inspection"]);
});
