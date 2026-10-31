import type { PersonalWorkspaceClient } from "./PersonalWorkspace";
export type InspectionTimelineClient = {
  threads: Pick<
    PersonalWorkspaceClient["threads"],
    "get" | "timeline" | "olderTimeline" | "timelineDetails" | "stream"
  >;
};
export type RunInspectionClient = InspectionTimelineClient & {
  workflows: Pick<
    PersonalWorkspaceClient["workflows"],
    "inspect" | "inspectCall" | "trace" | "result"
  >;
};
