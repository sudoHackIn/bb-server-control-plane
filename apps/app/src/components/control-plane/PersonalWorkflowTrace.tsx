import type { ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { PersonalStatus } from "./PersonalWorkspaceUi";
import type { PersonalWorkspaceClient } from "./PersonalWorkspace";

type Entry = Awaited<
  ReturnType<PersonalWorkspaceClient["workflows"]["trace"]>
>["entries"][number];
export function PersonalWorkflowTrace({
  client,
  runId,
  onSelectCall,
  fallback,
}: {
  client: PersonalWorkspaceClient;
  runId: string;
  onSelectCall: (id: string) => void;
  fallback: ReactNode;
}) {
  const initialPage: { after: number; attemptId: string | undefined } = {
    after: -1,
    attemptId: undefined,
  };
  const pages = useInfiniteQuery({
    queryKey: ["personal", "workflow-trace", runId],
    initialPageParam: initialPage,
    queryFn: ({ pageParam, signal }) =>
      client.workflows.trace(runId, { ...pageParam, signal }),
    getNextPageParam: (page) =>
      page.nextCursor !== null && page.attempt
        ? { after: page.nextCursor, attemptId: page.attempt.id }
        : undefined,
    refetchInterval: 3000,
  });
  const first = pages.isError ? undefined : pages.data?.pages[0];
  if (pages.isError)
    return (
      <p role="alert">
        Execution structure is unavailable. Check your access and retry.
      </p>
    );
  if (!first?.attempt)
    return (
      <>
        {fallback}
        {first && (
          <p className="text-xs text-muted-foreground">
            No execution structure was recorded. Older runs may have only flat
            call history.
          </p>
        )}
      </>
    );
  const attemptId = first.attempt.id;
  const entries =
    pages.data?.pages
      .filter((page) => page.attempt?.id === attemptId)
      .flatMap((page) => page.entries) ?? [];
  const scopes = new Map<number | null, Entry[]>();
  const knownScopes = new Set(
    entries
      .filter((entry) => entry.kind === "workflow")
      .map((entry) => entry.nodeId),
  );
  const unplaced: Entry[] = [];
  for (const entry of entries) {
    if (entry.scopeId !== null && !knownScopes.has(entry.scopeId))
      unplaced.push(entry);
    else {
      const group = scopes.get(entry.scopeId) ?? [];
      group.push(entry);
      scopes.set(entry.scopeId, group);
    }
  }
  function renderEntries(rows: Entry[]): ReactNode {
    return (
      <ol className="space-y-2 border-l border-border pl-3 sm:pl-4">
        {rows.map((entry) => (
          <li key={entry.index} className="min-w-0">
            {entry.kind === "agent" ? (
              <div className="space-y-1 rounded-md border border-border bg-surface-recessed/40 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    Step {(entry.callIndex ?? 0) + 1}
                  </span>
                  <PersonalStatus status={entry.status} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {entry.source === "cached"
                    ? "Cached replay · no new worker"
                    : entry.source === "live"
                      ? "Live execution"
                      : "Worker admission"}
                </p>
                {entry.callId ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Inspect step ${(entry.callIndex ?? 0) + 1}`}
                    onClick={() => onSelectCall(entry.callId ?? "")}
                  >
                    Open step
                    <Icon name="ChevronRight" aria-hidden />
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {entry.status === "running"
                      ? "Waiting for worker admission."
                      : "The call record is unavailable or has changed since this attempt."}
                  </p>
                )}
                {entry.error && (
                  <p className="break-words text-destructive-text">
                    {entry.error}
                  </p>
                )}
              </div>
            ) : (
              <details
                open
                className="min-w-0 rounded-md border border-border p-3"
              >
                <summary className="cursor-pointer break-words font-medium">
                  {entry.kind === "workflow" ? "Workflow" : "Parallel group"} ·{" "}
                  {entry.name}
                </summary>
                <div className="mt-3 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <PersonalStatus status={entry.status} />
                    {entry.branchCount !== null && (
                      <span>
                        {entry.branchCount} branches ·{" "}
                        {entry.failedBranches ?? 0} failed
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {new Date(entry.createdAt).toLocaleString()} →{" "}
                    {entry.finishedAt === null
                      ? "In progress"
                      : new Date(entry.finishedAt).toLocaleString()}
                  </p>
                  {entry.sourceHash && (
                    <p className="break-all font-mono text-xs text-muted-foreground">
                      Source {entry.sourceHash}
                    </p>
                  )}
                  {entry.error && (
                    <p className="break-words text-destructive-text">
                      {entry.error}
                    </p>
                  )}
                  {entry.kind === "workflow" &&
                    entry.nodeId !== null &&
                    renderEntries(scopes.get(entry.nodeId) ?? [])}
                </div>
              </details>
            )}
          </li>
        ))}
      </ol>
    );
  }
  return (
    <section
      aria-label="Execution structure"
      className="space-y-3 border-t border-border pt-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-medium">Execution structure</h2>
        <span className="text-xs text-muted-foreground">
          Evaluator attempt {first.attempt.sequence}
        </span>
        <PersonalStatus status={first.attempt.status} />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Workflow scopes link to their actual agent calls. Parallel spans show
        explicit group boundaries; call membership is not inferred from timing.
      </p>
      {first.attempt.truncated && (
        <p role="status">
          Structure recording reached its limit. Execution continued; some
          scopes are incomplete.
        </p>
      )}
      {renderEntries(scopes.get(null) ?? [])}
      {unplaced.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-medium">Unrecorded workflow scope</h3>
          {renderEntries(unplaced)}
        </div>
      )}
      {entries.length === 0 && <p>No recorded steps or groups.</p>}
      {pages.hasNextPage && (
        <Button
          variant="outline"
          disabled={pages.isFetchingNextPage}
          onClick={() => void pages.fetchNextPage()}
        >
          More structure
        </Button>
      )}
      <details>
        <summary className="cursor-pointer py-2 font-medium">
          Flat call history
        </summary>
        {fallback}
      </details>
    </section>
  );
}
