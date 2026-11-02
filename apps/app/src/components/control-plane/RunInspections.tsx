import { DelegatedRunBanner } from "./DelegatedRunBanner";
import { RunTestForm } from "./RunTestForm";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import { PersonalRunInspection } from "./PersonalRunInspection";
import { PersonalTimeline } from "./PersonalTimeline";
import { PersonalPageHeader } from "./PersonalWorkspaceUi";
import type { PersonalWorkspaceClient } from "./PersonalWorkspace";

export function RunInspections({
  client,
  projectId,
  testClient,
  administrator = false,
}: {
  client: PersonalWorkspaceClient["inspections"];
  projectId: string;
  testClient?: PersonalWorkspaceClient["testRuns"];
  administrator?: boolean;
}) {
  const location = useLocation(),
    navigate = useNavigate();
  const query = new URLSearchParams(location.search);
  const kind = query.get("inspectKind");
  const runId = query.get("inspectRun");
  const initialCursor: { cursor: string | undefined } = { cursor: undefined };
  const listing = useInfiniteQuery({
    queryKey: ["personal", "diagnostic-runs", projectId],
    initialPageParam: initialCursor,
    queryFn: ({ pageParam, signal }) =>
      client.list(projectId, { cursor: pageParam.cursor, signal }),
    getNextPageParam: (p) =>
      p.nextCursor === null ? undefined : { cursor: p.nextCursor },
    refetchInterval: 3000,
    retry: false,
  });
  const data = listing.isError ? undefined : listing.data?.pages[0];
  const thread = useQuery({
    queryKey: ["personal", "diagnostic-root-thread", projectId, runId],
    queryFn: ({ signal }) => client.threads.get(runId ?? "", signal),
    enabled: kind === "thread" && runId !== null && !!data,
    refetchInterval: 3000,
    retry: false,
  });
  function back() {
    for (const name of [
      "inspectRun",
      "inspectKind",
      "inspectCall",
      "inspectThread",
      "testRun",
    ])
      query.delete(name);
    navigate({ search: `?${query}` });
  }
  if (listing.isError)
    return (
      <p role="alert" className="p-6">
        Inspection is unavailable. Check your diagnostic grant and project
        access.
      </p>
    );
  if (!data)
    return (
      <p role="status" className="p-6">
        Loading readable runs…
      </p>
    );
  if (runId && kind === "workflow")
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {testClient && (
          <RunTestForm
            key={runId}
            client={testClient}
            sourceRunId={runId}
            administrator={administrator}
          />
        )}
        <PersonalRunInspection
          key={runId}
          client={client.forWorkflow(runId)}
          runId={runId}
          projectId={projectId}
          cwd={data.project.cwd}
        />
      </div>
    );
  if (runId && kind === "thread")
    return (
      <section className="flex min-h-0 flex-1 flex-col">
        {!thread.isError &&
          thread.data?.delegation &&
          thread.data.projectId === projectId && (
            <DelegatedRunBanner value={thread.data.delegation} />
          )}
        <PersonalPageHeader
          icon="MessageSquare"
          title="Conversation inspection"
          description="Read-only recorded conversation"
          actions={
            <Button variant="outline" onClick={back}>
              Back to runs
            </Button>
          }
        />
        {thread.isError ? (
          <p role="alert" className="p-6">
            This conversation is unavailable.
          </p>
        ) : thread.data && thread.data.projectId === projectId ? (
          <PersonalTimeline
            key={runId}
            client={client}
            threadId={runId}
            projectId={projectId}
            cwd={data.project.cwd}
            status={thread.data.status}
          />
        ) : (
          <p role="status">Loading conversation…</p>
        )}
      </section>
    );
  return (
    <section
      aria-label="Run inspections"
      className="flex min-h-0 flex-1 flex-col"
    >
      <PersonalPageHeader
        icon="Search"
        title="Run inspections"
        description={data.project.name}
      />
      <div className="space-y-3 overflow-auto p-6">
        <p className="text-sm text-muted-foreground">
          Your runs and any project runs covered by an explicit diagnostic
          grant. Inspection does not grant execution controls.
        </p>
        {listing.data?.pages
          .flatMap((p) => p.runs)
          .map((row) => (
            <Button
              key={`${row.kind}:${row.id}`}
              variant="outline"
              className="flex h-auto min-h-12 w-full justify-between whitespace-normal py-3 text-left"
              onClick={() => {
                query.set("inspectKind", row.kind);
                query.set("inspectRun", row.id);
                query.delete("inspectCall");
                query.delete("inspectThread");
                query.delete("testRun");
                navigate({ search: `?${query}` });
              }}
            >
              <span className="min-w-0 break-words">
                {row.title}
                <span className="block break-all text-xs text-muted-foreground">
                  {row.kind} · {row.id} · owner {row.ownerUserId}
                </span>
              </span>
            </Button>
          ))}
        {listing.data?.pages.every((p) => p.runs.length === 0) && (
          <p>No readable runs.</p>
        )}
        {listing.hasNextPage && (
          <Button
            variant="outline"
            disabled={listing.isFetchingNextPage}
            onClick={() => void listing.fetchNextPage()}
          >
            More runs
          </Button>
        )}
      </div>
    </section>
  );
}
