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
import { createControlPlaneClient } from "@bb/sdk/browser";
import { afterEach, expect, it } from "vitest";
import { PersonalProjectMcp } from "./PersonalProjectMcp";

const caches: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const cache of caches.splice(0)) cache.clear();
});
const connector = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "jira",
  name: "Jira",
  endpoint: "https://mcp.example/jira",
  revision: 1,
  enabled: true,
  transport: "streamable-http",
  authentication: "bearer",
  createdAt: 1,
  updatedAt: 1,
};
const connection = {
  id: "22222222-2222-4222-8222-222222222222",
  projectId: "a",
  connectorId: connector.id,
  connectorRevision: 1,
  revision: 3,
  enabled: false,
  createdAt: 1,
  updatedAt: 1,
  name: "Jira",
  slug: "jira",
  readiness: "configured",
  executionState: "not_activated",
};
function fixture({
  canManage = true,
  configured = false,
  attached = false,
  revision = 1,
} = {}) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  caches.push(cache);
  let metadata = {
    connectorId: connector.id,
    revision: configured ? 1 : 0,
    connectorRevision: configured ? 1 : null,
    configured,
    updatedAt: configured ? 1 : null,
  };
  let rows = attached ? [connection] : [];
  let denied = false,
    conflict = false;
  let gate: Promise<void> | undefined;
  const mutations: Array<{ method: string; path: string; body: object }> = [];
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: async (input, init) => {
      const url = new URL(input.toString()),
        method = init?.method ?? "GET";
      if (!url.pathname.startsWith("/control-plane/user/"))
        throw new Error("Unexpected privileged request");
      if (denied) return Response.json({ error: "denied" }, { status: 403 });
      if (method !== "GET") {
        const body: unknown = JSON.parse(String(init?.body));
        if (body === null || typeof body !== "object")
          throw new Error("Expected object");
        mutations.push({ method, path: url.pathname, body });
        if (conflict)
          return Response.json(
            {
              error: "conflict",
              message:
                "token" in body && typeof body.token === "string"
                  ? body.token
                  : "Conflict",
            },
            { status: 409 },
          );
        if (url.pathname.endsWith("/credential")) {
          await gate;
          metadata = {
            ...metadata,
            revision: metadata.revision + 1,
            configured: method === "PUT",
            connectorRevision: revision,
            updatedAt: 2,
          };
          return Response.json(metadata);
        }
        if (method === "DELETE") {
          rows = [];
          return Response.json({ ok: true });
        }
        rows = [
          {
            ...connection,
            revision: 4,
            connectorRevision: revision,
            enabled: true,
            executionState: "enabled",
          },
        ];
        return Response.json(rows[0]);
      }
      if (url.pathname.endsWith("/credential")) return Response.json(metadata);
      if (url.pathname.endsWith("/mcp"))
        return Response.json({ connections: rows, executionSupported: true });
      return Response.json({
        connectors: [{ ...connector, revision }],
        nextCursor: null,
      });
    },
  });
  const view = (userId = "alice", projectId = "a") => (
    <QueryClientProvider client={cache}>
      <PersonalProjectMcp
        key={userId + ":" + projectId}
        client={client}
        projectId={projectId}
        userId={userId}
        canManage={canManage}
      />
    </QueryClientProvider>
  );
  const mounted = render(view());
  return {
    cache,
    mutations,
    deny: () => {
      denied = true;
    },
    conflict: () => {
      conflict = true;
    },
    gate: (value: Promise<void>) => {
      gate = value;
    },
    switchIdentity: () => mounted.rerender(view("bob", "b")),
  };
}
async function choose() {
  await screen.findByRole("option", { name: "Jira" });
  fireEvent.change(
    screen.getByRole("combobox", { name: "Approved connector" }),
    {
      target: { value: connector.id },
    },
  );
  return screen.findByLabelText("Personal token");
}
it("clears a submitted PAT immediately and keeps it out of query and mutation caches while saving and activating with exact revisions", async () => {
  const f = fixture();
  const input = await choose();
  let release = () => {};
  f.gate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const secret = "private-pat-do-not-cache";
  fireEvent.change(input, { target: { value: secret } });
  fireEvent.click(screen.getByRole("button", { name: "Save personal token" }));
  expect(input).toHaveProperty("value", "");
  expect(
    JSON.stringify(
      f.cache
        .getQueryCache()
        .getAll()
        .map((query) => query.state),
    ),
  ).not.toContain(secret);
  expect(f.cache.getMutationCache().getAll()).toEqual([]);
  expect(f.mutations[0]?.body).toEqual({
    token: secret,
    connectorRevision: 1,
    expectedRevision: 0,
  });
  await act(async () => release());
  const connect = screen.getByRole("button", { name: "Connect to project" });
  await waitFor(() => expect(connect).toHaveProperty("disabled", false));
  fireEvent.click(connect);
  await screen.findByRole("button", { name: "Disable connection" });
  expect(f.mutations[1]?.body).toEqual({
    connectorId: connector.id,
    connectorRevision: 1,
    expectedRevision: 0,
    enabled: true,
  });
  expect(document.body.textContent).not.toContain(secret);
});
it("lets a reader manage only their own credential and hides project mutations", async () => {
  const f = fixture({ canManage: false, attached: true, configured: true });
  await choose();
  expect(
    screen.queryByRole("button", {
      name: /Connect to project|Update and enable|Disable connection|Remove Jira/u,
    }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Forget personal token" }),
  );
  await waitFor(() =>
    expect(f.mutations[0]?.body).toEqual({ expectedRevision: 1 }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Forget personal token" }),
    ).toBeNull(),
  );
});
it("hides cached connection and credential forms after access loss and clears a draft on identity/project change", async () => {
  const f = fixture({ attached: true, configured: true });
  const input = await choose();
  fireEvent.change(input, { target: { value: "unsent-private-draft" } });
  f.deny();
  fireEvent.click(screen.getByRole("button", { name: "Refresh integrations" }));
  await screen.findByRole("alert");
  expect(screen.queryByLabelText("Personal token")).toBeNull();
  expect(screen.queryByRole("button", { name: "Manage Jira" })).toBeNull();
  f.switchIdentity();
  expect(screen.queryByLabelText("Personal token")).toBeNull();
  expect(f.mutations).toEqual([]);
});
it("requires a new credential binding for a changed connector revision and preserves CAS on failure", async () => {
  const f = fixture({ attached: true, configured: true, revision: 2 });
  const input = await choose();
  expect(
    screen.getByRole("button", { name: "Update and enable" }),
  ).toHaveProperty("disabled", true);
  f.conflict();
  fireEvent.change(input, { target: { value: "conflicting-private-pat" } });
  fireEvent.click(screen.getByRole("button", { name: "Save personal token" }));
  await screen.findByRole("alert");
  expect(f.mutations[0]?.body).toEqual({
    token: "conflicting-private-pat",
    connectorRevision: 2,
    expectedRevision: 1,
  });
  expect(input).toHaveProperty("value", "");
  expect(document.body.textContent).not.toContain("conflicting-private-pat");
  expect(f.mutations).toHaveLength(1);
});

it("unmounts an unsent credential draft when switching to another identity and project", async () => {
  const f = fixture();
  const input = await choose();
  fireEvent.change(input, { target: { value: "unsent-alice-only-token" } });
  f.switchIdentity();
  expect(screen.queryByLabelText("Personal token")).toBeNull();
  const next = await choose();
  expect(next).toHaveProperty("value", "");
  expect(f.mutations).toEqual([]);
});
