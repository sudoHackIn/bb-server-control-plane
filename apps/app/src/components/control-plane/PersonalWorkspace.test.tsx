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
import { PersonalWorkspace } from "./PersonalWorkspace";

const queries: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const query of queries.splice(0)) query.clear();
});
const project = (id: string) => ({
  projectId: id,
  name: `Project ${id}`,
  slug: id,
  hostId: "host",
  cwd: `/srv/alice/${id}`,
  role: "owner",
  canRun: true,
  canManage: true,
});
const thread = (id: string, projectId: string) => ({
  id,
  projectId,
  title: `Thread ${id}`,
  profileVersionId: null,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  archived: false,
});
const bootstrap = {
  session: {
    role: "user",
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      login: "alice",
      environmentStatus: "ready",
    },
    expiresAt: 10000,
  },
  projects: {
    projects: [project("a"), project("b")],
    nextCursor: "next-project",
  },
  threads: { threads: [], nextCursor: null },
  profiles: { profiles: [], nextCursor: null },
  capabilities: {
    canCreateProjects: true,
    canInstallPlugins: false,
    canUseTerminals: false,
  },
};
function mount(fetcher: typeof fetch) {
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  queries.push(query);
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: fetcher,
  });
  return render(
    <QueryClientProvider client={query}>
      <PersonalWorkspace client={client} />
    </QueryClientProvider>,
  );
}

it("uses the native left sidebar with scoped project/thread pagination and never requests the administrative bootstrap or plugin runtime", async () => {
  const paths: string[] = [];
  mount(async (input) => {
    const url = new URL(input.toString());
    paths.push(url.pathname + url.search);
    if (url.pathname.endsWith("/bootstrap")) return Response.json(bootstrap);
    if (
      url.pathname.endsWith("/projects") &&
      url.searchParams.get("cursor") === "next-project"
    )
      return Response.json({ projects: [project("c")], nextCursor: null });
    if (url.pathname.endsWith("/projects/a"))
      return Response.json(project("a"));
    if (
      url.pathname.endsWith("/threads") &&
      url.searchParams.get("projectId") === "a"
    )
      return Response.json({
        threads: [thread(url.searchParams.has("cursor") ? "two" : "one", "a")],
        nextCursor: url.searchParams.has("cursor") ? null : "next-thread",
      });
    if (url.pathname.endsWith("/threads/two"))
      return Response.json(thread("two", "a"));
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  fireEvent.click(await screen.findByRole("button", { name: "More projects" }));
  await screen.findByRole("button", { name: "Project c" });
  fireEvent.click(screen.getByRole("button", { name: "Project a" }));
  fireEvent.click(await screen.findByRole("button", { name: "More threads" }));
  fireEvent.click(await screen.findByRole("button", { name: "Thread two" }));
  await screen.findByRole("heading", { name: "Thread two" });
  expect(document.querySelector('[data-sidebar="sidebar"]')).not.toBeNull();
  expect(paths.every((path) => path.startsWith("/control-plane/user/"))).toBe(
    true,
  );
  expect(
    screen.queryByRole("button", { name: /terminal|settings|plugins/iu }),
  ).toBeNull();
});

it("fences a slow previous-project response and removes revoked thread details", async () => {
  let completeOld: ((response: Response) => void) | undefined;
  let revoked = false;
  let projectRevoked = false;
  mount(async (input) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith("/bootstrap")) return Response.json(bootstrap);
    if (url.pathname.endsWith("/projects/a"))
      return Response.json(project("a"));
    if (url.pathname.endsWith("/projects/b"))
      return projectRevoked
        ? Response.json({ error: "not_found" }, { status: 404 })
        : Response.json(project("b"));
    if (
      url.pathname.endsWith("/threads") &&
      url.searchParams.get("projectId") === "a"
    )
      return new Promise((resolve) => {
        completeOld = resolve;
      });
    if (
      url.pathname.endsWith("/threads") &&
      url.searchParams.get("projectId") === "b"
    )
      return Response.json({
        threads: [thread("b-thread", "b")],
        nextCursor: null,
      });
    if (url.pathname.endsWith("/threads/b-thread"))
      return revoked
        ? Response.json({ error: "not_found" }, { status: 404 })
        : Response.json(thread("b-thread", "b"));
    throw new Error("Unexpected request");
  });
  fireEvent.click(await screen.findByRole("button", { name: "Project a" }));
  await waitFor(() => expect(completeOld).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Project b" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Thread b-thread" }),
  );
  await screen.findByRole("heading", { name: "Thread b-thread" });
  completeOld?.(
    Response.json({ threads: [thread("stale-a", "a")], nextCursor: null }),
  );
  expect(screen.queryByText("Thread stale-a")).toBeNull();
  revoked = true;
  await queries[0]?.invalidateQueries({
    queryKey: ["personal", "thread", "b-thread"],
  });
  await screen.findByRole("alert");
  expect(screen.queryByRole("heading", { name: "Thread b-thread" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Thread b-thread" })).toBeNull();
  projectRevoked = true;
  await queries[0]?.invalidateQueries({
    queryKey: ["personal", "project", "b"],
  });
  await waitFor(() => expect(screen.queryByText("Project b")).toBeNull());
});

it("hides the workspace if a subsequent authenticated bootstrap fails", async () => {
  let revoked = false;
  mount(async () =>
    revoked
      ? Response.json({ error: "authentication_required" }, { status: 401 })
      : Response.json(bootstrap),
  );
  await screen.findByRole("button", { name: "Project a" });
  revoked = true;
  await queries[0]?.invalidateQueries({ queryKey: ["personal", "bootstrap"] });
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Project a" })).toBeNull();
});
