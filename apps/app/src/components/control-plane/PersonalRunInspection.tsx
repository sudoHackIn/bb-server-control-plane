import { personalInspectionSearch } from "./personal-inspection-navigation";
import type { JsonValue } from "@bb/domain";
import { useLocation, useNavigate } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { PersonalTimeline } from "./PersonalTimeline";
import {
  PersonalPageHeader,
  PersonalStatus,
  personalCodeClass,
} from "./PersonalWorkspaceUi";
import type { PersonalWorkspaceClient } from "./PersonalWorkspace";

export function PersonalRunInspection({
  client,
  runId,
  projectId,
  cwd,
}: {
  client: PersonalWorkspaceClient;
  runId: string;
  projectId: string;
  cwd: string;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const query = new URLSearchParams(location.search);
  const callId = query.get("inspectCall");
  const threadId = query.get("inspectThread");
  function selectCall(id: string | null) {
    navigate({ search: personalInspectionSearch(location.search, runId, id) });
  }
  function back() {
    if (threadId) {
      query.delete("inspectThread");
    } else if (callId) {
      query.delete("inspectCall");
    } else {
      query.delete("inspectRun");
    }
    navigate({ search: `?${query}` });
  }
  const pages = useInfiniteQuery({
    queryKey: ["personal", "run-inspection", projectId, runId],
    initialPageParam: -1,
    queryFn: ({ pageParam, signal }) =>
      client.workflows.inspect(runId, { after: pageParam, signal }),
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: 3000,
  });
  const detail = useQuery({
    queryKey: ["personal", "call-inspection", projectId, runId, callId],
    queryFn: ({ signal }) =>
      client.workflows.inspectCall(runId, callId ?? "", signal),
    enabled: callId !== null && pages.isSuccess && !pages.isError,
    refetchInterval: 3000,
  });
  const result = useQuery({
    queryKey: ["personal", "run-inspection-result", projectId, runId],
    queryFn: ({ signal }) => client.workflows.result(runId, signal),
    enabled: pages.isSuccess && !pages.isError,
    refetchInterval: 3000,
  });
  const overview = pages.isError ? undefined : pages.data?.pages[0];
  const selected = detail.isError ? undefined : detail.data;
  const workerAllowed =
    threadId !== null &&
    selected?.workers.some((worker) => worker.threadId === threadId) === true;
  const worker = useQuery({
    queryKey: ["personal", "inspection-thread", runId, callId, threadId],
    queryFn: ({ signal }) => client.threads.get(threadId ?? "", signal),
    enabled: workerAllowed,
    refetchInterval: 3000,
  });
  const thread =
    workerAllowed && !worker.isError && worker.data?.projectId === projectId
      ? worker.data
      : undefined;
  const calls = pages.data?.pages.flatMap((page) => page.calls) ?? [];
  const unavailable =
    pages.isError || (overview && overview.run.projectId !== projectId);
  return (
    <section
      aria-label="Run inspection"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
    >
      <PersonalPageHeader
        icon="Workflow"
        title={overview?.run.name ?? "Run inspection"}
        description="Inspect recorded execution and its original conversations."
        actions={
          <Button variant="outline" onClick={back}>
            <Icon name="ChevronLeft" aria-hidden />
            {threadId
              ? "Back to step"
              : callId
                ? "Back to run"
                : "Back to tasks"}
          </Button>
        }
      />
      {unavailable ? (
        <p role="alert" className="p-6">
          Run inspection is unavailable. Check your access and retry.
        </p>
      ) : !overview ? (
        <p role="status" className="p-6">
          Loading execution…
        </p>
      ) : threadId ? (
        <>
          {!workerAllowed || worker.isError ? (
            <p role="alert" className="p-6">
              This conversation is unavailable.
            </p>
          ) : thread ? (
            <>
              <div className="px-4 py-3 text-sm">
                <h2 className="font-medium">
                  {thread.title ?? "Worker conversation"}
                </h2>
                <p className="break-all text-muted-foreground">
                  {thread.id} · Read only
                </p>
              </div>
              <PersonalTimeline
                key={thread.id}
                client={client}
                threadId={thread.id}
                projectId={projectId}
                status={thread.status}
                cwd={cwd}
              />
            </>
          ) : (
            <p role="status" className="p-6">
              Loading conversation…
            </p>
          )}
        </>
      ) : (
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <div className="mx-auto w-full max-w-5xl space-y-5 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <PersonalStatus status={overview.run.status} />
              <span>
                {overview.callCounts.succeeded} / {overview.callCounts.total}{" "}
                steps succeeded
              </span>
              {overview.run.phase && <span>{overview.run.phase}</span>}
            </div>
            <p className="break-all font-mono text-xs text-muted-foreground">
              {runId}
            </p>
            {overview.run.error && (
              <pre role="alert" className={personalCodeClass}>
                {overview.run.error}
              </pre>
            )}
            {callId ? (
              <>
                {detail.isError ? (
                  <p role="alert">
                    This step is unavailable. Check your access and retry.
                  </p>
                ) : !selected ? (
                  <p role="status">Loading step…</p>
                ) : (
                  <>
                    <h2 className="text-base font-semibold">
                      {selected.call.label ?? `Step ${selected.call.index + 1}`}
                    </h2>
                    <div className="flex flex-wrap gap-3">
                      <PersonalStatus status={selected.call.status} />
                      <span>
                        {selected.call.source === "cached"
                          ? "Cached replay · no new model invocation"
                          : "Live execution"}
                      </span>
                      {selected.call.phase && (
                        <span>{selected.call.phase}</span>
                      )}
                    </div>
                    <dl className="grid gap-3 sm:grid-cols-2">
                      <Fact
                        label="Provider / model"
                        value={`${selected.call.provider} / ${selected.call.model}`}
                      />
                      <Fact
                        label="Reasoning / permissions"
                        value={`${selected.call.reasoningLevel} / ${selected.call.permissionMode}`}
                      />
                      <Fact
                        label="Profile version"
                        value={
                          selected.call.profileVersionId ??
                          overview.profileVersionId
                        }
                      />
                      <Fact
                        label="Retries / repairs"
                        value={`${selected.call.providerRetryAttempts} / ${selected.call.repairAttempts}`}
                      />
                      <Fact
                        label="Started"
                        value={time(selected.call.startedAt)}
                      />
                      <Fact
                        label="Finished"
                        value={time(selected.call.finishedAt)}
                      />
                    </dl>
                    {selected.call.error && (
                      <pre role="alert" className={personalCodeClass}>
                        {selected.call.error}
                      </pre>
                    )}
                    <JsonSection title="Step input" value={selected.input} />
                    {selected.outputAvailable && (
                      <JsonSection
                        title="Step output"
                        value={selected.output}
                      />
                    )}
                    {selected.outputSchema !== null && (
                      <JsonSection
                        title="Output contract"
                        value={selected.outputSchema}
                      />
                    )}
                    {selected.replayedFrom && (
                      <Button
                        variant="outline"
                        onClick={() =>
                          navigate({
                            search: personalInspectionSearch(
                              location.search,
                              selected.replayedFrom?.runId ?? runId,
                              selected.replayedFrom?.callId ?? null,
                            ),
                          })
                        }
                      >
                        Inspect original work
                      </Button>
                    )}
                    {selected.call.replaySource === "resumed-run" &&
                      !selected.replayedFrom && (
                        <p className="text-muted-foreground">
                          The original work is no longer available under your
                          current access.
                        </p>
                      )}
                    <h3 className="font-medium">
                      Recorded worker conversations
                    </h3>
                    {selected.workers.length === 0 && (
                      <p className="text-muted-foreground">
                        No worker conversation was created for this call.
                      </p>
                    )}
                    <ul className="space-y-2">
                      {selected.workers.map((worker) => (
                        <li key={worker.threadId}>
                          <Button
                            className="h-auto min-h-10 max-w-full whitespace-normal break-all text-left"
                            variant="outline"
                            onClick={() => {
                              query.set("inspectThread", worker.threadId);
                              navigate({ search: `?${query}` });
                            }}
                          >
                            {worker.threadId}
                            {worker.archived ? " · archived" : ""}
                          </Button>
                        </li>
                      ))}
                    </ul>
                    {selected.workersTruncated && (
                      <p>Only the first 100 recorded workers are shown.</p>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                <dl className="grid gap-3 sm:grid-cols-2">
                  <Fact
                    label="Agent profile version"
                    value={overview.profileVersionId}
                  />
                  <Fact
                    label="Workflow revision"
                    value={
                      overview.workflowRevision
                        ? `${overview.workflowRevision.definitionId} / ${overview.workflowRevision.revision}`
                        : "Ad hoc source"
                    }
                  />
                  <Fact label="Source hash" value={overview.sourceHash} />
                  <Fact label="Started" value={time(overview.run.startedAt)} />
                  <Fact
                    label="Finished"
                    value={time(overview.run.finishedAt)}
                  />
                </dl>
                <details>
                  <summary className="cursor-pointer py-2 font-medium">
                    Run input and output contract
                  </summary>
                  <div className="space-y-3">
                    <JsonSection title="Run input" value={overview.input} />
                    {overview.outputSchema !== null && (
                      <JsonSection
                        title="Run output contract"
                        value={overview.outputSchema}
                      />
                    )}
                  </div>
                </details>
                {result.isError ? (
                  <p role="alert">Run output is unavailable.</p>
                ) : (
                  result.data?.available && (
                    <JsonSection title="Run output" value={result.data.value} />
                  )
                )}
                {overview.resumedFromRunId && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      navigate({
                        search: personalInspectionSearch(
                          location.search,
                          overview.resumedFromRunId ?? runId,
                        ),
                      })
                    }
                  >
                    Inspect previous run
                  </Button>
                )}
                <div className="space-y-2 border-t border-border pt-4">
                  <h2 className="font-medium">Agent calls</h2>
                  <p className="text-xs text-muted-foreground">
                    Recorded call order. Overlapping start and finish times show
                    concurrent work. Nested workflow calls share this list.
                  </p>
                  <ol
                    aria-label="Recorded agent calls"
                    className="space-y-2 border-l border-border pl-4"
                  >
                    {calls.map((call) => (
                      <li key={call.id}>
                        <button
                          className="flex w-full cursor-pointer flex-col gap-2 rounded-md border border-border bg-surface-recessed/40 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => selectCall(call.id)}
                        >
                          <span className="flex w-full flex-wrap justify-between gap-2">
                            <span className="min-w-0 break-words font-medium">
                              {call.index + 1}. {call.label ?? call.model}
                            </span>
                            <PersonalStatus status={call.status} />
                          </span>
                          <span className="break-words text-xs text-muted-foreground">
                            {call.phase ? `${call.phase} · ` : ""}
                            {call.source === "cached"
                              ? "Cached replay"
                              : `${call.provider} / ${call.model}`}{" "}
                            · {call.providerRetryAttempts} retries ·{" "}
                            {call.repairAttempts} repairs
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {time(call.startedAt)} → {time(call.finishedAt)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                  {calls.length === 0 && <p>No recorded agent calls.</p>}
                  {pages.hasNextPage && (
                    <Button
                      variant="outline"
                      disabled={pages.isFetchingNextPage}
                      onClick={() => void pages.fetchNextPage()}
                    >
                      More steps
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
function time(value: number | null) {
  return value === null ? "—" : new Date(value).toLocaleString();
}
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-all">{value}</dd>
    </div>
  );
}
function JsonSection({ title, value }: { title: string; value: JsonValue }) {
  return (
    <div className="min-w-0 space-y-2">
      <h3 className="font-medium">{title}</h3>
      <pre className={personalCodeClass}>
        {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
