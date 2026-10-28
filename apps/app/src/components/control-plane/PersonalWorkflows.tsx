import { PersonalWorkflowDefinitions } from "./PersonalWorkflowDefinitions";
import { useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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
  return (
    <section
      aria-label="Personal workflows"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6"
    >
      <h1 className="text-lg font-medium">Workflows</h1>
      <p className="text-sm text-muted-foreground">
        Your runs in this project. Progress refreshes every two seconds.
      </p>
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
      <Button
        variant="outline"
        onClick={() => {
          void runs.refetch();
          if (selected) {
            void detail.refetch();
            void result.refetch();
            void history.refetch();
          }
        }}
      >
        Refresh workflows
      </Button>
      {unavailable ? (
        <p role="alert">
          Workflows are unavailable. Check your access and refresh.
        </p>
      ) : (
        <>
          <ul aria-label="Workflow runs" className="space-y-2">
            {runs.data?.pages
              .flatMap((page) => page.runs)
              .map((item) => (
                <li key={item.id}>
                  <Button
                    variant="ghost"
                    aria-pressed={selected === item.id}
                    onClick={() => {
                      setSelected(item.id);
                      setResumeRunId(null);
                      stop.reset();
                    }}
                  >
                    {item.name} · {item.status}
                  </Button>
                </li>
              ))}
          </ul>
          {runs.isPending && <p role="status">Loading workflows…</p>}
          {runs.data?.pages.every((page) => page.runs.length === 0) && (
            <p>No workflow runs yet.</p>
          )}
          {runs.hasNextPage && (
            <Button
              variant="outline"
              disabled={runs.isFetchingNextPage}
              onClick={() => void runs.fetchNextPage()}
            >
              More workflows
            </Button>
          )}
          {run && (
            <section aria-label="Selected workflow" className="space-y-3">
              <h2 className="text-base font-medium">{run.name}</h2>
              <p className="break-words text-sm text-muted-foreground">
                Run {run.id}
              </p>
              <p role="status">
                {run.status}
                {run.phase ? ` · ${run.phase}` : ""}
              </p>
              {run.error && (
                <pre className="whitespace-pre-wrap break-words text-sm">
                  {run.error}
                </pre>
              )}
              {run.status === "queued" || run.status === "running" ? (
                <Button
                  variant="outline"
                  disabled={stop.isPending}
                  onClick={() => stop.mutate(run.id)}
                >
                  Stop workflow
                </Button>
              ) : (
                canExecute && (
                  <Button
                    variant="outline"
                    onClick={() => setResumeRunId(run.id)}
                  >
                    Prepare replay
                  </Button>
                )
              )}
              {stop.isError && (
                <p role="alert">Unable to stop workflow. Refresh and retry.</p>
              )}
              <h3 className="text-sm font-medium">Result</h3>
              {result.data?.available ? (
                <pre
                  aria-label="Workflow result"
                  className="whitespace-pre-wrap break-words text-sm"
                >
                  {JSON.stringify(result.data.value, null, 2)}
                </pre>
              ) : (
                <p>No result yet.</p>
              )}
              <h3 className="text-sm font-medium">Agent calls</h3>
              <ul aria-label="Workflow agent calls" className="space-y-2">
                {history.data?.pages
                  .flatMap((page) => page.calls)
                  .map((call) => (
                    <li key={call.id} className="text-sm">
                      <p>
                        {call.index}: {call.label ?? call.model} · {call.status}
                        {call.phase ? ` · ${call.phase}` : ""}
                      </p>
                      <p>
                        {call.provider} / {call.model} / {call.reasoningLevel} ·
                        retries {call.providerRetryAttempts} · repairs{" "}
                        {call.repairAttempts}
                      </p>
                      {call.error && (
                        <pre className="whitespace-pre-wrap break-words">
                          {call.error}
                        </pre>
                      )}
                    </li>
                  ))}
              </ul>
              {history.hasNextPage && (
                <Button
                  variant="outline"
                  disabled={history.isFetchingNextPage}
                  onClick={() => void history.fetchNextPage()}
                >
                  More agent calls
                </Button>
              )}
            </section>
          )}
        </>
      )}
      {canExecute ? (
        <form
          className="space-y-3 border-t pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            start.mutate();
          }}
        >
          <h2 className="text-base font-medium">
            {resumeRunId ? "Replay workflow" : "Start workflow"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {originThreadId
              ? "Runs in the current conversation’s server environment."
              : "Runs in this project with the selected agent’s pinned profile."}{" "}
            Replay requires the same execution context, source and arguments and
            reuses only the unchanged successful prefix.
          </p>
          {originThreadId === null && (
            <label className="block text-sm">
              Execution agent
              <select
                className="mt-1 block w-full rounded border bg-background p-2 text-sm"
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
                <span role="alert">Unable to load approved agents.</span>
              )}
            </label>
          )}
          <label className="block text-sm">
            Workflow source
            <textarea
              className="mt-1 block min-h-40 w-full rounded border bg-background p-2 font-mono text-sm"
              value={script}
              onChange={(event) => setScript(event.target.value)}
              required
            />
          </label>
          <label className="block text-sm">
            Workflow arguments (JSON)
            <textarea
              className="mt-1 block min-h-16 w-full rounded border bg-background p-2 font-mono text-sm"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              required
            />
          </label>
          <Button
            type="submit"
            disabled={
              start.isPending ||
              !script.trim() ||
              (originThreadId === null && !profileVersionId)
            }
          >
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
          {start.isError && (
            <p role="alert">
              Unable to start workflow. Check source, JSON arguments and current
              execution access.
            </p>
          )}
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          Execution access to this project is required to start a workflow.
        </p>
      )}
    </section>
  );
}
