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
import { afterEach, expect, it } from "vitest";
import { createControlPlaneClient } from "@bb/sdk/browser";
import { PersonalTaskSources } from "./PersonalTaskSources";
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});
it("creates paused sources, shows polling errors and navigates to native task runs", async () => {
  const id = "11111111-1111-4111-8111-111111111111",
    version = "22222222-2222-4222-8222-222222222222";
  const source = {
    id,
    projectId: "project",
    profileVersionId: version,
    kind: "beads",
    name: "Work",
    intervalSeconds: 300,
    enabled: false,
    checkpoint: null,
    nextPollAt: 1,
    lastPollAt: null,
    failures: 0,
    error: null as string | null,
    createdAt: 1,
  };
  const requests: unknown[] = [];
  let created = false;
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: async (input, init) => {
      const path = new URL(input.toString()).pathname;
      if (path.endsWith("/profiles"))
        return Response.json({
          profiles: [
            {
              id,
              slug: "helper",
              name: "Helper",
              enabled: true,
              createdAt: 1,
              latestVersionId: version,
              latestVersion: 1,
              strategy: "conversation",
            },
          ],
          nextCursor: null,
        });
      if (path.endsWith("/task-sources") && init?.method === "POST") {
        created = true;
        requests.push(JSON.parse(String(init.body)));
        return Response.json(source);
      }
      if (path.endsWith("/task-sources"))
        return Response.json({
          sources: created ? [source] : [],
          nextCursor: null,
        });
      if (path.endsWith("/history"))
        return Response.json({
          items: [
            {
              id,
              sourceId: id,
              externalId: "bd-task",
              title: "Task",
              state: "accepted",
              runId: "thr_task",
              error: null,
              createdAt: 1,
            },
          ],
          nextCursor: null,
        });
      if (path.endsWith("/poll")) {
        source.error = "poll_or_admission_failed";
        return Response.json(source);
      }
      if (init?.method === "PUT") {
        source.enabled = !source.enabled;
        return Response.json(source);
      }
      throw new Error("Unexpected request");
    },
  });
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(cache);
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter>
        <PersonalTaskSources client={client} projectId="project" canCreate />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole("option", { name: "Helper" });
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Work" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Agent" }), {
    target: { value: version },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect source" }));
  await screen.findByRole("button", { name: "Enable" });
  expect(requests[0]).toEqual({
    projectId: "project",
    profileVersionId: version,
    kind: "beads",
    name: "Work",
    intervalSeconds: 300,
  });
  expect(
    screen.getByRole("button", { name: "Poll now" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(
    (await screen.findByRole("link", { name: "Open run" })).getAttribute(
      "href",
    ),
  ).toContain("inspectRun=thr_task");
  fireEvent.click(screen.getByRole("button", { name: "Enable" }));
  await screen.findByRole("button", { name: "Pause" });
  fireEvent.click(screen.getByRole("button", { name: "Poll now" }));
  await waitFor(() =>
    expect(screen.getByText(/Polling or launch failed/)).toBeTruthy(),
  );
});
