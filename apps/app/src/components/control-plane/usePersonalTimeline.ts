import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyTimelineDelta,
  type ThreadTimelineResponse,
} from "@bb/server-contract";
import {
  buildLoadedTimelineState,
  mergeLoadedTimelineWithLatest,
  prependOlderTimelineRows,
  areTimelinePaginationCursorsEqual,
  type LoadedTimelineState,
} from "@bb/client-core";
import type { PersonalWorkspaceClient } from "./PersonalWorkspace";
import type { ThreadStatus } from "@bb/domain";

function empty(threadId: string) {
  return buildLoadedTimelineState({
    surfaceKey: threadId,
    historySnapshot: null,
    latestWindowEndSequence: null,
    olderCursor: null,
    latestRows: [],
  });
}
function pause(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 1000);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
export function usePersonalTimeline(
  client: PersonalWorkspaceClient,
  threadId: string,
) {
  const [liveStatus, setLiveStatus] = useState<{
    threadId: string;
    status: ThreadStatus;
  } | null>(null);
  const [snapshot, setSnapshot] = useState<{
    threadId: string;
    timeline: ThreadTimelineResponse;
  } | null>(null);
  const [loaded, setLoaded] = useState<LoadedTimelineState>(() =>
    empty(threadId),
  );
  const [error, setError] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    lifetime.current = controller;
    let firstSnapshot = true;
    const publish = (timeline: ThreadTimelineResponse) => {
      if (signal.aborted) return;
      if (firstSnapshot) {
        setOlderError(false);
        setLoadingOlder(false);
        firstSnapshot = false;
      }
      setError(false);
      setSnapshot((current) =>
        current?.threadId === threadId &&
        current.timeline.maxSeq > timeline.maxSeq
          ? current
          : { threadId, timeline },
      );
      setLoaded((current) =>
        current.surfaceKey === threadId &&
        (current.latestWindowEndSequence ?? 0) > timeline.maxSeq
          ? current
          : mergeLoadedTimelineWithLatest({
              current,
              latestTimeline: timeline,
              surfaceKey: threadId,
            }),
      );
    };
    async function connect() {
      while (!signal.aborted) {
        try {
          let latest = await client.threads.timeline(threadId, signal);
          if (signal.aborted) return;
          publish(latest);
          let cursor = latest.maxSeq;
          for await (const frame of client.threads.stream(threadId, {
            after: cursor,
            signal,
          })) {
            if (signal.aborted) return;
            if (
              frame.kind === "realtime" &&
              frame.message.type === "changed" &&
              frame.message.metadata?.statusChange
            )
              setLiveStatus({
                threadId,
                status: frame.message.metadata.statusChange.status,
              });
            if (frame.kind === "event")
              cursor = Math.max(cursor, frame.event.seq);
            if (
              frame.kind !== "realtime" ||
              frame.message.type !== "thread-timeline"
            )
              continue;
            const message = frame.message;
            if (message.timeline.delta === undefined) latest = message.timeline;
            else {
              const rows =
                message.afterSequence === latest.maxSeq
                  ? applyTimelineDelta(latest.rows, message.timeline.delta)
                  : null;
              latest =
                rows === null
                  ? await client.threads.timeline(threadId, signal)
                  : { ...message.timeline, rows, delta: undefined };
            }
            publish(latest);
          }
          if (!signal.aborted) throw new Error("Timeline stream disconnected");
        } catch {
          if (signal.aborted) return;
          setLiveStatus(null);
          setSnapshot(null);
          setLoaded(empty(threadId));
          setError(true);
          await pause(signal);
        }
      }
    }
    void connect();
    return () => {
      controller.abort();
      if (lifetime.current === controller) lifetime.current = null;
    };
  }, [client, threadId, attempt]);
  const loadOlder = useCallback(async () => {
    const controller = lifetime.current;
    const cursor = loaded.surfaceKey === threadId ? loaded.olderCursor : null;
    if (!controller || controller.signal.aborted || !cursor || loadingOlder)
      return;
    setLoadingOlder(true);
    setOlderError(false);
    try {
      const page = await client.threads.olderTimeline(
        threadId,
        cursor,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setLoaded((current) =>
        current.surfaceKey !== threadId ||
        !areTimelinePaginationCursorsEqual({
          left: current.olderCursor,
          right: cursor,
        })
          ? current
          : {
              ...current,
              olderCursor: page.timelinePage.olderCursor,
              rows: prependOlderTimelineRows({
                loadedRows: current.rows,
                olderRows: page.rows,
              }),
            },
      );
    } catch {
      if (controller.signal.aborted) return;
      setOlderError(true);
      try {
        const fresh = await client.threads.timeline(
          threadId,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setSnapshot((current) =>
          current?.threadId === threadId &&
          current.timeline.maxSeq > fresh.maxSeq
            ? current
            : { threadId, timeline: fresh },
        );
        setLoaded((current) =>
          current.surfaceKey === threadId &&
          (current.latestWindowEndSequence ?? 0) > fresh.maxSeq
            ? current
            : mergeLoadedTimelineWithLatest({
                current: empty(threadId),
                latestTimeline: fresh,
                surfaceKey: threadId,
              }),
        );
      } catch {
        if (controller.signal.aborted) return;
        setSnapshot(null);
        setLoaded(empty(threadId));
        setError(true);
        controller.abort();
      }
    } finally {
      if (lifetime.current === controller) setLoadingOlder(false);
    }
  }, [client, threadId, loaded, loadingOlder]);
  return {
    status: liveStatus?.threadId === threadId ? liveStatus.status : null,
    timeline: snapshot?.threadId === threadId ? snapshot.timeline : null,
    rows: loaded.surfaceKey === threadId ? loaded.rows : [],
    hasOlder: loaded.surfaceKey === threadId && loaded.olderCursor !== null,
    loadingOlder,
    olderError,
    loadOlder,
    error,
    retry: () => {
      setLiveStatus(null);
      setSnapshot(null);
      setLoaded(empty(threadId));
      setError(false);
      setOlderError(false);
      setLoadingOlder(false);
      setAttempt((value) => value + 1);
    },
  };
}
