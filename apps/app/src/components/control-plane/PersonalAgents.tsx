import { useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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
      <div className="border-b px-6 py-5">
        <h1 className="text-lg font-medium">Agents</h1>
        <p className="text-sm text-muted-foreground">
          Approved agents available to your account. An administrator publishes
          their versions and grants access.
        </p>
      </div>
      {catalog.isError ? (
        <div role="alert" className="p-6">
          Agents are unavailable. Check your access and refresh.
          <Button variant="outline" onClick={() => void catalog.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(13rem,16rem)_minmax(0,1fr)]">
          <div className="border-b p-3 md:border-r md:border-b-0">
            <h2 className="px-3 py-2 text-sm font-medium">Your agents</h2>
            <ul className="space-y-1" aria-label="Agent catalog">
              {agents.map((agent) => (
                <li key={agent.id}>
                  <Button
                    variant={selected?.id === agent.id ? "secondary" : "ghost"}
                    className="h-auto w-full justify-start gap-2 text-left"
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
          <div className="p-6">
            {!selected ? (
              <p className="text-sm text-muted-foreground">
                Select an agent to see its current version.
              </p>
            ) : detail.isError ? (
              <p role="alert">
                This agent is unavailable. Refresh the catalog.
              </p>
            ) : !current ? (
              <p role="status">Loading agent…</p>
            ) : (
              <div className="max-w-2xl space-y-5 rounded-lg border p-5">
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
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
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
                <Button
                  disabled={
                    !canStart ||
                    !current.profile.enabled ||
                    !current.version.enabled
                  }
                  onClick={() => onStart(current.profile.id)}
                >
                  Start conversation
                </Button>
                <div className="space-y-3 border-t pt-4">
                  <h3 className="text-sm font-medium">Run a background task</h3>
                  <textarea
                    aria-label="Background task"
                    className="min-h-24 w-full rounded-md border bg-background p-3 text-sm"
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
                    <p role="alert" className="text-sm text-destructive">
                      {startTask.error.message}
                    </p>
                  )}
                </div>
                {projectId && (
                  <>
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
    enabled: selectedRunId !== null,
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
    <div className="space-y-3 border-t pt-4">
      <h3 className="text-sm font-medium">Background tasks</h3>
      {runs.length === 0 && (
        <p className="text-sm text-muted-foreground">No tasks yet.</p>
      )}
      <ul className="space-y-2">
        {runs.map((run) => (
          <li
            key={run.runId}
            className="flex items-center gap-2 rounded-md border p-2 text-sm"
          >
            <button
              className="min-w-0 flex-1 truncate text-left underline"
              onClick={() => setSelectedRunId(run.runId)}
            >
              {run.title ?? run.runId}
            </button>
            <span>{run.status}</span>
            {["pending", "starting", "active"].includes(run.status) && (
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
          className="space-y-2 rounded-md border p-3 text-sm"
          aria-live="polite"
        >
          <p>Task {selectedRunId}</p>
          <p>Status: {result.data?.run.status ?? "Loading…"}</p>
          {result.data?.text && (
            <pre className="whitespace-pre-wrap font-sans">
              {result.data.text}
            </pre>
          )}
          {result.isError && <p role="alert">{result.error.message}</p>}
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
        </div>
      )}
    </div>
  );
}
