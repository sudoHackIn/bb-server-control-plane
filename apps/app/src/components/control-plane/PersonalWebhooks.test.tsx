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
import { PersonalWebhooks } from "./PersonalWebhooks";
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});
it("creates a pinned webhook, shows its secret once and exposes delivery failure and run navigation", async () => {
  const id = "11111111-1111-4111-8111-111111111111",
    version = "22222222-2222-4222-8222-222222222222";
  const hook = {
    id,
    name: "Incoming tasks",
    projectId: "project",
    profileVersionId: version,
    inputField: "task",
    enabled: true,
    createdAt: 1,
    deliveryPath: `/control-plane/webhooks/${id}/deliver`,
  };
  let created = false;
  const requests: unknown[] = [];
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
      if (path.endsWith("/webhooks") && init?.method === "POST") {
        created = true;
        requests.push(JSON.parse(String(init.body)));
        return Response.json({
          webhook: hook,
          secret: `whk_${"a".repeat(43)}`,
        });
      }
      if (path.endsWith("/webhooks"))
        return Response.json({
          webhooks: created ? [hook] : [],
          nextCursor: null,
        });
      if (path.endsWith("/history"))
        return Response.json({
          deliveries: [
            {
              id,
              webhookId: id,
              deliveryKey: "invalid-event",
              state: "failed",
              runId: null,
              error: "invalid_webhook_input",
              createdAt: 1,
              updatedAt: 2,
            },
            {
              id: version,
              webhookId: id,
              deliveryKey: "valid-event",
              state: "accepted",
              runId: "thr_child",
              error: null,
              createdAt: 2,
              updatedAt: 3,
            },
          ],
          nextCursor: null,
        });
      if (init?.method === "PUT") {
        hook.enabled = false;
        return Response.json(hook);
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
        <PersonalWebhooks client={client} projectId="project" canCreate />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole("option", { name: "Helper" });
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Incoming tasks" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Agent" }), {
    target: { value: version },
  });
  fireEvent.change(screen.getByLabelText("Text field"), {
    target: { value: "task" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create webhook" }));
  await screen.findByText("Save your webhook secret");
  expect(requests).toEqual([
    {
      projectId: "project",
      profileVersionId: version,
      name: "Incoming tasks",
      inputField: "task",
    },
  ]);
  expect(screen.getByLabelText("Secret").getAttribute("type")).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss secret" }));
  expect(screen.queryByLabelText("Secret")).toBeNull();
  await screen.findByText("The selected field must contain task text.");
  expect(
    screen.getByRole("link", { name: "Open run" }).getAttribute("href"),
  ).toContain("thr_child");
  fireEvent.click(screen.getByRole("button", { name: "Disable" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Enable" })).toBeTruthy(),
  );
});
