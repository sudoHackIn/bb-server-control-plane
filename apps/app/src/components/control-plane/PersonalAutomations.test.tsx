// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { createControlPlaneClient } from "@bb/sdk/browser";
import { afterEach, expect, it, vi } from "vitest";
import { PersonalAutomations } from "./PersonalAutomations";
const caches: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const cache of caches.splice(0)) cache.clear();
});
const saved = {
  id: "auto_saved",
  projectId: "a",
  name: "Morning review",
  enabled: true,
  trigger: { triggerType: "once", runAt: Date.now() + 3600000 },
  createdByThreadId: "saved-origin",
  nextRunAt: null,
  lastRunAt: null,
  runCount: 0,
  lastRunStatus: null,
  lastRunThreadId: null,
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
  prompt: "Review my project",
};
function metadata() {
  const { revision: _revision, prompt: _prompt, ...row } = saved;
  return row;
}
const run = {
  id: "run_saved",
  automationId: saved.id,
  threadId: "worker",
  status: "running",
  trigger: "manual",
  skipReason: null,
  error: null,
  scheduledFor: 1,
  startedAt: 1,
  finishedAt: null,
};
function CurrentLocation() {
  const location = useLocation();
  return (
    <output aria-label="Workspace URL">
      {location.pathname + location.search}
    </output>
  );
}
function mount(
  fetcher: typeof fetch,
  options: {
    canExecute?: boolean;
    origin?: string | null;
    selected?: boolean;
  } = {},
) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  caches.push(cache);
  const client = createControlPlaneClient({
    origin: "https://agents.example",
    fetch: fetcher,
  });
  const open = vi.fn();
  const view = (projectId: string) => (
    <QueryClientProvider client={cache}>
      <MemoryRouter
        initialEntries={[
          `/projects/a?view=automations${options.selected ? "&automation=auto_saved" : ""}`,
        ]}
      >
        <CurrentLocation />
        <PersonalAutomations
          key={projectId}
          client={client}
          projectId={projectId}
          originThreadId={
            options.origin === undefined ? "current-origin" : options.origin
          }
          canExecute={options.canExecute ?? true}
          onOpenThread={open}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const rendered = render(view("a"));
  return {
    cache,
    open,
    switchProject: (id: string) => rendered.rerender(view(id)),
  };
}
function read(url: URL) {
  if (url.pathname.endsWith("/definition")) return Response.json(saved);
  if (url.pathname.endsWith("/history"))
    return Response.json({
      automationId: saved.id,
      runs: [run],
      nextCursor: null,
    });
  return Response.json({ automations: [metadata()], nextCursor: null });
}
it("creates from the current origin, edits with CAS, preserves rejected drafts and explicitly reloads the latest saved revision", async () => {
  const writes: Array<{ method: string; body: unknown }> = [];
  let revision = 1;
  let conflict = false;
  mount(async (input, init) => {
    const url = new URL(input.toString());
    if (init?.method === "POST" || init?.method === "PUT") {
      writes.push({ method: init.method, body: JSON.parse(String(init.body)) });
      if (conflict)
        return Response.json(
          { error: "automation_revision_conflict" },
          { status: 409 },
        );
      return Response.json({ ...metadata(), revision });
    }
    if (url.pathname.endsWith("/definition"))
      return Response.json({ ...saved, revision });
    return read(url);
  });
  fireEvent.click(screen.getByRole("button", { name: "New automation" }));
  fireEvent.change(screen.getByLabelText("Automation name"), {
    target: { value: saved.name },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Agent task" }), {
    target: { value: saved.prompt },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable automation" }));
  fireEvent.submit(screen.getByRole("form", { name: "Automation editor" }));
  await screen.findByText("Edit automation · v1");
  expect(writes[0]?.body).toMatchObject({
    originThreadId: "current-origin",
    enabled: false,
    name: saved.name,
    prompt: saved.prompt,
    trigger: { triggerType: "once" },
  });
  revision = 2;
  fireEvent.change(screen.getByRole("combobox", { name: "Schedule type" }), {
    target: { value: "schedule" },
  });
  fireEvent.change(screen.getByLabelText("Cron expression"), {
    target: { value: "0 12 * * *" },
  });
  fireEvent.change(screen.getByLabelText("Schedule timezone"), {
    target: { value: "UTC" },
  });
  fireEvent.submit(screen.getByRole("form", { name: "Automation editor" }));
  await screen.findByText("Edit automation · v2");
  expect(writes[1]?.body).toEqual({
    expectedRevision: 1,
    name: saved.name,
    prompt: saved.prompt,
    trigger: { triggerType: "schedule", cron: "0 12 * * *", timezone: "UTC" },
  });
  conflict = true;
  revision = 3;
  fireEvent.change(screen.getByRole("textbox", { name: "Agent task" }), {
    target: { value: "Keep my unsaved draft" },
  });
  fireEvent.submit(screen.getByRole("form", { name: "Automation editor" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("textbox", { name: "Agent task" })).toHaveProperty(
    "value",
    "Keep my unsaved draft",
  );
  expect(writes[2]?.body).toMatchObject({ expectedRevision: 2 });
  fireEvent.click(screen.getByRole("button", { name: "Refresh automations" }));
  await screen.findByText(/A newer revision/u);
  expect(screen.getByRole("textbox", { name: "Agent task" })).toHaveProperty(
    "value",
    "Keep my unsaved draft",
  );
  revision = 4;
  fireEvent.click(
    screen.getByRole("button", { name: "Reload saved automation" }),
  );
  await screen.findByText("Edit automation · v4");
  expect(screen.getByRole("textbox", { name: "Agent task" })).toHaveProperty(
    "value",
    saved.prompt,
  );
});
it("reuses an unacknowledged dispatch key, paginates history and links only returned conversations", async () => {
  const keys: unknown[] = [];
  let running = 0;
  let more = false;
  const { open } = mount(
    async (input, init) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/run")) {
        keys.push(JSON.parse(String(init?.body)));
        running++;
        return running === 1
          ? Response.json({ error: "unavailable" }, { status: 503 })
          : Response.json(run);
      }
      if (url.pathname.endsWith("/history")) {
        if (url.searchParams.has("cursor")) {
          more = true;
          return Response.json({
            automationId: saved.id,
            runs: [{ ...run, id: "older", status: "succeeded" }],
            nextCursor: null,
          });
        }
        return Response.json({
          automationId: saved.id,
          runs: [run],
          nextCursor: "older-page",
        });
      }
      return read(url);
    },
    { selected: true },
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Run automation" }),
  );
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Run automation" }));
  await waitFor(() => expect(keys).toHaveLength(2));
  expect(keys[0]).toEqual(keys[1]);
  expect(keys[0]).toMatchObject({ idempotencyKey: expect.any(String) });
  fireEvent.click(screen.getByRole("button", { name: "More automation runs" }));
  await screen.findByText("older · succeeded · manual");
  expect(more).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Open origin conversation" }),
  );
  fireEvent.click(
    screen.getAllByRole("button", { name: "Open run conversation" })[0]!,
  );
  expect(open.mock.calls).toEqual([["saved-origin"], ["worker"]]);
});
it("keeps cleanup controls after execution access loss, confirms deletion, and removes cached source on read denial", async () => {
  const paths: string[] = [];
  let denied = false;
  const { cache } = mount(
    async (input, init) => {
      const url = new URL(input.toString());
      if (denied) return Response.json({ error: "not_found" }, { status: 404 });
      if (init?.method === "POST") {
        paths.push(url.pathname);
        return url.pathname.endsWith("/stop")
          ? Response.json({ stopped: true })
          : Response.json({ ...metadata(), enabled: false });
      }
      return read(url);
    },
    { selected: true, canExecute: false, origin: null },
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Pause automation" }),
  );
  await waitFor(() =>
    expect(paths).toContain("/control-plane/user/automations/auto_saved/pause"),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Stop run run_saved" }),
  );
  await waitFor(() =>
    expect(paths).toContain(
      "/control-plane/user/automations/auto_saved/runs/run_saved/stop",
    ),
  );
  expect(screen.queryByRole("button", { name: "New automation" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Run automation" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save automation" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Delete automation" }));
  await screen.findByRole("group", { name: "Confirm automation deletion" });
  fireEvent.click(screen.getByRole("button", { name: "Keep automation" }));
  expect(
    screen.queryByRole("button", { name: "Confirm delete automation" }),
  ).toBeNull();
  denied = true;
  await cache.invalidateQueries({ queryKey: ["personal", "automations", "a"] });
  await screen.findByRole("alert");
  expect(screen.queryByDisplayValue(saved.prompt)).toBeNull();
  expect(
    screen.queryByRole("region", { name: "Selected automation" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Delete automation" }),
  ).toBeNull();
});
it("traverses an empty list page with a cursor and fences delayed detail after a project switch", async () => {
  let complete: ((value: Response) => void) | undefined;
  const { switchProject } = mount(async (input) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith("/definition"))
      return new Promise((resolve) => {
        complete = resolve;
      });
    if (url.searchParams.get("projectId") === "a")
      return Response.json({
        automations: url.searchParams.has("cursor") ? [metadata()] : [],
        nextCursor: url.searchParams.has("cursor")
          ? null
          : "11111111-1111-4111-8111-111111111111",
      });
    return Response.json({ automations: [], nextCursor: null });
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "More automations" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Morning review · enabled" }),
  );
  await waitFor(() => expect(complete).toBeDefined());
  switchProject("b");
  complete?.(Response.json(saved));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Morning review · enabled" }),
    ).toBeNull(),
  );
  expect(screen.queryByDisplayValue(saved.prompt)).toBeNull();
});

it("rejects a mismatched detail projection and hides its prompt and controls", async () => {
  mount(
    async (input) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/definition"))
        return Response.json({ ...saved, projectId: "foreign" });
      return read(url);
    },
    { selected: true },
  );
  await screen.findByRole("alert");
  expect(screen.queryByDisplayValue(saved.prompt)).toBeNull();
  expect(screen.queryByRole("button", { name: "Run automation" })).toBeNull();
});

it("aborts an in-flight create and ignores its acknowledgement after the project changes", async () => {
  let complete: ((value: Response) => void) | undefined;
  let signal: AbortSignal | null | undefined;
  const { switchProject } = mount(async (input, init) => {
    if (init?.method === "POST") {
      signal = init.signal;
      return new Promise((resolve) => {
        complete = resolve;
      });
    }
    return Response.json({ automations: [], nextCursor: null });
  });
  fireEvent.click(screen.getByRole("button", { name: "New automation" }));
  fireEvent.change(screen.getByLabelText("Automation name"), {
    target: { value: saved.name },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Agent task" }), {
    target: { value: saved.prompt },
  });
  fireEvent.submit(screen.getByRole("form", { name: "Automation editor" }));
  await waitFor(() => expect(complete).toBeDefined());
  switchProject("b");
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    complete?.(Response.json({ ...metadata(), revision: 1 }));
  });
  expect(screen.getByLabelText("Workspace URL").textContent).not.toContain(
    "automation=auto_saved",
  );
  await screen.findByText("No automations yet.");
  expect(
    screen.queryByRole("region", { name: "Selected automation" }),
  ).toBeNull();
  expect(screen.queryByDisplayValue(saved.prompt)).toBeNull();
});

