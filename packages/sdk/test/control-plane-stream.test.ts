import { expect, it } from "vitest";
import { readControlPlaneThreadStream } from "../src/control-plane-thread-stream.js";
import { createControlPlaneClient } from "../src/control-plane.js";

const encode = (value: object) =>
  `event: bb\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;

it("aborts an idle custom transport read and cancels its body without waiting for another frame", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const abort = new AbortController();
  const reader = readControlPlaneThreadStream(response, "owned", abort.signal);
  const pending = reader.next();
  abort.abort();
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(cancelled).toBe(true);
});
it("stops buffered replay after abort instead of yielding the next buffered frame", async () => {
  const fixture = response(
    encode({ kind: "ready", cursor: 1 }) + encode({ kind: "ready", cursor: 2 }),
    1024,
  );
  const abort = new AbortController();
  const stream = readControlPlaneThreadStream(
    fixture.value,
    "owned",
    abort.signal,
  );
  expect((await stream.next()).value).toEqual({ kind: "ready", cursor: 1 });
  abort.abort();
  expect(await stream.next()).toEqual({ done: true, value: undefined });
});
function response(text: string, size = 7) {
  const data = new TextEncoder().encode(text);
  let offset = 0;
  let cancelled = false;
  return {
    cancelled: () => cancelled,
    value: new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === data.length) return controller.close();
          controller.enqueue(data.slice(offset, offset + size));
          offset = Math.min(offset + size, data.length);
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream; charset=utf-8" } },
    ),
  };
}
it("decodes fragmented UTF-8/CRLF frames, ignores comments and cancels the body when its consumer stops", async () => {
  const message = {
    kind: "realtime",
    message: {
      type: "changed",
      entity: "thread",
      id: "thr_я",
      changes: ["events-appended"],
    },
  };
  const fixture = response(
    ": heartbeat\r\n\r\n" +
      encode(message) +
      encode({ kind: "ready", cursor: 12 }),
    1,
  );
  const stream = readControlPlaneThreadStream(fixture.value, "thr_я");
  expect((await stream.next()).value).toEqual(message);
  await stream.return();
  expect(fixture.cancelled()).toBe(true);
});
it("rejects cross-thread frames, malformed messages, oversized frames and unexpected EOF", async () => {
  for (const text of [
    encode({
      kind: "realtime",
      message: {
        type: "changed",
        entity: "thread",
        id: "thr_foreign",
        changes: [],
      },
    }),
    encode({ kind: "unknown" }),
    "data: " + "x".repeat(16 * 1024 * 1024 + 1),
    "data: not-json\n\n",
    "",
  ]) {
    const fixture = response(text, 1024 * 1024);
    await expect(
      readControlPlaneThreadStream(fixture.value, "thr_owned").next(),
    ).rejects.toThrow();
  }
});
it("authenticates stream fetches with the scoped token and never places it in the URL", async () => {
  let observed: Request | undefined;
  const fixture = response(encode({ kind: "ready", cursor: 3 }));
  const api = createControlPlaneClient({
    origin: "https://bb.example",
    token: () => "test-scoped-token",
    fetch: async (input, init) => {
      observed = new Request(input, init);
      return fixture.value;
    },
  });
  const stream = api.threads.stream("thr_owned", { after: 3 });
  expect((await stream.next()).value).toEqual({ kind: "ready", cursor: 3 });
  expect(observed?.headers.get("authorization")).toBe(
    "Bearer test-scoped-token",
  );
  expect(observed?.url).toBe(
    "https://bb.example/control-plane/user/threads/thr_owned/stream?after=3",
  );
  await stream.return();
  await expect(
    api.threads.stream("thr_owned", { after: -1 }).next(),
  ).rejects.toThrow();
});

it("cancels unexpected response bodies instead of leaving an unread connection", async () => {
  const fixture = response("unexpected body");
  fixture.value.headers.set("content-type", "application/json");
  await expect(
    readControlPlaneThreadStream(fixture.value, "thr_owned").next(),
  ).rejects.toThrow("Invalid thread stream response");
  expect(fixture.cancelled()).toBe(true);
  await expect(
    readControlPlaneThreadStream(new Response(null), "thr_owned").next(),
  ).rejects.toThrow("Invalid thread stream response");
});
