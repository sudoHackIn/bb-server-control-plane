// @vitest-environment jsdom

import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createControlPlaneClient } from "@bb/sdk/browser";
import {
  controlPlaneThreadResolutionSchema,
  type PendingInteraction,
} from "@bb/domain";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { installPluginRuntime } from "@/lib/plugin-frontend";
import { PersonalConversationComposer } from "./PersonalConversationComposer";

const profileId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const profile = {
  id: profileId,
  slug: "agent",
  name: "Personal agent",
  enabled: true,
  createdAt: 1,
  latestVersionId: versionId,
  latestVersion: 2,
};
const detail = {
  profile,
  version: {
    id: versionId,
    profileId,
    version: 2,
    enabled: true,
    createdAt: 1,
    definition: {
      prompt: "private instructions",
      providerId: "qwen-server",
      model: "qwen-test",
      reasoningLevel: "none",
      permissionMode: "full",
      tools: [],
      mcpServers: [],
    },
  },
};
const project = {
  projectId: "project-compose",
  name: "My project",
  slug: "app",
  hostId: "host",
  cwd: "/srv/alice/app",
  role: "owner",
  canRun: true,
  canManage: true,
};
const thread = {
  id: "owned",
  projectId: project.projectId,
  profileVersionId: versionId,
  title: "Conversation",
  status: "active",
  createdAt: 1,
  updatedAt: 1,
  archived: false,
};
const queries: QueryClient[] = [];
beforeEach(() => {
  installPluginRuntime();
});
afterEach(() => {
  cleanup();
  for (const query of queries.splice(0)) query.clear();
  getPromptDraftAccessor({
    kind: "plugin-new-thread",
    key: `personal:${project.projectId}`,
  }).clear();
  getPromptDraftAccessor({
    kind: "thread",
    projectId: project.projectId,
    threadId: thread.id,
  }).clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "__bbPluginRuntime");
});
function harness({
  existing = false,
  fail = false,
  delayed = false,
  interaction,
  profileMissing = false,
}: {
  existing?: boolean;
  fail?: boolean;
  delayed?: boolean;
  interaction?: PendingInteraction;
  profileMissing?: boolean;
} = {}) {
  const requests: Request[] = [];
  let complete: ((response: Response) => void) | undefined;
  const created = vi.fn();
  let interactionResolved = false;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === "/control-plane/user/profiles")
      return Response.json({ profiles: [profile], nextCursor: null });
    if (
      url.pathname ===
        `/control-plane/user/profiles/${profileId}/versions/${versionId}` ||
      url.pathname === "/control-plane/user/threads/owned/profile"
    )
      return profileMissing
        ? Response.json({ error: "profile_not_found" }, { status: 404 })
        : Response.json(detail);
    if (url.pathname === "/control-plane/user/threads/owned/interactions")
      return Response.json(
        interaction && !interactionResolved ? [interaction] : [],
      );
    if (url.pathname.endsWith("/resolve") && interaction) {
      const resolution = controlPlaneThreadResolutionSchema.parse(
        await request.clone().json(),
      );
      interactionResolved = true;
      return Response.json({
        ...interaction,
        status: "resolved",
        resolvedAt: 2,
        resolution,
      });
    }
    if (
      request.method === "POST" &&
      url.pathname.startsWith("/control-plane/user/threads")
    ) {
      if (delayed)
        return new Promise((resolve) => {
          complete = resolve;
        });
      if (fail)
        return Response.json(
          { error: "execution_not_authorized" },
          { status: 403 },
        );
      return Response.json(
        url.pathname.endsWith("/send")
          ? { ok: true, delivery: "queued" }
          : url.pathname.endsWith("/stop")
            ? { ok: true }
            : { ...thread, status: "starting" },
      );
    }
    return Response.json({ error: "unexpected_request" }, { status: 401 });
  };
  vi.stubGlobal("fetch", fetcher);
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: fetcher,
  });
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  queries.push(query);
  const draft = getPromptDraftAccessor(
    existing
      ? { kind: "thread", projectId: project.projectId, threadId: thread.id }
      : { kind: "plugin-new-thread", key: `personal:${project.projectId}` },
  );
  draft.setTextAndMentions("Message from the native editor", []);
  const view = render(
    <StrictMode>
      <QueryClientProvider client={query}>
        <MemoryRouter>
          <PersonalConversationComposer
            client={client}
            project={{ ...project, role: "owner" }}
            thread={existing ? { ...thread, status: "active" } : null}
            onCreated={created}
          />
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
  return {
    requests,
    created,
    draft,
    view,
    complete: (response: Response) => {
      if (!complete) throw new Error("No request pending");
      complete(response);
    },
  };
}
async function submit(enter = false) {
  const editor = await screen.findByRole("textbox", {
    name: "Message your agent…",
  });
  await waitFor(() =>
    expect(screen.getByText("qwen-test · none")).toBeDefined(),
  );
  const form = editor.closest("form");
  if (!form) throw new Error("Native composer form not mounted");
  if (enter)
    fireEvent.keyDown(editor, {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
    });
  else fireEvent.submit(form);
}
it("starts with an allowed immutable profile using the actual editor and no administrative reads", async () => {
  const fixture = harness();
  await submit(true);
  await waitFor(() => expect(fixture.created).toHaveBeenCalledOnce());
  const request = fixture.requests.find((value) => value.method === "POST");
  expect(request).toBeDefined();
  expect(await request?.json()).toEqual({
    projectId: project.projectId,
    profileVersionId: versionId,
    message: "Message from the native editor",
  });
  expect(fixture.draft.getCurrent().text).toBe("");
  expect(
    fixture.requests.every((value) =>
      new URL(value.url).pathname.startsWith("/control-plane/user/"),
    ),
    fixture.requests.map((value) => value.url).join(","),
  ).toBe(true);
});
it("queues an existing conversation without configuration overrides and stops through the personal API", async () => {
  const fixture = harness({ existing: true });
  await submit();
  await screen.findByRole("status");
  const sent = fixture.requests.find((request) =>
    request.url.endsWith("/send"),
  );
  expect(await sent?.json()).toEqual({
    message: "Message from the native editor",
    mode: "queue-if-active",
  });
  fireEvent.click(await screen.findByRole("button", { name: "Stop run" }));
  await waitFor(() =>
    expect(
      fixture.requests.some((request) => request.url.endsWith("/stop")),
    ).toBe(true),
  );
  expect(
    fixture.requests.every((value) =>
      new URL(value.url).pathname.startsWith("/control-plane/user/"),
    ),
  ).toBe(true);
});
it("keeps the draft when delivery fails", async () => {
  const fixture = harness({ fail: true });
  await submit();
  await screen.findByText(/Delivery could not be confirmed/u);
  expect(fixture.draft.getCurrent().text).toBe(
    "Message from the native editor",
  );
  expect(fixture.created).not.toHaveBeenCalled();
});
it("latches duplicate submissions and ignores a response after leaving the composer", async () => {
  const fixture = harness({ delayed: true });
  await submit();
  await submit();
  await waitFor(() =>
    expect(
      fixture.requests.filter((value) => value.method === "POST"),
    ).toHaveLength(1),
  );
  const request = fixture.requests.find((value) => value.method === "POST");
  fixture.view.unmount();
  expect(request?.signal.aborted).toBe(true);
  await act(async () =>
    fixture.complete(Response.json({ ...thread, status: "starting" })),
  );
  expect(fixture.created).not.toHaveBeenCalled();
  expect(fixture.draft.getCurrent().text).toBe(
    "Message from the native editor",
  );
});

