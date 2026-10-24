import type { ThreadEventRow } from "@bb/domain";
import {
  controlPlaneThreadRealtimeSchema,
  type ControlPlaneThreadStreamMessage,
  type ThreadTimelineSignal,
} from "@bb/server-contract";
import type { NotificationHub } from "../ws/hub.js";
import { ApiError } from "../errors.js";

const maxFrameBytes = 16 * 1024 * 1024;
const maxPendingBytes = 2 * 1024 * 1024;
const encoder = new TextEncoder();
type Options = {
  userId: string;
  threadId: string;
  after: number;
  signal: AbortSignal;
  authorized: () => boolean;
  events: (after: number) => { events: ThreadEventRow[]; hasMore: boolean };
  snapshot: () => ThreadTimelineSignal;
};
export function createControlPlaneThreadStreams(hub: NotificationHub) {
  const counts = new Map<string, number>();
  let active = 0;
  let disposed = false;
  const closers = new Set<() => void>();
  return {
    close() {
      disposed = true;
      for (const close of closers) close();
    },
    open(options: Options) {
      if (disposed)
        throw new ApiError(503, "stream_closed", "Thread streams are closed");
      const count = counts.get(options.userId) ?? 0;
      if (count >= 4 || active >= 64)
        throw new ApiError(429, "stream_limit", "Too many open thread streams");
      counts.set(options.userId, count + 1);
      active++;
      let closed = false;
      let cursor = options.after;
      let dirty = true;
      let ready = false;
      let pumping = false;
      let pendingBytes = 0;
      let timelineSequence: number | null = null;
      let controller: ReadableStreamDefaultController<Uint8Array>;
      let timer: ReturnType<typeof setInterval> | undefined;
      let heartbeatAt = Date.now();
      const pending: Uint8Array[] = [];
      function cleanup() {
        if (closed) return;
        closed = true;
        closers.delete(cancel);
        if (timer) clearInterval(timer);
        options.signal.removeEventListener("abort", cancel);
        hub.unregisterClient(socket);
        pending.length = 0;
        active--;
        const remaining = (counts.get(options.userId) ?? 1) - 1;
        if (remaining > 0) counts.set(options.userId, remaining);
        else counts.delete(options.userId);
      }
      function cancel() {
        cleanup();
        controller.error(new Error("Thread stream closed"));
      }
      function permitted() {
        try {
          return options.authorized();
        } catch {
          return false;
        }
      }
      function check() {
        if (closed) return false;
        if (options.signal.aborted || !permitted()) {
          cancel();
          return false;
        }
        return true;
      }
      function encode(message: ControlPlaneThreadStreamMessage) {
        const id = message.kind === "event" ? `id: ${message.event.seq}\n` : "";
        const value = encoder.encode(
          `${id}event: bb\ndata: ${JSON.stringify(message)}\n\n`,
        );
        if (value.byteLength > maxFrameBytes)
          throw new Error("Thread stream frame is too large");
        return value;
      }
      function queue(message: ControlPlaneThreadStreamMessage) {
        const value = encode(message);
        pendingBytes += value.byteLength;
        if (pendingBytes > maxPendingBytes)
          throw new Error("Thread stream consumer is too slow");
        pending.push(value);
      }
      function pump() {
        if (pumping || !check()) return;
        pumping = true;
        try {
          while (!closed && (controller.desiredSize ?? 0) > 0) {
            if (!check()) break;
            if (dirty) {
              const page = options.events(cursor);
              for (const event of page.events) {
                if ((controller.desiredSize ?? 0) <= 0) break;
                if (!check()) return;
                controller.enqueue(encode({ kind: "event", event }));
                cursor = event.seq;
              }
              dirty =
                page.hasMore || (page.events.at(-1)?.seq ?? cursor) > cursor;
              if (dirty) continue;
            }
            const next = pending.shift();
            if (next) {
              pendingBytes -= next.byteLength;
              controller.enqueue(next);
              continue;
            }
            if (!ready) {
              ready = true;
              controller.enqueue(encode({ kind: "ready", cursor }));
              continue;
            }
            break;
          }
        } catch (error) {
          cleanup();
          controller.error(error);
        } finally {
          pumping = false;
        }
      }
      const socket = {
        close: cancel,
        send(data: string) {
          if (!check()) return;
          try {
            const raw: unknown = JSON.parse(data);
            const parsed = controlPlaneThreadRealtimeSchema.safeParse(raw);
            if (!parsed.success) return;
            let message = parsed.data;
            if (message.type === "changed") {
              if (message.id !== options.threadId) return;
              dirty = true;
            } else {
              if (message.target.threadId !== options.threadId) return;
              if (message.afterSequence !== timelineSequence)
                message = options.snapshot();
              timelineSequence = message.timeline.maxSeq;
            }
            queue({ kind: "realtime", message });
            pump();
          } catch (error) {
            cleanup();
            controller.error(error);
          }
        },
      };
      closers.add(cancel);
      const body = new ReadableStream<Uint8Array>(
        {
          start(value) {
            controller = value;
            try {
              if (!check()) return;
              hub.subscribe(socket, {
                kind: "thread-detail",
                threadId: options.threadId,
              });
              hub.subscribe(socket, {
                kind: "thread-timeline",
                threadId: options.threadId,
                segmentLimit: 20,
                deferContent: true,
              });
              const snapshot = options.snapshot();
              timelineSequence = snapshot.timeline.maxSeq;
              queue({ kind: "realtime", message: snapshot });
              options.signal.addEventListener("abort", cancel, { once: true });
              timer = setInterval(() => {
                if (!check()) return;
                pump();
                if (
                  !closed &&
                  Date.now() - heartbeatAt >= 15000 &&
                  (controller.desiredSize ?? 0) > 0
                ) {
                  heartbeatAt = Date.now();
                  controller.enqueue(encoder.encode(": heartbeat\n\n"));
                }
              }, 1000);
              timer.unref();
              pump();
            } catch (error) {
              cleanup();
              controller.error(error);
            }
          },
          pull: pump,
          cancel: cleanup,
        },
        { highWaterMark: 65536, size: (chunk) => chunk.byteLength },
      );
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          "x-accel-buffering": "no",
        },
      });
    },
  };
}
