import { useMemo } from "react";
import type { ThreadStatus } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { ThreadTimelineSurface } from "@/components/thread/timeline/ThreadTimelineSurface";
import { BottomAnchoredScrollBody } from "@/components/ui/bottom-anchored-scroll-body";
import {
  TimelineDetailSourceContext,
  type TimelineDetailSource,
} from "@/hooks/queries/timeline-detail-source";
import type { PersonalWorkspaceClient } from "./PersonalWorkspace";
import { usePersonalTimeline } from "./usePersonalTimeline";

export function PersonalTimeline({
  client,
  threadId,
  projectId,
  status,
  cwd,
}: {
  client: PersonalWorkspaceClient;
  threadId: string;
  projectId: string;
  status: ThreadStatus;
  cwd: string;
}) {
  const view = usePersonalTimeline(client, threadId);
  const currentStatus = view.status ?? status;
  const source = useMemo<TimelineDetailSource>(
    () => (identity, beforeCursor, signal) => {
      if (identity.threadId !== threadId)
        return Promise.reject(
          new Error("Timeline details must belong to the selected thread"),
        );
      return client.threads.timelineDetails(
        threadId,
        {
          turnId: identity.turnId,
          sourceSeqStart: identity.sourceSeqStart,
          sourceSeqEnd: identity.sourceSeqEnd,
          itemId: identity.itemId ?? undefined,
          beforeCursor,
        },
        signal,
      );
    },
    [client, threadId],
  );
  return (
    <TimelineDetailSourceContext.Provider value={source}>
      <BottomAnchoredScrollBody
        footer={null}
        maxWidthClassName="max-w-3xl"
        scrollAnchorThreadId={threadId}
        contentClassName="px-4 pb-8"
      >
        {view.error && (
          <div role="alert" className="py-3">
            <p>Unable to connect to this conversation.</p>
            <Button variant="outline" onClick={view.retry}>
              Reconnect
            </Button>
          </div>
        )}
        {view.olderError && (
          <p role="alert" className="py-3">
            Earlier messages could not be loaded. Retry loading earlier
            messages.
          </p>
        )}
        <ThreadTimelineSurface
          activeThinking={view.timeline?.activeThinking ?? null}
          contextBoundarySeq={view.timeline?.contextBoundarySeq ?? null}
          isThreadTimelinePending={!view.timeline && !view.error}
          timelineError={view.error}
          timelineRows={view.error ? [] : view.rows}
          hasOlderTimelineRows={view.hasOlder && !view.error}
          isLoadingOlderTimelineRows={view.loadingOlder}
          onLoadOlderRows={view.loadOlder}
          threadId={threadId}
          projectId={projectId}
          threadRuntimeDisplayStatus={currentStatus}
          showOngoingIndicator={
            !view.error &&
            view.timeline !== null &&
            (currentStatus === "active" || currentStatus === "starting")
          }
          workspaceRootPath={cwd}
          canSpawnChild={false}
          includePluginMessageActions={false}
          onOpenLocalFileLink={() => true}
        />
      </BottomAnchoredScrollBody>
    </TimelineDetailSourceContext.Provider>
  );
}