const approval: PendingInteraction = {
  id: "request",
  threadId: "owned",
  turnId: "turn",
  providerId: "qwen-server",
  providerThreadId: "session",
  providerRequestId: "native-request",
  status: "pending",
  statusReason: null,
  createdAt: 1,
  resolvedAt: null,
  resolution: null,
  payload: {
    kind: "approval",
    reason: null,
    availableDecisions: ["allow_once", "deny"],
    subject: {
      kind: "command",
      itemId: "cmd",
      command: "echo approved",
      cwd: "/srv/alice/app",
      actions: [],
      sessionGrant: null,
    },
  },
};
it("resolves the native approval banner through the bound personal transport without native thread or host reads", async () => {
  const fixture = harness({ existing: true, interaction: approval });
  fireEvent.click(await screen.findByRole("button", { name: "Allow once" }));
  await waitFor(() =>
    expect(
      fixture.requests.some((request) => request.url.endsWith("/resolve")),
    ).toBe(true),
  );
  const request = fixture.requests.find((request) =>
    request.url.endsWith("/resolve"),
  );
  expect(await request?.json()).toEqual({
    decision: "allow_once",
    grantedPermissions: null,
  });
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull(),
  );
  expect(
    fixture.requests.every((value) =>
      new URL(value.url).pathname.startsWith("/control-plane/user/"),
    ),
    fixture.requests.map((value) => value.url).join(","),
  ).toBe(true);
});
it("submits the native question form through the same personal interaction source", async () => {
  const question: PendingInteraction = {
    ...approval,
    resolution: null,
    payload: {
      kind: "user_question",
      questions: [
        {
          id: "question",
          prompt: "Choose an option",
          multiSelect: false,
          allowFreeText: false,
          options: [{ value: "a", label: "Option A" }],
        },
      ],
    },
  };
  const fixture = harness({ existing: true, interaction: question });
  fireEvent.click(await screen.findByRole("button", { name: /Option A$/u }));
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await waitFor(() =>
    expect(
      fixture.requests.some((request) => request.url.endsWith("/resolve")),
    ).toBe(true),
  );
  const request = fixture.requests.find((request) =>
    request.url.endsWith("/resolve"),
  );
  expect(await request?.json()).toEqual({
    kind: "user_answer",
    answers: { question: { selected: ["a"] } },
  });
  expect(
    fixture.requests.every((value) =>
      new URL(value.url).pathname.startsWith("/control-plane/user/"),
    ),
    fixture.requests.map((value) => value.url).join(","),
  ).toBe(true);
});
it("disables sending after profile loss while keeping native stop available", async () => {
  const fixture = harness({ existing: true, profileMissing: true });
  await screen.findByText(
    "This agent profile is unavailable. Sending is disabled.",
  );
  const editor = await screen.findByRole("textbox", {
    name: "Message your agent…",
  });
  const form = editor.closest("form");
  if (!form) throw new Error("Missing native form");
  fireEvent.submit(form);
  expect(
    fixture.requests.some((request) => request.url.endsWith("/send")),
  ).toBe(false);
  fireEvent.click(await screen.findByRole("button", { name: "Stop run" }));
  await waitFor(() =>
    expect(
      fixture.requests.some((request) => request.url.endsWith("/stop")),
    ).toBe(true),
  );
});

it("cancels a native question through scoped stop without falling back to the shared BB API", async () => {
  const question: PendingInteraction = {
    ...approval,
    resolution: null,
    payload: {
      kind: "user_question",
      questions: [
        {
          id: "free-answer",
          prompt: "Provide details",
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    },
  };
  const fixture = harness({ existing: true, interaction: question });
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      fixture.requests.some((request) => request.url.endsWith("/stop")),
    ).toBe(true),
  );
  expect(
    fixture.requests.every((value) =>
      new URL(value.url).pathname.startsWith("/control-plane/user/"),
    ),
    fixture.requests.map((value) => value.url).join(","),
  ).toBe(true);
});
