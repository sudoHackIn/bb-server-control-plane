import { createContext, useContext } from "react";
import type { TimelineTurnSummaryDetailsResponse } from "@bb/server-contract";
import type { ThreadTimelineTurnSummaryDetailsQueryIdentity } from "./query-keys";
import { sdk } from "@/lib/sdk";

export type TimelineDetailSource = (
  identity: ThreadTimelineTurnSummaryDetailsQueryIdentity,
  beforeCursor: string | undefined,
  signal: AbortSignal,
) => Promise<TimelineTurnSummaryDetailsResponse>;

export const nativeTimelineDetailSource: TimelineDetailSource = (
  identity,
  beforeCursor,
  signal,
) =>
  sdk.threads.timelineTurnSummaryDetails({
    threadId: identity.threadId,
    sourceSeqEnd: String(identity.sourceSeqEnd),
    sourceSeqStart: String(identity.sourceSeqStart),
    turnId: identity.turnId,
    deferContent: "true",
    ...(identity.itemId === null ? {} : { itemId: identity.itemId }),
    ...(beforeCursor === undefined ? {} : { beforeCursor }),
    signal,
  });
export const TimelineDetailSourceContext = createContext<TimelineDetailSource>(
  nativeTimelineDetailSource,
);
export function useTimelineDetailSource() {
  return useContext(TimelineDetailSourceContext);
}
