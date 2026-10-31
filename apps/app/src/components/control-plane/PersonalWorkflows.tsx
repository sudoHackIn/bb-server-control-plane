import { Link, useLocation } from "react-router-dom";
import { personalInspectionSearch } from "./personal-inspection-navigation";
import { PersonalWorkflowDefinitions } from "./PersonalWorkflowDefinitions";
import { useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Icon } from "@bb/shared-ui/icon";
import { Textarea } from "@bb/shared-ui/textarea";
import {
  PersonalPageHeader,
  PersonalStatus,
  PersonalEmpty,
  personalFieldClass,
  personalCodeClass,
  personalPanelClass,
} from "./PersonalWorkspaceUi";
import { Button } from "@bb/shared-ui/button";
import { controlPlaneWorkflowStartSchema } from "@bb/domain";
import type { PersonalWorkspaceClient } from "./PersonalWorkspace";

export function PersonalWorkflows({
  client,
  projectId,
  originThreadId,
  canExecute,
}: {
  client: PersonalWorkspaceClient;
  projectId: string;
  originThreadId: string | null;
  canExecute: boolean;
}) {
  const location = useLocation();
  const cache = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [profileVersionId, setProfileVersionId] = useState("");
  const profiles = useQuery({
    queryKey: ["personal", "workflow-profiles", projectId],
    queryFn: ({ signal }) => client.profiles.list({ limit: 100, signal }),
    enabled: canExecute && originThreadId === null,
  });
  const [script, setScript] = useState("");
  const [args, setArgs] = useState("null");
  const [resumeRunId, setResumeRunId] = useState<string | null>(null);
  const listKey = ["personal", "workflows", projectId];
  const runs = useInfiniteQuery({
    queryKey: listKey,
    initialPageParam: null,
    queryFn: ({
      pageParam,
      signal,
    }: {
      pageParam: string | null;
      signal: AbortSignal;
    }) =>
      client.workflows.list({
        projectId,
        cursor: pageParam ?? undefined,
        signal,
      }),
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: 2000,
  });
  const detailKey = ["personal", "workflow", projectId, selected];
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) => {
      if (!selected) throw new Error("No workflow selected");
      return client.workflows.get(selected, signal);
    },
    enabled: selected !== null && !runs.isError,
    refetchInterval: 2000,
  });
  const run =
    !detail.isError &&
    detail.data?.id === selected &&
    detail.data.projectId === projectId
      ? detail.data
      : undefined;
  const result = useQuery({
    queryKey: [...detailKey, "result"],
    queryFn: ({ signal }) => {
      if (!selected) throw new Error("No workflow selected");
      return client.workflows.result(selected, signal);
    },
    enabled: run !== undefined && !runs.isError,
    refetchInterval: 2000,
  });
  const history = useInfiniteQuery({
    queryKey: [...detailKey, "history"],
    initialPageParam: -1,
    queryFn: ({ pageParam, signal }) => {
      if (!selected) throw new Error("No workflow selected");
      return client.workflows.history(selected, { after: pageParam, signal });
    },
    getNextPageParam: (page) => page.nextCursor,
    enabled: run !== undefined && !runs.isError,
    refetchInterval: 2000,
  });
  const start = useMutation({
    mutationFn: async () => {
      if (!canExecute) throw new Error("Project execution is unavailable");
      const value: unknown = JSON.parse(args);
      return client.workflows.start(
        controlPlaneWorkflowStartSchema.parse({
          originThreadId,
          ...(originThreadId === null ? { projectId, profileVersionId } : {}),
          script,
          args: value,
          resumeRunId,
        }),
      );
    },
    onSuccess: (created) => {
      setSelected(created.id);
      setResumeRunId(null);
      void cache.invalidateQueries({ queryKey: listKey });
    },
  });
  const stop = useMutation({
    mutationFn: (id: string) => client.workflows.stop(id),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: listKey });
      void cache.invalidateQueries({ queryKey: detailKey });
    },
  });
  const unavailable =
    runs.isError ||
    (selected !== null &&
      (detail.isError || result.isError || history.isError));
  const listedRuns = runs.data?.pages.flatMap((page) => page.runs) ?? [];
  const allRuns = (
    run && !listedRuns.some((item) => item.id === run.id)
      ? [run, ...listedRuns]
      : [...listedRuns]
  ).sort((left, right) => right.createdAt - left.createdAt);
  const calls = history.data?.pages.flatMap((page) => page.calls) ?? [];
  return (
    <section
      aria-label="Personal workflows"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background"
    >
      <PersonalPageHeader
        title="Workflows"
        icon="Workflow"
        description="Run work in your project. Follow each step and review the result."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void runs.refetch();
                if (selected) {
                  void detail.refetch();
                  void result.refetch();
                  void history.refetch();
                }
              }}
            >
              <Icon name="ArrowReloadHorizontal" aria-hidden />
              Refresh workflows
            </Button>
            {canExecute && (
              <Button asChild size="sm">
                <a href="#personal-workflow-editor">
                  <Icon name="Plus" aria-hidden />
                  New workflow
                </a>
              </Button>
            )}
          </>
        }
      />
      <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-5 sm:px-6">
        {unavailable ? (
          <p
            role="alert"
            className="rounded-md border border-surface-destructive-border bg-surface-destructive p-4 text-sm text-destructive-text"
          >
            Workflows are unavailable. Check your access and refresh.
          </p>
        ) : (
          <div className="grid overflow-hidden rounded-lg border border-border lg:grid-cols-[17rem_minmax(0,1fr)]">
            <aside
              className={`${selected ? "hidden lg:block" : ""} min-w-0 border-b border-border bg-surface-recessed/40 p-2 lg:border-r lg:border-b-0`}
            >
              <div className="flex items-center justify-between px-3 py-3 text-xs font-medium text-muted-foreground">
                <h2>Runs</h2>
                <span>
                  {allRuns.length}
                  {runs.hasNextPage ? "+" : ""}
                </span>
              </div>
              <ul aria-label="Workflow runs" className="space-y-1">
                {allRuns.map((item) => (
                  <li key={item.id}>
                    <Button
                      variant="ghost"
                      className="h-auto min-h-14 w-full justify-start whitespace-normal px-3 py-3 text-left"
                      aria-label={`${item.name} · ${item.status}`}
                      aria-pressed={selected === item.id}
                      onClick={() => {
                        setSelected(item.id);
                        setResumeRunId(null);
                        stop.reset();
                      }}
                    >
                      <Icon
                        name="Workflow"
                        className="self-start text-muted-foreground"
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 space-y-1">
                        <span className="block break-words font-medium">
                          {item.name}
                        </span>
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <PersonalStatus status={item.status} />
                          <span className="text-xs font-normal text-muted-foreground">
                            {new Date(item.createdAt).toLocaleString(
                              undefined,
                              {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              },
                            )}
                          </span>
                        </span>
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
              {runs.isPending && (
                <p role="status" className="p-3 text-sm text-muted-foreground">
                  Loading workflows…
                </p>
              )}
              {runs.isSuccess && allRuns.length === 0 && (
                <PersonalEmpty icon="Workflow">
                  No workflow runs yet.
                </PersonalEmpty>
              )}
              {runs.hasNextPage && (
                <Button
                  variant="ghost"
                  className="mt-2 w-full"
                  disabled={runs.isFetchingNextPage}
                  onClick={() => void runs.fetchNextPage()}
                >
                  More workflows
                </Button>
              )}
            </aside>
            <div className="min-w-0 bg-background">
              {!run ? (
                <PersonalEmpty icon="ListTodo">
                  {selected
                    ? "Loading workflow…"
                    : "Select a run to see its progress and result."}
                </PersonalEmpty>
              ) : (
                <section
                  aria-label="Selected workflow"
                  className="space-y-5 p-4 sm:p-5"
                >
                  <Button
                    className="lg:hidden"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelected(null)}
                  >
                    <Icon name="ChevronLeft" aria-hidden />
                    All runs
                  </Button>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-2">
                      <h2 className="break-words text-base font-semibold">
                        {run.name}
                      </h2>
                      <p
                        role="status"
                        className="flex flex-wrap items-center gap-2 text-sm"
                      >
                        <PersonalStatus status={run.status} />
                        {run.phase && (
                          <span className="text-muted-foreground">
                            · {run.phase}
                          </span>
                        )}
                      </p>
                    </div>
                    {run.status === "queued" || run.status === "running" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={stop.isPending}
                        onClick={() => stop.mutate(run.id)}
                      >
                        <Icon name="Square" aria-hidden />
                        Stop workflow
                      </Button>
                    ) : (
                      canExecute && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setResumeRunId(run.id)}
                        >
                          <Icon name="RotateCcw" aria-hidden />
                          Prepare replay
                        </Button>
                      )
                    )}
                  </div>
                  <Button asChild variant="outline">
                    <Link
                      to={{
                        search: personalInspectionSearch(
                          location.search,
                          run.id,
                        ),
                      }}
                    >
                      Inspect execution
                    </Link>
                  </Button>
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    Run {run.id}
                  </p>
                  {run.error && (
                    <pre
                      className={`${personalCodeClass} text-destructive-text`}
                    >
                      {run.error}
                    </pre>
                  )}
                  {stop.isError && (
                    <p role="alert" className="text-sm text-destructive-text">
                      Unable to stop workflow. Refresh and retry.
                    </p>
                  )}
                  <div className="space-y-3 border-t border-border pt-4">
                    <h3 className="flex items-center gap-2 text-sm font-medium">
                      <Icon
                        name="ListTodo"
                        className="size-4 text-muted-foreground"
                        aria-hidden
                      />
                      Agent calls
                    </h3>
                    {calls.length === 0 && (
                      <p className="text-sm text-muted-foreground">
                        Agent steps will appear here as work begins.
                      </p>
                    )}
                    <ol aria-label="Workflow agent calls" className="space-y-2">
                      {calls.map((call) => (
                        <li
                          key={call.id}
                          aria-label={`${call.index}: ${call.label ?? call.model} · ${call.status}`}
                          className="rounded-md border border-border bg-surface-recessed/40 p-3 text-sm"
                        >
                          <div className="flex flex-wrap items-start gap-3">
                            <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-background font-mono text-xs text-muted-foreground">
                              {call.index + 1}
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="break-words font-medium">
                                {call.label ?? call.model}
                              </p>
                              {call.phase && (
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {call.phase}
                                </p>
                              )}
                            </div>
                            <PersonalStatus status={call.status} />
                          </div>
                          <details className="mt-2 pl-9 text-xs text-muted-foreground">
                            <summary className="cursor-pointer rounded py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                              Execution details
                            </summary>
                            <p className="mt-1 break-words">
                              {call.provider} / {call.model} /{" "}
                              {call.reasoningLevel} · retries{" "}
                              {call.providerRetryAttempts} · repairs{" "}
                              {call.repairAttempts}
                            </p>
                          </details>
                          {call.error && (
                            <pre
                              className={`${personalCodeClass} mt-3 text-destructive-text`}
                            >
                              {call.error}
                            </pre>
                          )}
                        </li>
                      ))}
                    </ol>
                    {history.hasNextPage && (
                      <Button
                        variant="ghost"
                        disabled={history.isFetchingNextPage}
                        onClick={() => void history.fetchNextPage()}
                      >
                        More agent calls
                      </Button>
                    )}
                  </div>
                  <div className="space-y-3 border-t border-border pt-4">
                    <h3 className="flex items-center gap-2 text-sm font-medium">
                      <Icon
                        name="FileText"
                        className="size-4 text-muted-foreground"
                        aria-hidden
                      />
                      Result
                    </h3>
                    {result.data?.available ? (
                      <pre
                        aria-label="Workflow result"
                        className={personalCodeClass}
                      >
                        {typeof result.data.value === "string"
                          ? result.data.value
                          : JSON.stringify(result.data.value, null, 2)}
                      </pre>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No result yet.
                      </p>
                    )}
                  </div>
                </section>
              )}
            </div>
          </div>
        )}
        {canExecute ? (
          <form
            id="personal-workflow-editor"
            className={`${personalPanelClass} scroll-mt-4`}
            onSubmit={(event) => {
              event.preventDefault();
              start.mutate();
            }}
          >
            <div className="flex items-start gap-3">
              <Icon
                name={resumeRunId ? "RotateCcw" : "Play"}
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <div className="space-y-1">
                <h2 className="text-sm font-semibold">
                  {resumeRunId ? "Replay workflow" : "Start workflow"}
                </h2>
                <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                  {originThreadId
                    ? "Uses this conversation’s project and agent profile."
                    : "Choose an approved agent profile to run in this project."}{" "}
                  Replay reuses the unchanged successful steps.
                </p>
              </div>
            </div>
            {originThreadId === null && (
              <label className="block max-w-md text-sm font-medium">
                Execution agent
                <select
                  className={personalFieldClass}
                  value={profileVersionId}
                  onChange={(event) => setProfileVersionId(event.target.value)}
                  required
                  disabled={profiles.isPending || profiles.isError}
                >
                  <option value="">Choose an approved agent</option>
                  {profiles.data?.profiles.map((profile) => (
                    <option key={profile.id} value={profile.latestVersionId}>
                      {profile.name} · v{profile.latestVersion}
                    </option>
                  ))}
                </select>
                {profiles.isError && (
                  <span role="alert" className="text-destructive-text">
                    Unable to load approved agents.
                  </span>
                )}
              </label>
            )}
            <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <label className="block min-w-0 text-sm font-medium">
                Workflow source
                <Textarea
                  className="mt-1.5 min-h-48 bg-background font-mono text-xs leading-relaxed"
                  value={script}
                  onChange={(event) => setScript(event.target.value)}
                  required
                  spellCheck={false}
                />
              </label>
              <label className="block min-w-0 text-sm font-medium">
                Workflow arguments (JSON)
                <Textarea
                  className="mt-1.5 min-h-28 bg-background font-mono text-xs leading-relaxed xl:min-h-48"
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                  required
                  spellCheck={false}
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <Button
                type="submit"
                disabled={
                  start.isPending ||
                  !script.trim() ||
                  (originThreadId === null && !profileVersionId)
                }
              >
                <Icon name="Play" aria-hidden />
                {resumeRunId ? "Resume workflow" : "Run workflow"}
              </Button>
              {resumeRunId && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setResumeRunId(null)}
                >
                  Cancel replay
                </Button>
              )}
              <span className="text-xs text-muted-foreground">
                Runs in your server project
              </span>
            </div>
            {start.isError && (
              <p role="alert" className="text-sm text-destructive-text">
                Unable to start workflow. Check source, JSON arguments and
                current execution access.
              </p>
            )}
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">
            Execution access to this project is required to start a workflow.
          </p>
        )}
        <PersonalWorkflowDefinitions
          client={client}
          projectId={projectId}
          canExecute={canExecute}
          originThreadId={originThreadId}
          script={script}
          args={args}
          onLoad={(saved) => {
            setScript(saved.script);
            setArgs(JSON.stringify(saved.args, null, 2));
            setResumeRunId(null);
          }}
          onStarted={(created) => {
            setSelected(created.id);
            setResumeRunId(null);
            void cache.invalidateQueries({ queryKey: listKey });
          }}
        />
      </div>
    </section>
  );
}
