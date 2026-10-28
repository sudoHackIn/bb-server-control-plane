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
import { AdminAgentProfiles } from "./AdminAgentProfiles";

const agentId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const versionIds = [
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];

afterEach(cleanup);

it("publishes an agent version and grants a registered user through the limited admin API", async () => {
  let version = 0;
  let granted = false;
  const requests: string[] = [];
  const definition = {
    purpose: "Investigate a project question.",
    prompt: "Original instructions",
    providerId: "qwen-server",
    model: "qwen-test",
    reasoningLevel: "medium",
    permissionMode: "accept-edits",
    tools: [],
    mcpServers: [],
  };
  const profile = () => ({
    id: agentId,
    slug: "research",
    name: "Research agent",
    enabled: true,
    createdAt: 1,
    latestVersionId: versionIds[version - 1],
    latestVersion: version,
  });
  const detail = () => ({
    profile: profile(),
    version: {
      id: versionIds[version - 1],
      profileId: agentId,
      version,
      enabled: true,
      createdAt: 1,
      definition,
    },
  });
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: async (input, init) => {
      const url = new URL(input.toString());
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/control-plane/admin/profiles") {
        if (init?.method === "POST") {
          const body: unknown = JSON.parse(String(init.body));
          expect(body).toMatchObject({
            slug: "research",
            name: "Research agent",
            definition: { purpose: "Investigate a project question." },
          });
          version = 1;
          return Response.json(detail());
        }
        return Response.json({
          profiles: version ? [profile()] : [],
          nextCursor: null,
        });
      }
      if (url.pathname === `/control-plane/admin/profiles/${agentId}`)
        return Response.json(detail());
      if (
        url.pathname === `/control-plane/admin/profiles/${agentId}/versions` &&
        init?.method === "POST"
      ) {
        const body: unknown = JSON.parse(String(init.body));
        expect(body).toMatchObject({
          definition: {
            purpose: "Investigate and summarize a project question.",
            prompt: "Revised instructions",
          },
        });
        version = 2;
        definition.purpose = "Investigate and summarize a project question.";
        definition.prompt = "Revised instructions";
        return Response.json(detail());
      }
      if (url.pathname === `/control-plane/admin/profiles/${agentId}/access`) {
        return Response.json({
          users: granted ? [{ userId, login: "alice", enabled: true }] : [],
          nextCursor: null,
        });
      }
      if (
        url.pathname ===
          `/control-plane/admin/profiles/${agentId}/access/${userId}` &&
        init?.method === "PUT"
      ) {
        granted = true;
        return Response.json({ ok: true });
      }
      if (url.pathname === "/control-plane/admin/users")
        return Response.json({
          users: [
            {
              userId,
              login: "alice",
              enabled: true,
              environmentStatus: "ready",
            },
          ],
          nextCursor: null,
        });
      throw new Error(`Unexpected ${init?.method ?? "GET"} ${url.pathname}`);
    },
  });
  render(
    <QueryClientProvider client={query}>
      <AdminAgentProfiles client={client} />
    </QueryClientProvider>,
  );
  expect(requests).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Manage server agents" }));
  await screen.findByRole("form", { name: "Agent editor" });
  fireEvent.change(screen.getByRole("textbox", { name: "Slug" }), {
    target: { value: "research" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Research agent" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Purpose" }), {
    target: { value: "Investigate a project question." },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Model" }), {
    target: { value: "qwen-test" },
  });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Agent instructions" }),
    { target: { value: "Original instructions" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
  await screen.findByText("Agent created");
  await screen.findByRole("button", { name: "Edit next version" });
  fireEvent.click(screen.getByRole("button", { name: "Edit next version" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Purpose" }), {
    target: { value: "Investigate and summarize a project question." },
  });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Agent instructions" }),
    { target: { value: "Revised instructions" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Publish version" }));
  await waitFor(() => expect(version).toBe(2));
  fireEvent.click(await screen.findByRole("button", { name: "Grant" }));
  await waitFor(() => expect(granted).toBe(true));
  expect(requests.every((path) => path.includes("/control-plane/admin/"))).toBe(
    true,
  );
  query.clear();
});
