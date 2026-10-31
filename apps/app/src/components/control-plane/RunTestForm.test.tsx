// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { createControlPlaneClient } from "@bb/sdk/browser";
import { RunTestForm } from "./RunTestForm";
const caches: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const c of caches.splice(0)) c.clear();
});
function Location() {
  return (
    <output aria-label="Location">
      {useLocation().pathname + useLocation().search}
    </output>
  );
}
const profile = "11111111-1111-4111-8111-111111111111";
const record = {
  id: "22222222-2222-4222-8222-222222222222",
  runId: "new-run",
  sourceRunId: "source",
  sourceProjectId: "production",
  ownerUserId: profile,
  projectId: "test-project",
  requestedBy: `user:${profile}`,
  target: { kind: "published", profileVersionId: profile },
  input: "captured input",
  sourceHash: "original",
  testedSourceHash: "test-source",
  profile: {
    prompt: "Agent",
    providerId: "qwen-server",
    model: "qwen",
    reasoningLevel: "none",
    permissionMode: "full",
    tools: [],
    mcpServers: [],
  },
  state: "started",
  createdAt: 1,
};

it("keeps the same request key after an admission failure and opens a separate test with captured provenance", async () => {
  const requests: object[] = [];
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: async (input, init) => {
      expect(new URL(String(input)).pathname).toMatch(
        /^\/control-plane\/user\/test-runs/u,
      );
      if (init?.method === "POST") {
        requests.push(JSON.parse(String(init.body)));
        if (requests.length === 1)
          return Response.json(
            { error: "temporarily_unavailable" },
            { status: 503 },
          );
      }
      if (new URL(String(input)).pathname.includes("/by-run/"))
        return Response.json({ testRun: null });
      return Response.json(record);
    },
  });
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  caches.push(cache);
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={["/projects/production?view=inspections"]}>
        <RunTestForm client={client.testRuns} sourceRunId="source" />
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Prepare separate test" }),
  );
  expect(screen.queryByLabelText("Execution user UUID")).toBeNull();
  fireEvent.change(screen.getByLabelText("Test project ID"), {
    target: { value: "test-project" },
  });
  fireEvent.change(screen.getByLabelText("Profile version UUID"), {
    target: { value: profile },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start separate test" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Start separate test" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Location").textContent).toContain(
      "inspectRun=new-run",
    ),
  );
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]).toMatchObject({
    sourceRunId: "source",
    projectId: "test-project",
    target: { kind: "published", profileVersionId: profile },
  });
  expect(requests[0]).not.toHaveProperty("input");
  expect(screen.getByLabelText("Location").textContent).toContain(
    `testRun=${record.id}`,
  );
});

it("finds a draft test by native run ID after reopening and displays its pinned revision and profile", async () => {
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: async (input) => {
      expect(new URL(String(input)).pathname).toBe(
        "/control-plane/user/test-runs/by-run/new-run",
      );
      return Response.json({
        testRun: {
          ...record,
          target: {
            kind: "draft",
            profileVersionId: profile,
            definitionId: "wfd_saved",
            revision: 1,
          },
        },
      });
    },
  });
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  caches.push(cache);
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter
        initialEntries={[
          "/projects/test-project?view=inspections&inspectRun=new-run",
        ]}
      >
        <RunTestForm client={client.testRuns} sourceRunId="new-run" />
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByText("Draft: wfd_saved · revision 1");
  expect(screen.getByText(`Profile version: ${profile}`)).toBeTruthy();
  expect(screen.getByText("Tested profile configuration")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open source run" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Location").textContent).toContain(
      "/projects/production?view=inspections&inspectKind=workflow&inspectRun=source",
    ),
  );
});