it("creates a Node script with explicit timeout and reloads its source without a prompt", async () => {
  const scriptDefinition = {
    ...metadata(),
    executionMode: "script",
    revision: 1,
    script: { source: "console.log('saved script')", timeoutMs: 7000 },
  };
  const requests: unknown[] = [];
  mount(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "POST") {
      requests.push(await request.json());
      return Response.json(
        { ...metadata(), executionMode: "script", revision: 1 },
        { status: 201 },
      );
    }
    if (request.url.endsWith("/definition"))
      return Response.json(scriptDefinition);
    if (request.url.includes("/history"))
      return Response.json({
        automationId: saved.id,
        runs: [],
        nextCursor: null,
      });
    return Response.json({ automations: [], nextCursor: null });
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "New automation" }),
  );
  fireEvent.change(screen.getByLabelText("Automation type"), {
    target: { value: "script" },
  });
  expect(screen.queryByLabelText("Agent task")).toBeNull();
  fireEvent.change(screen.getByLabelText("Automation name"), {
    target: { value: "Script" },
  });
  fireEvent.change(screen.getByLabelText("Script source"), {
    target: { value: "console.log('saved script')" },
  });
  fireEvent.change(screen.getByLabelText("Script timeout (ms)"), {
    target: { value: "7000" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create automation" }));
  await screen.findByText("Edit automation · v1");
  expect(requests[0]).toMatchObject({
    script: { source: "console.log('saved script')", timeoutMs: 7000 },
  });
  expect(requests[0]).not.toHaveProperty("prompt");
  expect(screen.getByLabelText("Script source")).toHaveProperty(
    "value",
    "console.log('saved script')",
  );
});

it("loads script output only on demand and hides cached output when access is lost", async () => {
  let denied = false;
  let reads = 0;
  mount(
    async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/definition"))
        return Response.json({
          ...metadata(),
          executionMode: "script",
          revision: 1,
          script: { source: "console.log('x')", timeoutMs: 1000 },
        });
      if (request.url.includes("/history"))
        return Response.json({
          automationId: saved.id,
          runs: [
            { ...run, runMode: "script", threadId: null, status: "succeeded" },
          ],
          nextCursor: null,
        });
      if (request.url.endsWith("/output")) {
        reads++;
        return denied
          ? new Response("", { status: 403 })
          : Response.json({
              automationId: saved.id,
              runId: run.id,
              status: "succeeded",
              cleanupPending: false,
              error: null,
              result: {
                jobId: "c9424735-3ed4-4606-9906-85de93e48281",
                status: "succeeded",
                exitCode: 0,
                signal: null,
                stdout: "owned stdout",
                stderr: "owned stderr",
                outputBytes: 24,
                truncated: false,
              },
            });
      }
      return Response.json({ automations: [metadata()], nextCursor: null });
    },
    { selected: true },
  );
  const show = await screen.findByRole("button", {
    name: `Show script output ${run.id}`,
  });
  expect(reads).toBe(0);
  fireEvent.click(show);
  await screen.findByText("owned stdout");
  await screen.findByText("owned stderr");
  denied = true;
  fireEvent.click(
    screen.getByRole("button", { name: `Hide script output ${run.id}` }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: `Show script output ${run.id}` }),
  );
  await screen.findByText("Script output unavailable. Check access and retry.");
  expect(screen.queryByText("owned stdout")).toBeNull();
  expect(screen.queryByText("owned stderr")).toBeNull();
});
