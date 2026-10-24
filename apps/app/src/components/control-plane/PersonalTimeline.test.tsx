// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { createControlPlaneClient } from "@bb/sdk/browser";
import { makeThreadTimelineResponse } from "@/test/fixtures/thread-responses";
import {
  conversationRow,
  commandRow,
} from "@/test/fixtures/thread-timeline-rows";
import { PersonalTimeline } from "./PersonalTimeline";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("renders native messages with only personal transport requests and releases the live subscription", async () => {
  const paths: string[] = [];
  let aborted = false;
  const snapshot = makeThreadTimelineResponse({
    rows: [
      conversationRow({
        id: "answer",
        threadId: "owned",
        text: "Personal native answer",
        role: "assistant",
      }),
      {
        ...commandRow({
          id: "cmd",
          threadId: "owned",
          turnId: "turn",
          command: "printf private",
          output: "",
          sourceSeqStart: 2,
          sourceSeqEnd: 3,
        }),
        contentDeferred: true,
      },
    ],
    maxSeq: 5,
  });
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(input.toString()).pathname;
    paths.push(path);
    if (path === "/control-plane/user/threads/owned/timeline")
      return Response.json(snapshot);
    if (path === "/control-plane/user/threads/owned/timeline-details")
      return Response.json({
        rows: [
          commandRow({
            id: "cmd",
            threadId: "owned",
            turnId: "turn",
            command: "printf private",
            output: "private tool output",
            sourceSeqStart: 2,
            sourceSeqEnd: 3,
          }),
        ],
      });
    if (path === "/control-plane/user/threads/owned/stream") {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                controller.close();
              },
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return Response.json({ error: "forbidden" }, { status: 401 });
  };
  vi.stubGlobal("fetch", fetcher);
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: fetcher,
  });
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queries}>
      <MemoryRouter>
        <PersonalTimeline
          client={client}
          threadId="owned"
          projectId="project"
          status="idle"
          cwd="/srv/alice/project"
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByText("Personal native answer");
  fireEvent.click(await screen.findByText("printf private"));
  await screen.findByText("private tool output");
  await waitFor(() =>
    expect(paths.some((path) => path.endsWith("/stream"))).toBe(true),
  );
  expect(
    paths.every((path) => path.startsWith("/control-plane/user/")),
    paths.join(","),
  ).toBe(true);
  view.unmount();
  await waitFor(() => expect(aborted).toBe(true));
  queries.clear();
});
