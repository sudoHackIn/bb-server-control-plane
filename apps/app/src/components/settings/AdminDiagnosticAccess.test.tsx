// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, it, expect } from "vitest";
import { createControlPlaneClient } from "@bb/sdk/browser";
import { AdminDiagnosticAccess } from "./AdminDiagnosticAccess";
const caches: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const cache of caches.splice(0)) cache.clear();
});
it("requires an explicit diagnostic role and sends the loaded revision, surfacing a conflicting administrator update", async () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const bodies: object[] = [];
  let revision = 4;
  const client = createControlPlaneClient({
    origin: "https://server.example",
    fetch: async (input, init) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/control-plane/admin/users")
        return Response.json({
          users: [
            {
              userId,
              login: "reviewer",
              enabled: true,
              environmentStatus: "ready",
            },
          ],
          nextCursor: null,
        });
      if (path.endsWith(`/diagnostics/${userId}`)) {
        if (init?.method === "PUT") {
          const body: unknown = JSON.parse(String(init.body));
          if (typeof body !== "object" || body === null)
            throw new Error("Expected grant body");
          bodies.push(body);
          revision = 5;
          return Response.json(
            { error: "diagnostic_revision_conflict" },
            { status: 409 },
          );
        }
        return Response.json({
          grant: {
            projectId: "project",
            userId,
            login: "reviewer",
            role: "developer",
            revision,
            updatedAt: 1,
            updatedBy: "admin",
          },
        });
      }
      throw new Error(`Unexpected ${path}`);
    },
  });
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  caches.push(cache);
  render(
    <MemoryRouter>
      <QueryClientProvider client={cache}>
        <AdminDiagnosticAccess client={client} projectId="project" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Manage diagnostic grants" }),
  );
  await screen.findByRole("option", { name: "reviewer" });
  fireEvent.change(screen.getByRole("combobox", { name: "Diagnostic user" }), {
    target: { value: userId },
  });
  await screen.findByText("Current access: developer · revision 4");
  fireEvent.change(screen.getByRole("combobox", { name: "Diagnostic role" }), {
    target: { value: "none" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save diagnostic access" }),
  );
  await screen.findByRole("alert");
  expect(bodies).toEqual([{ role: null, expectedRevision: 4 }]);
  await waitFor(() =>
    expect(
      screen.getByText("Current access: developer · revision 5"),
    ).toBeTruthy(),
  );
  expect(
    screen
      .getByRole("link", { name: "Inspect all project runs as administrator" })
      .getAttribute("href"),
  ).toBe("/settings/projects/project/inspections");
});
