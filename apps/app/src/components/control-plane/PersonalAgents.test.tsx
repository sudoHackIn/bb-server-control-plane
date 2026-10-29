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
import { afterEach, expect, it, vi } from "vitest";
import { createControlPlaneClient } from "@bb/sdk/browser";
import { PersonalAgents } from "./PersonalAgents";

const profileId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const queries: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const query of queries.splice(0)) query.clear();
});

it("runs a published workflow agent as a task without offering chat or unsupported scheduling", async () => {
  const profile = {
    id: profileId,
    slug: "convert",
    name: "Convert document",
    enabled: true,
    createdAt: 1,
    latestVersionId: versionId,
    latestVersion: 1,
    strategy: "workflow",
  };
  const run = {
    runId: `wfa_${"a".repeat(64)}`,
    threadId: null,
    workflowRunId: `wfa_${"a".repeat(64)}`,
    strategy: "workflow",
    projectId: "project",
    profileId,
    profileVersionId: versionId,
    source: "manual",
    title: "Convert document",
    status: "succeeded",
    createdAt: 2,
    updatedAt: 3,
  };
  let started = false;
  const events = vi.fn();
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: async (input, init) => {
      const url = new URL(input.toString());
      if (url.pathname === "/control-plane/user/profiles")
        return Response.json({ profiles: [profile], nextCursor: null });
      if (url.pathname.startsWith(`/control-plane/user/profiles/${profileId}`))
        return Response.json({
          profile,
          version: {
            id: versionId,
            profileId,
            version: 1,
            enabled: true,
            createdAt: 1,
            definition: {
              purpose: "Convert a document",
              prompt: "Convert",
              providerId: "qwen-server",
              model: "qwen-test",
              reasoningLevel: "none",
              permissionMode: "full",
              tools: [],
              mcpServers: [],
              workflow: { definitionId: "wfd_test", revision: 1 },
            },
          },
        });
      if (url.pathname === "/control-plane/user/agent-runs") {
        if (init?.method === "POST") {
          started = true;
          expect(JSON.parse(String(init.body))).toMatchObject({
            input: "Convert this",
            profileVersionId: versionId,
          });
          return Response.json(run);
        }
        return Response.json({ runs: started ? [run] : [], nextCursor: null });
      }
      if (url.pathname.endsWith("/result"))
        return Response.json({ run, text: "Converted result" });
      if (url.pathname.endsWith("/events")) events();
      throw new Error(`Unexpected request ${url.pathname}`);
    },
  });
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queries.push(query);
  render(
    <QueryClientProvider client={query}>
      <MemoryRouter>
        <PersonalAgents
          client={client}
          projectId="project"
          canStart
          onStart={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: /Convert document/ }),
  );
  await screen.findByRole("button", { name: "Run task" });
  expect(
    screen.queryByRole("button", { name: "Start conversation" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Schedule this agent" }),
  ).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Background task" }), {
    target: { value: "Convert this" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Run task" }));
  await waitFor(() => expect(started).toBe(true));
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Convert document",
    }),
  );
  await screen.findByText("Converted result");
  expect(events).not.toHaveBeenCalled();
});
