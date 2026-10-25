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
import { afterEach, expect, it, vi } from "vitest";
import { PersonalWorkflowDefinitions } from "./PersonalWorkflowDefinitions";
const caches: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const cache of caches.splice(0)) cache.clear();
});
const script =
  'export const meta={name:"saved",description:"Saved"}; return args;';
const saved = {
  id: "wfd_saved",
  projectId: "a",
  originThreadId: "saved-origin",
  revision: 1,
  name: "saved",
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  script,
  args: { n: 1 },
};
function metadata(row: typeof saved) {
  const { script: _script, args: _args, ...value } = row;
  return value;
}
const run = {
  id: "wfr_saved",
  projectId: "a",
  originThreadId: "saved-origin",
  name: "saved",
  status: "queued",
  phase: null,
  error: null,
  resultAvailable: false,
  notificationOutcome: "pending",
  createdAt: 1,
  startedAt: null,
  finishedAt: null,
};
function mount(fetcher: typeof fetch, canExecute = true) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  caches.push(cache);
  const client = createControlPlaneClient({
    origin: "https://agents.example",
    fetch: fetcher,
  });
  const loaded = vi.fn();
  const started = vi.fn();
  const view = (projectId: string) => (
    <QueryClientProvider client={cache}>
      <PersonalWorkflowDefinitions
        key={projectId}
        client={client}
        projectId={projectId}
        originThreadId={canExecute ? "selected-origin" : null}
        canExecute={canExecute}
        script={script}
        args='{"n":2}'
        onLoad={loaded}
        onStarted={started}
      />
    </QueryClientProvider>
  );
  const rendered = render(view("a"));
  return {
    loaded,
    started,
    cache,
    switchProject: (id: string) => rendered.rerender(view(id)),
  };
}
it("saves, updates with optimistic revision, runs saved defaults, and controls enabled/deleted authority", async () => {
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  let current = saved;
  let exists = false;
  const { started } = mount(async (input, init) => {
    const url = new URL(input.toString());
    if (!init?.method || init.method === "GET")
      return Response.json({
        definitions: exists ? [metadata(current)] : [],
        nextCursor: null,
      });
    const body: unknown = init.body ? JSON.parse(String(init.body)) : null;
    writes.push({ path: url.pathname, method: init.method, body });
    if (url.pathname.endsWith("/run")) return Response.json(run);
    if (init.method === "DELETE") {
      exists = false;
      return Response.json({ deleted: true });
    }
    if (url.pathname.endsWith("/enabled"))
      current = { ...current, enabled: !current.enabled };
    else if (init.method === "PUT") current = { ...current, revision: 2 };
    else exists = true;
    return Response.json(current);
  });
  fireEvent.click(screen.getByRole("button", { name: "Save new definition" }));
  await screen.findByText(/Definition wfd_saved · v1/u);
  expect(writes[0]?.body).toEqual({
    originThreadId: "selected-origin",
    script,
    args: { n: 2 },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Update saved definition" }),
  );
  await screen.findByText(/Definition wfd_saved · v2/u);
  expect(writes[1]?.body).toEqual({
    expectedRevision: 1,
    script,
    args: { n: 2 },
  });
  fireEvent.click(screen.getByRole("button", { name: "Run saved workflow" }));
  await waitFor(() => expect(started).toHaveBeenCalledWith(run));
  expect(writes[2]?.body).toEqual({ revision: 2 });
  fireEvent.click(screen.getByRole("button", { name: "Disable definition" }));
  await screen.findByRole("button", { name: "Enable definition" });
  expect(
    screen.getByRole("button", { name: "Run saved workflow" }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Enable definition" }));
  await screen.findByRole("button", { name: "Disable definition" });
  fireEvent.click(screen.getByRole("button", { name: "Delete definition" }));
  await waitFor(() =>
    expect(screen.queryByText(/Definition wfd_saved/u)).toBeNull(),
  );
  expect(writes.at(-1)?.method).toBe("DELETE");
});
it("loads explicit saved source once, retains a stale-edit failure, and hides controls after read access is lost", async () => {
  let denied = false;
  const { loaded, cache } = mount(async (input, init) => {
    const url = new URL(input.toString());
    if (denied) return Response.json({ error: "not_found" }, { status: 404 });
    if (init?.method === "PUT")
      return Response.json({ error: "workflow_rejected" }, { status: 400 });
    if (url.pathname.endsWith("/enabled"))
      return Response.json({ ...saved, revision: 2, enabled: false });
    if (url.pathname.endsWith("/wfd_saved")) return Response.json(saved);
    return Response.json({ definitions: [metadata(saved)], nextCursor: null });
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Load saved · v1" }),
  );
  await waitFor(() => expect(loaded).toHaveBeenCalledWith(saved));
  fireEvent.click(screen.getByRole("button", { name: "Disable definition" }));
  await screen.findByRole("button", { name: "Enable definition" });
  expect(screen.getByText(/Definition wfd_saved · v1/u)).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Update saved definition" }),
  );
  await screen.findByRole("alert");
  expect(screen.getByText(/Definition wfd_saved · v1/u)).toBeTruthy();
  denied = true;
  await cache.invalidateQueries({
    queryKey: ["personal", "workflow-definitions", "a"],
  });
  await waitFor(() =>
    expect(screen.queryByText(/Definition wfd_saved/u)).toBeNull(),
  );
  expect(
    screen.queryByRole("button", { name: "Run saved workflow" }),
  ).toBeNull();
});
it("does not expose execution controls in a read-only workspace", async () => {
  mount(
    async (input) =>
      Response.json(
        new URL(input.toString()).pathname.endsWith("/wfd_saved")
          ? saved
          : { definitions: [metadata(saved)], nextCursor: null },
      ),
    false,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Load saved · v1" }),
  );
  await screen.findByText(/Definition wfd_saved/u);
  expect(
    screen.queryByRole("button", { name: "Run saved workflow" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Save new definition" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Update saved definition" }),
  ).toBeNull();
});
it("fences delayed source loads and resets loaded authority on project changes", async () => {
  let complete: ((value: Response) => void) | undefined;
  const { switchProject } = mount(async (input) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith("/wfd_saved"))
      return new Promise((resolve) => {
        complete = resolve;
      });
    return Response.json({
      definitions:
        url.searchParams.get("projectId") === "a" ? [metadata(saved)] : [],
      nextCursor: null,
    });
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Load saved · v1" }),
  );
  await waitFor(() => expect(complete).toBeDefined());
  switchProject("b");
  complete?.(Response.json(saved));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Load saved · v1" }),
    ).toBeNull(),
  );
  expect(screen.queryByText(/Definition wfd_saved/u)).toBeNull();
});
