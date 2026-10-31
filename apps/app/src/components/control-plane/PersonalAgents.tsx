import { personalInspectionSearch } from "./personal-inspection-navigation";
import { getControlPlaneThreadPath } from "@bb/server-contract";
import { useLocation } from "react-router-dom";
import { useState } from "react";
import { Link } from "react-router-dom";
import { PersonalAutomationEditor } from "./PersonalAutomationEditor";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Textarea } from "@bb/shared-ui/textarea";
import {
  PersonalPageHeader,
  PersonalEmpty,
  PersonalStatus,
  personalCodeClass,
} from "./PersonalWorkspaceUi";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import type { PersonalWorkspaceClient } from "./PersonalWorkspace";

export function PersonalAgents({
  client,
  projectId,
  canStart,
  onStart,
}: {
  client: PersonalWorkspaceClient;
  projectId: string | null;
  canStart: boolean;
  onStart: (profileId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [task, setTask] = useState("");
  const [retryKey, setRetryKey] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const catalog = useInfiniteQuery({
    queryKey: ["personal", "agents"],
    initialPageParam: null,
    queryFn: ({
      pageParam,
      signal,
    }: {
      pageParam: string | null;
      signal: AbortSignal;
    }) => client.profiles.list({ cursor: pageParam ?? undefined, signal }),
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: 15_000,
  });
  const agents = catalog.isError
    ? []
    : (catalog.data?.pages.flatMap((page) => page.profiles) ?? []);
  const selected = agents.find((agent) => agent.id === selectedId);
  const detail = useQuery({
    queryKey: ["personal", "agent", selected?.id, selected?.latestVersionId],
    queryFn: ({ signal }) => {
      if (!selected) throw new Error("No agent selected");
      return client.profiles.get(selected.id, {
        versionId: selected.latestVersionId,
        signal,
      });
    },
    enabled: selected !== undefined && !catalog.isError,
    refetchInterval: 15_000,
  });
  const current =
    !detail.isError && detail.data?.profile.id === selected?.id
      ? detail.data
      : undefined;
  const runs = useInfiniteQuery({
    queryKey: ["personal", "agent-runs", projectId],
    initialPageParam: null,
    queryFn: ({
      pageParam,
      signal,
    }: {
      pageParam: string | null;
      signal: AbortSignal;
    }) =>
      client.agentRuns.list({
        projectId: projectId ?? undefined,
        cursor: pageParam ?? undefined,
        signal,
      }),
    getNextPageParam: (page) => page.nextCursor,
    enabled: projectId !== null,
    refetchInterval: 3000,
  });
  const startTask = useMutation({
    mutationFn: async () => {
      if (!projectId || !current) throw new Error("Choose a project and agent");
      const key = retryKey ?? crypto.randomUUID();
      setRetryKey(key);
      return client.agentRuns.start({
        projectId,
        profileVersionId: current.version.id,
        input: task,
        source: "manual",
        idempotencyKey: key,
      });
    },
    onSuccess: () => {
      setTask("");
      setRetryKey(null);
      void queryClient.invalidateQueries({
        queryKey: ["personal", "agent-runs", projectId],
      });
    },
  });
  return (
    <section
      aria-label="Available agents"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <PersonalPageHeader
        title="Agents"
        icon="Bot"
        description="Choose an approved agent to start a conversation, run a task or schedule work."
      />
      {catalog.isError ? (
        <div role="alert" className="min-w-0">
          Agents are unavailable. Check your access and refresh.
          <Button variant="outline" onClick={() => void catalog.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="mx-auto grid w-full max-w-6xl flex-1 gap-5 p-4 sm:p-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <div
            className={`${selectedId ? "hidden lg:block" : ""} self-start rounded-lg border border-border bg-surface-recessed/40 p-2`}
          >
            <h2 className="px-3 py-2 text-sm font-medium">Your agents</h2>
            <ul className="space-y-1" aria-label="Agent catalog">
              {agents.map((agent) => (
                <li key={agent.id}>
                  <Button
                    variant="ghost"
                    className="h-auto min-h-12 w-full justify-start gap-3 whitespace-normal px-3 py-3 text-left"
                    aria-pressed={selected?.id === agent.id}
                    onClick={() => setSelectedId(agent.id)}
                  >
                    <Icon name="Bot" className="size-4 shrink-0" />
                    <span className="min-w-0 truncate">{agent.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      v{agent.latestVersion}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
            {catalog.isPending && <p role="status">Loading agents…</p>}
            {catalog.isSuccess && agents.length === 0 && (
              <p className="px-3 py-2 text-sm text-muted-foreground">
                No agents have been shared with you.
              </p>
            )}
            {catalog.hasNextPage && (
              <Button
                variant="ghost"
                disabled={catalog.isFetchingNextPage}
                onClick={() => void catalog.fetchNextPage()}
              >
                More agents
              </Button>
            )}
          </div>
          <div className="min-w-0 space-y-3">
            {selectedId && (
              <Button
                className="lg:hidden"
                variant="ghost"
                size="sm"
                onClick={() => setSelectedId(null)}
              >
                <Icon name="ChevronLeft" aria-hidden />
                All agents
              </Button>
            )}
            {!selected ? (
              <div className="rounded-lg border border-border">
                <PersonalEmpty icon="Bot">
                  Select an agent to see its current version.
                </PersonalEmpty>
              </div>
            ) : detail.isError ? (
              <p role="alert">
                This agent is unavailable. Refresh the catalog.
              </p>
            ) : !current ? (
              <p role="status">Loading agent…</p>
            ) : (
              <div className="space-y-5 rounded-lg border border-border bg-background p-4 sm:p-5">
                <div>
                  <h2 className="text-lg font-medium">
                    {current.profile.name}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Version {current.version.version} · {current.profile.slug}
                  </p>
                  <p className="mt-3 text-sm">
                    {current.version.definition.purpose ??
                      "This version has no published purpose."}
                  </p>
                </div>

                {!current.version.definition.workflow && (
                  <Button
                    disabled={
                      !canStart ||
                      !current.profile.enabled ||
                      !current.version.enabled
                    }
                    onClick={() => onStart(current.profile.id)}
                  >
                    <Icon name="MessageSquare" aria-hidden />
                    Start conversation
                  </Button>
                )}
                <div className="space-y-4 border-t border-border pt-5">
                  <h3 className="text-sm font-medium">Run a background task</h3>
                  <Textarea
                    aria-label="Background task"
                    className="min-h-28 bg-background"
                    maxLength={131072}
                    value={task}
                    onChange={(event) => {
                      setTask(event.target.value);
                      setRetryKey(null);
                    }}
                    placeholder="Describe the task for this agent"
                  />
                  <Button
                    disabled={
                      !canStart ||
                      !current.profile.enabled ||
                      !current.version.enabled ||
                      !task.trim() ||
                      startTask.isPending
                    }
                    onClick={() => startTask.mutate()}
                  >
                    {startTask.isPending ? "Starting…" : "Run task"}
                  </Button>
                  {startTask.isError && (
                    <p role="alert" className="text-sm text-destructive-text">
                      {startTask.error.message}
                    </p>
                  )}
                </div>
                {projectId && (
                  <>
                    {!current.version.definition.workflow && (
                      <div className="space-y-4 border-t border-border pt-5">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            disabled={
                              !canStart ||
                              !current.profile.enabled ||
                              !current.version.enabled
                            }
                            onClick={() => setScheduleOpen(!scheduleOpen)}
                          >
                            {scheduleOpen
                              ? "Close schedule editor"
                              : "Schedule this agent"}
                          </Button>
                          <Link
                            className="inline-flex items-center text-sm underline"
                            to="?view=automations"
                          >
                            Manage schedules and history
                          </Link>
                        </div>
                        {scheduleOpen && (
                          <PersonalAutomationEditor
                            key={`${projectId}:${current.version.id}`}
                            client={client}
                            saved={null}
                            originThreadId={null}
                            target={{
                              projectId,
                              profileVersionId: current.version.id,
                            }}
                            canExecute={
                              canStart &&
                              current.profile.enabled &&
                              current.version.enabled
                            }
                            onReload={null}
                            onSaved={() => {
                              setScheduleOpen(false);
                              void queryClient.invalidateQueries({
                                queryKey: [
                                  "personal",
                                  "automations",
                                  projectId,
                                ],
                              });
                            }}
                          />
                        )}
                      </div>
                    )}
                    <PersonalAgentRunList
                      client={client}
                      projectId={projectId}
                      runs={
                        runs.data?.pages
                          .flatMap((page) => page.runs)
                          .filter(
                            (run) => run.profileId === current.profile.id,
                          ) ?? []
                      }
                    />
                    {runs.isError && <p role="alert">{runs.error.message}</p>}
                    {runs.hasNextPage && (
                      <Button
                        variant="outline"
                        disabled={runs.isFetchingNextPage}
                        onClick={() => void runs.fetchNextPage()}
                      >
                        More tasks
                      </Button>
                    )}
                  </>
                )}
                <details className="border-t border-border pt-4">
                  <summary className="cursor-pointer rounded text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Agent configuration
                  </summary>{" "}
                  <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 [&_dd]:mt-1 [&_dt]:text-xs">
                    <div>
                      <dt className="text-muted-foreground">Model</dt>
                      <dd>{current.version.definition.model}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Reasoning</dt>
                      <dd>{current.version.definition.reasoningLevel}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Permissions</dt>
                      <dd>{current.version.definition.permissionMode}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Tools</dt>
                      <dd className="break-words">
                        {current.version.definition.tools.join(", ") || "None"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">MCP sources</dt>
                      <dd className="break-words">
                        {current.version.definition.mcpServers.join(", ") ||
                          "None"}
                      </dd>
                    </div>
                  </dl>
                </details>
                {!canStart && (
                  <p className="text-sm text-muted-foreground">
                    Select a project where you can run conversations first.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function PersonalAgentRunList({
  client,
  projectId,
  runs,
}: {
  client: PersonalWorkspaceClient;
  projectId: string;
  runs: Awaited<
    ReturnType<PersonalWorkspaceClient["agentRuns"]["list"]>
  >["runs"];
}) {
  const location = useLocation();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const result = useQuery({
    queryKey: ["personal", "agent-run-result", selectedRunId],
    queryFn: ({ signal }) =>
      client.agentRuns.result(selectedRunId ?? "", signal),
    enabled: selectedRunId !== null,
    refetchInterval: 3000,
  });
  const events = useInfiniteQuery({
    queryKey: ["personal", "agent-run-events", selectedRunId],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      client.agentRuns.events(selectedRunId ?? "", {
        after: pageParam,
        limit: 50,
        signal,
      }),
    getNextPageParam: (page) => (page.hasMore ? page.cursor : undefined),
    enabled:
      selectedRunId !== null &&
      runs.find((run) => run.runId === selectedRunId)?.strategy !== "workflow",
    refetchInterval: 3000,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => client.agentRuns.cancel(id),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: ["personal", "agent-runs", projectId],
      }),
  });
  return (
    <div className="space-y-4 border-t border-border pt-5">
      <h3 className="text-sm font-medium">Background tasks</h3>
      {runs.length === 0 && (
        <p className="text-sm text-muted-foreground">No tasks yet.</p>
      )}
      <ul className="space-y-2">
        {runs.map((run) => (
          <li
            key={run.runId}
            className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface-recessed/40 p-3 text-sm"
          >
            <button
              className="min-w-0 flex-1 basis-full cursor-pointer rounded py-1 text-left font-medium break-words sm:basis-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setSelectedRunId(run.runId)}
            >
              {run.title ?? run.runId}
            </button>
            <span>
              {run.source === "automation" ? "Scheduled" : "Manual"} ·{" "}
              <PersonalStatus status={run.status} />
            </span>
            {["pending", "starting", "active", "queued", "running"].includes(
              run.status,
            ) && (
              <Button
                variant="outline"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(run.runId)}
              >
                Cancel
              </Button>
            )}
          </li>
        ))}
      </ul>
      {selectedRunId && (
        <div
          className="space-y-3 rounded-md border border-border p-4 text-sm"
          aria-live="polite"
        >
          <p className="break-all">Task {selectedRunId}</p>
          <p>Status: {result.data?.run.status ?? "Loading…"}</p>
          {result.data && (
            <Button asChild variant="outline">
              <Link
                to={
                  result.data.run.workflowRunId
                    ? {
                        search: personalInspectionSearch(
                          location.search,
                          result.data.run.workflowRunId,
                        ),
                      }
                    : getControlPlaneThreadPath(
                        projectId,
                        result.data.run.threadId ?? result.data.run.runId,
                      )
                }
              >
                {result.data.run.workflowRunId
                  ? "Inspect execution"
                  : "Open conversation"}
              </Link>
            </Button>
          )}
          {result.data?.text && (
            <pre className={`${personalCodeClass} font-sans text-sm`}>
              {result.data.text}
            </pre>
          )}
          {result.isError && <p role="alert">{result.error.message}</p>}
          {result.data?.run.strategy !== "workflow" && (
            <>
              <h4 className="font-medium">Events</h4>
              {events.isError && <p role="alert">{events.error.message}</p>}
              <ol className="max-h-48 space-y-1 overflow-y-auto">
                {events.data?.pages
                  .flatMap((page) => page.events)
                  .map((event) => (
                    <li key={event.seq} className="text-muted-foreground">
                      #{event.seq} {event.type}
                    </li>
                  ))}
              </ol>
              {events.hasNextPage && (
                <Button
                  variant="outline"
                  disabled={events.isFetchingNextPage}
                  onClick={() => void events.fetchNextPage()}
                >
                  More events
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
