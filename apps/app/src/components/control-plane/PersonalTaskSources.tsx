import { useId, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import type { PersonalWorkspaceClient } from "./PersonalWorkspace";
import {
  PersonalPageHeader,
  PersonalEmpty,
  PersonalStatus,
  personalFieldClass,
  personalPanelClass,
} from "./PersonalWorkspaceUi";
export function PersonalTaskSources({
  client,
  projectId,
  canCreate,
}: {
  client: PersonalWorkspaceClient;
  projectId: string;
  canCreate: boolean;
}) {
  const cache = useQueryClient();
  const agentId = useId();
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [interval, setInterval] = useState(300);
  const [selected, setSelected] = useState<string | null>(null);
  const sources = useInfiniteQuery({
    queryKey: ["personal", "task-sources", projectId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      client.taskSources.list({
        projectId,
        cursor: pageParam ?? undefined,
        signal,
      }),
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: 3000,
  });
  const agents = useInfiniteQuery({
    queryKey: ["personal", "agents"],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      client.profiles.list({ cursor: pageParam ?? undefined, signal }),
    getNextPageParam: (page) => page.nextCursor,
  });
  const history = useInfiniteQuery({
    queryKey: ["personal", "task-source-history", selected],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      if (!selected) throw new Error("Select a source");
      return client.taskSources.history(selected, {
        cursor: pageParam ?? undefined,
        signal,
      });
    },
    enabled: selected !== null,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: 3000,
  });
  const refresh = () =>
    cache.invalidateQueries({
      queryKey: ["personal", "task-sources", projectId],
    });
  const create = useMutation({
    mutationFn: () =>
      client.taskSources.create({
        projectId,
        profileVersionId: version,
        kind: "beads",
        name,
        intervalSeconds: interval,
      }),
    onSuccess: (source) => {
      setSelected(source.id);
      setName("");
      void refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      client.taskSources.setEnabled(id, enabled),
    onSuccess: () => {
      void refresh();
    },
  });
  const poll = useMutation({
    mutationFn: (id: string) => client.taskSources.poll(id),
    onSuccess: () => {
      void refresh();
      void cache.invalidateQueries({
        queryKey: ["personal", "task-source-history"],
      });
    },
  });
  const rows = sources.isError
    ? []
    : (sources.data?.pages.flatMap((page) => page.sources) ?? []);
  const current = rows.find((source) => source.id === selected);
  return (
    <section
      aria-label="Task sources"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <PersonalPageHeader
        title="Task sources"
        icon="ListTodo"
        description="Run an approved agent when work becomes ready in your project."
      />
      <div className="grid min-w-0 gap-6 p-4 lg:grid-cols-2 sm:p-6">
        <div className="min-w-0 space-y-4">
          <form
            className={personalPanelClass}
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <h2 className="text-sm font-semibold">Connect Beads</h2>
            <p className="text-sm text-muted-foreground">
              Reads ready tasks from this project’s .beads directory using your
              server account. The source starts paused. One Beads source is
              allowed per project.
            </p>
            <label className="block text-sm">
              Name
              <input
                className={personalFieldClass}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                required
                disabled={!canCreate}
              />
            </label>
            <div className="text-sm">
              <label htmlFor={agentId}>Agent</label>
              <select
                id={agentId}
                className={personalFieldClass}
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                required
                disabled={!canCreate || agents.isError}
              >
                <option value="">Choose an agent</option>
                {!agents.isError &&
                  agents.data?.pages
                    .flatMap((page) => page.profiles)
                    .map((agent) => (
                      <option
                        key={agent.latestVersionId}
                        value={agent.latestVersionId}
                      >
                        {agent.name}
                      </option>
                    ))}
              </select>
            </div>
            {agents.hasNextPage && (
              <Button
                type="button"
                variant="outline"
                onClick={() => void agents.fetchNextPage()}
                disabled={agents.isFetchingNextPage}
              >
                More agents
              </Button>
            )}
            {agents.isError && <p role="alert">Cannot load agents.</p>}
            <label className="block text-sm">
              Interval in seconds
              <input
                className={personalFieldClass}
                type="number"
                min={60}
                max={86400}
                value={interval}
                onChange={(event) => setInterval(Number(event.target.value))}
                required
                disabled={!canCreate}
              />
            </label>
            <Button
              type="submit"
              disabled={
                !canCreate || !version || !name.trim() || create.isPending
              }
            >
              Connect source
            </Button>
            {create.isError && (
              <p role="alert" className="text-sm text-destructive">
                Could not connect. Check your permissions and whether this
                project already has a source.
              </p>
            )}
          </form>
          <div className="overflow-hidden rounded-lg border border-border">
            <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">
              Project sources
            </h2>
            {sources.isError ? (
              <PersonalEmpty icon="ListTodo">
                Cannot load sources.
              </PersonalEmpty>
            ) : rows.length === 0 ? (
              <PersonalEmpty icon="ListTodo">
                No task source connected.
              </PersonalEmpty>
            ) : (
              rows.map((source) => (
                <button
                  key={source.id}
                  className="flex w-full items-center justify-between gap-4 border-b border-border px-4 py-4 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-pressed={source.id === selected}
                  onClick={() => setSelected(source.id)}
                >
                  <span className="min-w-0 break-words">{source.name}</span>
                  <PersonalStatus
                    status={source.enabled ? "enabled" : "paused"}
                  />
                </button>
              ))
            )}
            {sources.hasNextPage && (
              <Button
                variant="outline"
                onClick={() => void sources.fetchNextPage()}
              >
                More sources
              </Button>
            )}
          </div>
        </div>
        <div className="min-w-0 space-y-4">
          {current ? (
            <>
              <div className={personalPanelClass}>
                <h2 className="text-sm font-semibold">{current.name}</h2>
                <p className="text-sm">
                  Beads · every {current.intervalSeconds} seconds
                </p>
                <p className="text-sm text-muted-foreground">
                  {current.lastPollAt
                    ? `Last poll: ${new Date(current.lastPollAt).toLocaleString()}`
                    : "No poll yet"}
                </p>
                {current.enabled && (
                  <p className="text-sm text-muted-foreground">
                    Next poll: {new Date(current.nextPollAt).toLocaleString()}
                  </p>
                )}
                {current.error && (
                  <p role="status" className="text-sm text-destructive">
                    Polling or launch failed. Check Beads initialization,
                    project access and the agent grant. Retry delay increases
                    after failures.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={update.isPending}
                    onClick={() =>
                      update.mutate({
                        id: current.id,
                        enabled: !current.enabled,
                      })
                    }
                  >
                    {current.enabled ? "Pause" : "Enable"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!current.enabled || poll.isPending}
                    onClick={() => poll.mutate(current.id)}
                  >
                    {poll.isPending ? "Polling…" : "Poll now"}
                  </Button>
                </div>
                {(update.isError || poll.isError) && (
                  <p role="alert" className="text-sm text-destructive">
                    Action unavailable. Refresh and check your access.
                  </p>
                )}
                <p className="text-sm text-muted-foreground">
                  Each task ID starts at most one admitted run for this source.
                  Beads tasks are not automatically claimed or closed. Pausing
                  stops new admissions; existing runs continue.
                </p>
              </div>
              <div className="overflow-hidden rounded-lg border border-border">
                <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">
                  Tasks received
                </h2>
                {history.isError ? (
                  <PersonalEmpty icon="ListTodo">
                    Cannot load task history.
                  </PersonalEmpty>
                ) : (
                  history.data?.pages
                    .flatMap((page) => page.items)
                    .map((item) => (
                      <div
                        key={item.id}
                        className="space-y-2 border-b border-border p-4 text-sm"
                      >
                        <div className="flex flex-wrap justify-between gap-2">
                          <span className="break-words">{item.title}</span>
                          <PersonalStatus status={item.state} />
                        </div>
                        <p className="break-all text-muted-foreground">
                          {item.externalId}
                        </p>
                        {item.error && (
                          <p className="text-destructive">
                            Launch unavailable. The task is saved for retry.
                          </p>
                        )}
                        {item.runId && (
                          <Link
                            className="underline"
                            to={`/projects/${encodeURIComponent(projectId)}?view=inspections&inspectKind=${item.runId.startsWith("wfa_") ? "workflow" : "thread"}&inspectRun=${encodeURIComponent(item.runId)}`}
                          >
                            Open run
                          </Link>
                        )}
                      </div>
                    ))
                )}
                {history.hasNextPage && (
                  <Button
                    variant="outline"
                    onClick={() => void history.fetchNextPage()}
                  >
                    More tasks
                  </Button>
                )}
                <p className="p-4 text-sm text-muted-foreground">
                  Accepted means a run was created. Open it to see the result.
                </p>
              </div>
            </>
          ) : (
            <PersonalEmpty icon="ListTodo">
              Select a task source to see its status and history.
            </PersonalEmpty>
          )}
        </div>
      </div>
    </section>
  );
}
