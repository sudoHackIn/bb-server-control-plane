// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, it, expect, vi } from "vitest";
import { createControlPlaneClient } from "@bb/sdk/browser";
import { RunInspections } from "./RunInspections";
vi.mock("./PersonalTimeline", () => ({
  PersonalTimeline: ({ threadId }: { threadId: string }) => (
    <p>Read-only conversation {threadId}</p>
  ),
}));
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const cache of clients.splice(0)) cache.clear();
});
it("uses only diagnostic routes and removes a selected foreign conversation when the grant is revoked", async () => {
  let revoked = false;
  const paths: string[] = [];
  const client = createControlPlaneClient({
    origin: "https://server.example",
    fetch: async (input) => {
      const path = new URL(input.toString()).pathname;
      paths.push(path);
      if (path === "/control-plane/user/inspections")
        return Response.json({
          project: {
            projectId: "project",
            name: "Reviewed project",
            cwd: "/workspace",
          },
          runs: revoked
            ? []
            : [
                {
                  kind: "thread",
                  id: "foreign",
                  title: "Review conversation",
                  projectId: "project",
                  ownerUserId: "11111111-1111-4111-8111-111111111111",
                },
              ],
          nextCursor: null,
        });
      if (path === "/control-plane/user/inspections/threads/foreign")
        return revoked
          ? Response.json({ error: "inspection_not_found" }, { status: 404 })
          : Response.json({
              id: "foreign",
              projectId: "project",
              profileVersionId: null,
              title: "Review conversation",
              status: "idle",
              createdAt: 1,
              updatedAt: 2,
              archived: false,
            });
      throw new Error(`Unexpected route ${path}`);
    },
  });
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(cache);
  render(
    <MemoryRouter initialEntries={["/projects/project?view=inspections"]}>
      <QueryClientProvider client={cache}>
        <RunInspections client={client.inspections} projectId="project" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: /Review conversation/ }),
  );
  await screen.findByText("Read-only conversation foreign");
  expect(screen.queryByRole("textbox")).toBeNull();
  revoked = true;
  await act(async () => {
    await cache.invalidateQueries();
  });
  await screen.findByRole("alert");
  await waitFor(() =>
    expect(screen.queryByText("Read-only conversation foreign")).toBeNull(),
  );
  expect(
    paths.every((path) => path.startsWith("/control-plane/user/inspections")),
  ).toBe(true);
});
