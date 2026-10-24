// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneClient } from "@bb/sdk/browser";
import type {
  ControlPlaneThreadStreamMessage,
  ThreadTimelineResponse,
} from "@bb/server-contract";
import { makeThreadTimelineResponse } from "@/test/fixtures/thread-responses";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import { usePersonalTimeline } from "./usePersonalTimeline";

afterEach(cleanup);
function channel() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  return {
    response: new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
    send(value: ControlPlaneThreadStreamMessage) {
      controller?.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`),
      );
    },
    close() {
      controller?.close();
    },
    cancelled: () => cancelled,
  };
}
function snapshot(seq: number, text = "answer") {
  return makeThreadTimelineResponse({
    rows: [conversationRow({ id: "answer", threadId: "owned", seq, text })],
    maxSeq: seq,
    timelinePage: {
      olderCursor: { anchorId: "cursor", anchorSeq: seq },
      olderRowsSourceSeqEnd: seq - 1,
    },
  });
}
function frame(
  timeline: ThreadTimelineResponse,
  afterSequence: number | null,
): ControlPlaneThreadStreamMessage {
  return {
    kind: "realtime",
    message: {
      type: "thread-timeline",
      target: {
        kind: "thread-timeline",
        threadId: "owned",
        segmentLimit: 20,
        deferContent: true,
      },
      afterSequence,
      timeline,
    },
  };
}
it("merges native deltas without losing loaded history and resnapshots a mismatched baseline", async () => {
  const live = channel();
  let reads = 0;
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: async (input) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/stream")) return live.response;
      if (url.searchParams.has("beforeAnchorId"))
        return Response.json(
          makeThreadTimelineResponse({
            rows: [
              conversationRow({
                id: "older",
                threadId: "owned",
                seq: 1,
                text: "history",
              }),
            ],
            maxSeq: 10,
          }),
        );
      return Response.json(snapshot(++reads === 1 ? 10 : 20));
    },
  });
  const hook = renderHook(() => usePersonalTimeline(client, "owned"));
  await waitFor(() => expect(hook.result.current.timeline?.maxSeq).toBe(10));
  await act(() => hook.result.current.loadOlder());
  expect(hook.result.current.rows.map((row) => row.id)).toEqual([
    "older",
    "answer",
  ]);
  const next = snapshot(11, "live answer");
  act(() =>
    live.send(
      frame({ ...next, rows: [], delta: { upsertRows: next.rows } }, 10),
    ),
  );
  await waitFor(() => expect(hook.result.current.timeline?.maxSeq).toBe(11));
  expect(hook.result.current.rows.map((row) => row.id)).toEqual([
    "older",
    "answer",
  ]);
  act(() =>
    live.send(
      frame({ ...snapshot(12), rows: [], delta: { upsertRows: [] } }, 99),
    ),
  );
  await waitFor(() => expect(hook.result.current.timeline?.maxSeq).toBe(20));
  expect(reads).toBe(2);
  hook.unmount();
  await waitFor(() => expect(live.cancelled()).toBe(true));
});
it("ignores a late initial response after selecting another thread", async () => {
  let completeOld: ((value: Response) => void) | undefined;
  const live = channel();
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: async (input) => {
      const url = new URL(input.toString());
      if (url.pathname.includes("/old/"))
        return new Promise((resolve) => {
          completeOld = resolve;
        });
      return url.pathname.endsWith("/stream")
        ? live.response
        : Response.json(snapshot(30));
    },
  });
  const hook = renderHook(({ id }) => usePersonalTimeline(client, id), {
    initialProps: { id: "old" },
  });
  await waitFor(() => expect(completeOld).toBeDefined());
  hook.rerender({ id: "owned" });
  await waitFor(() => expect(hook.result.current.timeline?.maxSeq).toBe(30));
  await act(async () => completeOld?.(Response.json(snapshot(100))));
  expect(hook.result.current.timeline?.maxSeq).toBe(30);
  hook.unmount();
});
it("hides disconnected data and reconnects from a newly authorized snapshot", async () => {
  const first = channel(),
    second = channel();
  let reads = 0;
  const cursors: string[] = [];
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: async (input) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/stream")) {
        cursors.push(url.searchParams.get("after") ?? "");
        return cursors.length === 1 ? first.response : second.response;
      }
      return Response.json(snapshot(++reads * 10));
    },
  });
  const hook = renderHook(() => usePersonalTimeline(client, "owned"));
  await waitFor(() => expect(cursors).toEqual(["10"]));
  act(() => first.close());
  await waitFor(() => expect(hook.result.current.error).toBe(true));
  expect(hook.result.current.timeline).toBeNull();
  expect(hook.result.current.rows).toEqual([]);
  await waitFor(() => expect(cursors).toEqual(["10", "20"]), { timeout: 3000 });
  expect(hook.result.current.error).toBe(false);
  hook.unmount();
});
it("clears private rows and aborts the subscription when history reload loses access", async () => {
  const live = channel();
  let revoked = false;
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: async (input) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/stream")) return live.response;
      return revoked
        ? Response.json({ error: "not_found" }, { status: 404 })
        : Response.json(snapshot(10));
    },
  });
  const hook = renderHook(() => usePersonalTimeline(client, "owned"));
  await waitFor(() => expect(hook.result.current.timeline?.maxSeq).toBe(10));
  revoked = true;
  await act(() => hook.result.current.loadOlder());
  expect(hook.result.current.timeline).toBeNull();
  expect(hook.result.current.rows).toEqual([]);
  expect(hook.result.current.error).toBe(true);
  await waitFor(() => expect(live.cancelled()).toBe(true));
});
