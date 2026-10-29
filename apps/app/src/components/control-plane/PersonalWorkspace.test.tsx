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
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { installPluginRuntime } from "@/lib/plugin-frontend";

const queries: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const query of queries.splice(0)) query.clear();
  Reflect.deleteProperty(globalThis, "__bbPluginRuntime");
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
function HistoryControls() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate(-1)}>History back</button>
      <button onClick={() => navigate(1)}>History forward</button>
    </>
  );
}
function CurrentLocation() {
  const location = useLocation();
  return (
    <output data-testid="current-location">
      {location.pathname + location.search}
    </output>
  );
}
function mount(fetcher: typeof fetch, entry = "/control-plane/app") {
  installPluginRuntime();
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
      <MemoryRouter initialEntries={[entry]}>
        <HistoryControls />
        <CurrentLocation />
        <PersonalWorkspace client={client} />
      </MemoryRouter>
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
  expect(
    screen.queryByRole("tablist", { name: "Right panel views" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Show right panel" })).toBeNull();
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

it.each(["/projects/off-page/threads/direct", "/threads/direct"])(
  "opens authorized direct links outside the loaded navigation pages: %s",
  async (entry) => {
    const paths: string[] = [];
    mount(async (input) => {
      const path = new URL(input.toString()).pathname;
      paths.push(path);
      if (path.endsWith("/bootstrap")) return Response.json(bootstrap);
      if (path.endsWith("/threads/direct"))
        return Response.json(thread("direct", "off-page"));
      if (path.endsWith("/projects/off-page"))
        return Response.json(project("off-page"));
      if (path.endsWith("/threads"))
        return Response.json({ threads: [], nextCursor: null });
      return Response.json({ error: "not_found" }, { status: 404 });
    }, entry);
    await screen.findByRole("heading", { name: "Thread direct" });
    expect(
      screen
        .getByRole("button", { name: "Project off-page" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen
        .getByRole("button", { name: "Thread direct" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(paths.every((path) => path.startsWith("/control-plane/user/"))).toBe(
      true,
    );
  },
);

it("opens an approved agent from the BB sidebar and carries it into a new conversation", async () => {
  const agentId = "11111111-1111-4111-8111-111111111111";
  const versionId = "22222222-2222-4222-8222-222222222222";
  const agent = {
    id: agentId,
    slug: "research",
    name: "Research agent",
    enabled: true,
    createdAt: 1,
    latestVersionId: versionId,
    latestVersion: 3,
  };
  const paths: string[] = [];
  mount(async (input) => {
    const url = new URL(input.toString());
    paths.push(url.pathname);
    if (url.pathname.endsWith("/bootstrap")) return Response.json(bootstrap);
    if (url.pathname.endsWith("/projects/a"))
      return Response.json(project("a"));
    if (url.pathname.endsWith("/threads"))
      return Response.json({ threads: [], nextCursor: null });
    if (url.pathname.endsWith("/profiles"))
      return Response.json({ profiles: [agent], nextCursor: null });
    if (url.pathname.endsWith(`/profiles/${agentId}/versions/${versionId}`))
      return Response.json({
        profile: agent,
        version: {
          id: versionId,
          profileId: agentId,
          version: 3,
          enabled: true,
          createdAt: 1,
          definition: {
            purpose: "Investigate questions in this project.",
            prompt: "Research carefully",
            providerId: "qwen-server",
            model: "qwen-test",
            reasoningLevel: "medium",
            permissionMode: "accept-edits",
            tools: [],
            mcpServers: [],
          },
        },
      });
    throw new Error(`Unexpected request ${url.pathname}`);
  }, "/projects/a");
  fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
  await screen.findByRole("heading", { name: "Agents" });
  fireEvent.click(
    await screen.findByRole("button", { name: /Research agent/u }),
  );
  await screen.findByText("qwen-test");
  await screen.findByText("Investigate questions in this project.");
  fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
  await waitFor(() =>
    expect(screen.getByTestId("current-location").textContent).toBe(
      `/projects/a?agent=${agentId}`,
    ),
  );
  await screen.findByRole("combobox", { name: "Agent profile" });
  expect(paths.every((path) => path.startsWith("/control-plane/user/"))).toBe(
    true,
  );
});

it.each([
  "/projects/a/threads/foreign",
  "/projects/a/threads/mismatched",
  "/projects/a/threads/owned#msg=9007199254740992",
])(
  "hides conversation and composer for denied or inconsistent links: %s",
  async (entry) => {
    const paths: string[] = [];
    mount(async (input) => {
      const path = new URL(input.toString()).pathname;
      paths.push(path);
      if (path.endsWith("/bootstrap")) return Response.json(bootstrap);
      if (path.endsWith("/projects/a")) return Response.json(project("a"));
      if (path.endsWith("/threads/mismatched"))
        return Response.json(thread("mismatched", "b"));
      if (path.endsWith("/threads/owned"))
        return Response.json(thread("owned", "a"));
      if (path.endsWith("/threads"))
        return Response.json({ threads: [], nextCursor: null });
      return Response.json({ error: "not_found" }, { status: 404 });
    }, entry);
    await screen.findByRole("alert");
    expect(screen.queryByRole("heading", { name: /Thread/ })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      paths.some((path) =>
        /\/(timeline|stream|profile|interactions)$/u.test(path),
      ),
    ).toBe(false);
  },
);

it("restores project selection with browser history without relying on prior component selection", async () => {
  mount(async (input) => {
    const path = new URL(input.toString()).pathname;
    if (path.endsWith("/bootstrap")) return Response.json(bootstrap);
    if (path.endsWith("/projects/a")) return Response.json(project("a"));
    if (path.endsWith("/projects/b")) return Response.json(project("b"));
    if (path.endsWith("/threads"))
      return Response.json({ threads: [], nextCursor: null });
    return Response.json({ error: "not_found" }, { status: 404 });
  }, "/projects/a");
  await screen.findByRole("heading", { name: "Project a" });
  fireEvent.click(screen.getByRole("button", { name: "Project b" }));
  await screen.findByRole("heading", { name: "Project b" });
  fireEvent.click(screen.getByRole("button", { name: "History back" }));
  await screen.findByRole("heading", { name: "Project a" });
  fireEvent.click(screen.getByRole("button", { name: "History forward" }));
  await screen.findByRole("heading", { name: "Project b" });
});

it("opens workflows in the main workspace and keeps the conversation/sidebar navigation", async () => {
  const paths: string[] = [];
  mount(async (input) => {
    const url = new URL(input.toString());
    paths.push(url.pathname);
    if (url.pathname.endsWith("/bootstrap")) return Response.json(bootstrap);
    if (url.pathname.endsWith("/projects/a"))
      return Response.json(project("a"));
    if (url.pathname.endsWith("/workflow-definitions"))
      return Response.json({ definitions: [], nextCursor: null });
    if (url.pathname.endsWith("/workflows"))
      return Response.json({ runs: [], nextCursor: null });
    if (url.pathname.endsWith("/threads"))
      return Response.json({ threads: [], nextCursor: null });
    if (url.pathname.endsWith("/profiles"))
      return Response.json({ profiles: [], nextCursor: null });
    throw new Error(`Unexpected request ${url.pathname}`);
  }, "/projects/a?view=workflows");
  await screen.findByRole("heading", { name: "Workflows" });
  expect(
    screen.queryByRole("textbox", { name: "Message your agent…" }),
  ).toBeNull();
  expect(await screen.findByLabelText("Workflow source")).not.toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Run workflow" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(document.querySelector('[data-sidebar="sidebar"]')).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
  await screen.findByRole("heading", { name: "Project a" });
  fireEvent.click(screen.getByRole("button", { name: "Workflows" }));
  await screen.findByRole("heading", { name: "Workflows" });
  expect(paths.every((path) => path.startsWith("/control-plane/user/"))).toBe(
    true,
  );
});

it("opens the personal automation section from a deep link and returns to the same conversation without exposing native APIs", async () => {
  const paths: string[] = [];
  mount(async (input) => {
    const url = new URL(input.toString());
    paths.push(url.pathname);
    if (url.pathname.endsWith("/bootstrap")) return Response.json(bootstrap);
    if (url.pathname.endsWith("/projects/a"))
      return Response.json(project("a"));
    if (url.pathname.endsWith("/threads/one"))
      return Response.json(thread("one", "a"));
    if (url.pathname.endsWith("/threads"))
      return Response.json({ threads: [thread("one", "a")], nextCursor: null });
    if (url.pathname.endsWith("/automations"))
      return Response.json({ automations: [], nextCursor: null });
    if (url.pathname.endsWith("/profiles"))
      return Response.json({ profiles: [], nextCursor: null });
    return Response.json({ error: "not_found" }, { status: 404 });
  }, "/projects/a/threads/one?view=automations");
  await screen.findByRole("heading", { name: "Automations" });
  expect(
    screen.queryByRole("textbox", { name: "Message your agent…" }),
  ).toBeNull();
  expect(document.querySelector('[data-sidebar="sidebar"]')).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "New automation" }));
  await screen.findByRole("form", { name: "Automation editor" });
  fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
  await screen.findByRole("heading", { name: "Thread one" });
  expect(screen.queryByRole("form", { name: "Automation editor" })).toBeNull();
  expect(paths.every((path) => path.startsWith("/control-plane/user/"))).toBe(
    true,
  );
});
