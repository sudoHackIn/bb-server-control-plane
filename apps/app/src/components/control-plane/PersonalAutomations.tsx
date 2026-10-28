import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import { PersonalAutomationOutput } from "./PersonalAutomationOutput";
import { PersonalAutomationEditor } from "./PersonalAutomationEditor";
import type { PersonalWorkspaceClient } from "./PersonalWorkspace";

export function PersonalAutomations({
  client,
  projectId,
  originThreadId,
  canExecute,
  onOpenThread,
}: {
  client: PersonalWorkspaceClient;
  projectId: string;
  originThreadId: string | null;
  canExecute: boolean;
  onOpenThread: (threadId: string) => void;
}) {
  const cache = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selected = params.get("automation");
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const requestKeys = useRef(new Map<string, string>());
  const lifetime = useRef({ live: true, controller: new AbortController() });
  useEffect(() => {
    const current = { live: true, controller: new AbortController() };
    lifetime.current = current;
    return () => {
      current.live = false;
      current.controller.abort();
    };
  }, []);
  const listKey = ["personal", "automations", projectId];
  const detailKey = ["personal", "automation", projectId, selected];
  const api = client.automations;
  const definitions = useInfiniteQuery({
    queryKey: listKey,
    initialPageParam: null,
    queryFn: ({
      pageParam,
      signal,
    }: {
      pageParam: string | null;
      signal: AbortSignal;
    }) =>
      api.list({
        projectId,
        cursor: pageParam ?? undefined,
        limit: 20,
        signal,
      }),
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: 5000,
  });
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: async ({ signal }) => {
      if (!selected) throw new Error("Choose an automation");
      const value = await api.definition(selected, signal);
      if (value.id !== selected || value.projectId !== projectId)
        throw new Error("Automation project mismatch");
      return value;
    },
    enabled: selected !== null && !definitions.isError,
    refetchInterval: 5000,
  });
  const history = useInfiniteQuery({
    queryKey: [...detailKey, "history"],
    initialPageParam: null,
    queryFn: async ({
      pageParam,
      signal,
    }: {
      pageParam: string | null;
      signal: AbortSignal;
    }) => {
      if (!selected) throw new Error("Choose an automation");
      const value = await api.history(selected, {
        cursor: pageParam ?? undefined,
        limit: 20,
        signal,
      });
      if (value.automationId !== selected)
        throw new Error("Automation history mismatch");
      return value;
    },
    getNextPageParam: (page) => page.nextCursor,
    enabled:
      selected !== null &&
      detail.isSuccess &&
      !definitions.isError &&
      !detail.isError,
    refetchInterval: 5000,
  });
  function select(id: string | null) {
    setCreating(false);
    setConfirmDelete(false);
    const next = new URLSearchParams(params);
    if (id) next.set("automation", id);
    else next.delete("automation");
    setParams(next);
  }
  function refresh() {
    void cache.invalidateQueries({ queryKey: listKey });
    void cache.invalidateQueries({ queryKey: detailKey });
  }
  const change = useMutation({
    mutationFn: async (input: {
      id: string;
      operation: "pause" | "resume" | "run" | "delete" | "stop";
      runId?: string;
    }) => {
      const signal = lifetime.current.controller.signal;
      switch (input.operation) {
        case "pause":
          return api.pause(input.id, signal);
        case "resume":
          return api.resume(input.id, signal);
        case "delete":
          return api.remove(input.id, signal);
        case "stop": {
          if (!input.runId) throw new Error("Choose a run");
          return api.stop(input.id, input.runId, signal);
        }
        case "run": {
          const key = requestKeys.current.get(input.id) ?? crypto.randomUUID();
          requestKeys.current.set(input.id, key);
          return api.run(input.id, { idempotencyKey: key }, signal);
        }
      }
    },
    onSuccess: (_result, input) => {
      if (!lifetime.current.live) return;
      if (input.operation === "run") requestKeys.current.delete(input.id);
      if (input.operation === "delete" && selected === input.id) select(null);
      refresh();
    },
  });
  const unavailable =
    definitions.isError ||
    (selected !== null && (detail.isError || history.isError));
  const saved =
    !unavailable &&
    detail.data?.id === selected &&
    detail.data.projectId === projectId
      ? detail.data
      : undefined;
  return (
    <section
      aria-label="Personal automations"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6"
    >
      <h1 className="text-lg font-medium">Automations</h1>
      <p className="text-sm text-muted-foreground">
        Your agent and script schedules in this project. Progress refreshes
        every five seconds.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={refresh}>
          Refresh automations
        </Button>
        {!unavailable && canExecute && originThreadId && (
          <Button
            onClick={() => {
              select(null);
              setCreating(true);
              change.reset();
            }}
          >
            New automation
          </Button>
        )}
      </div>
      {unavailable ? (
        <p role="alert">
          Automations are unavailable. Check your access and refresh.
        </p>
      ) : (
        <>
          <ul aria-label="Automation definitions" className="space-y-2">
            {definitions.data?.pages
              .flatMap((page) => page.automations)
              .map((item) => (
                <li key={item.id}>
                  <Button
                    variant="ghost"
                    aria-pressed={selected === item.id}
                    onClick={() => {
                      select(item.id);
                      change.reset();
                    }}
                  >
                    {item.name} · {item.enabled ? "enabled" : "paused"}
                  </Button>
                </li>
              ))}
          </ul>
          {definitions.isPending && <p role="status">Loading automations…</p>}
          {definitions.data?.pages.every(
            (page) => page.automations.length === 0,
          ) &&
            !definitions.hasNextPage && <p>No automations yet.</p>}
          {definitions.hasNextPage && (
            <Button
              variant="outline"
              disabled={definitions.isFetchingNextPage}
              onClick={() => void definitions.fetchNextPage()}
            >
              More automations
            </Button>
          )}
          {!originThreadId && canExecute && (
            <p className="text-sm text-muted-foreground">
              Open a conversation to create an automation using its agent
              profile.
            </p>
          )}
          {creating && canExecute && originThreadId && (
            <PersonalAutomationEditor
              key="new"
              onReload={null}
              client={client}
              saved={null}
              originThreadId={originThreadId}
              canExecute={canExecute}
              onSaved={(value) => {
                select(value.id);
                refresh();
              }}
            />
          )}
          {selected && detail.isPending && (
            <p role="status">Loading automation…</p>
          )}
          {saved && (
            <section
              aria-label="Selected automation"
              className="space-y-4 border-t pt-4"
            >
              <h2 className="text-base font-medium">{saved.name}</h2>
              <p className="text-sm text-muted-foreground">
                {saved.enabled ? "Enabled" : "Paused"} ·{" "}
                {saved.trigger.triggerType === "once"
                  ? `Once: ${new Date(saved.trigger.runAt).toLocaleString()}`
                  : `${saved.trigger.cron} (${saved.trigger.timezone})`}
              </p>
              <p className="text-sm">
                Next run:{" "}
                {saved.nextRunAt === null
                  ? "None"
                  : new Date(saved.nextRunAt).toLocaleString()}
              </p>
              {saved.createdByThreadId && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (saved.createdByThreadId)
                      onOpenThread(saved.createdByThreadId);
                  }}
                >
                  Open origin conversation
                </Button>
              )}
              <div className="flex flex-wrap gap-2">
                {(saved.enabled || canExecute) && (
                  <Button
                    variant="outline"
                    disabled={change.isPending}
                    onClick={() =>
                      change.mutate({
                        id: saved.id,
                        operation: saved.enabled ? "pause" : "resume",
                      })
                    }
                  >
                    {saved.enabled ? "Pause automation" : "Resume automation"}
                  </Button>
                )}
                {canExecute && (
                  <Button
                    variant="outline"
                    disabled={change.isPending || !saved.enabled}
                    onClick={() =>
                      change.mutate({ id: saved.id, operation: "run" })
                    }
                  >
                    Run automation
                  </Button>
                )}
                <Button
                  variant="outline"
                  disabled={change.isPending}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete automation
                </Button>
              </div>
              {confirmDelete && (
                <div
                  role="group"
                  aria-label="Confirm automation deletion"
                  className="space-y-2"
                >
                  <p>
                    Delete this automation and its run records? Active runs will
                    be stopped. Conversations remain available.
                  </p>
                  <Button
                    variant="outline"
                    disabled={change.isPending}
                    onClick={() =>
                      change.mutate({ id: saved.id, operation: "delete" })
                    }
                  >
                    Confirm delete automation
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={change.isPending}
                    onClick={() => setConfirmDelete(false)}
                  >
                    Keep automation
                  </Button>
                </div>
              )}
              <PersonalAutomationEditor
                key={saved.id}
                onReload={async () => {
                  const result = await detail.refetch({ throwOnError: true });
                  if (!result.data) throw new Error("Automation unavailable");
                  return result.data;
                }}
                client={client}
                saved={saved}
                originThreadId={saved.createdByThreadId}
                canExecute={canExecute}
                onSaved={refresh}
              />
              <h3 className="text-base font-medium">Run history</h3>
              {history.isPending && (
                <p role="status">Loading automation history…</p>
              )}
              <ul aria-label="Automation runs" className="space-y-3">
                {history.data?.pages
                  .flatMap((page) => page.runs)
                  .map((run) => (
                    <li key={run.id} className="space-y-1 text-sm">
                      <p>
                        {run.id} · {run.status} · {run.trigger}
                      </p>
                      <p>{new Date(run.startedAt).toLocaleString()}</p>
                      {(run.error || run.skipReason) && (
                        <pre className="whitespace-pre-wrap break-words">
                          {run.error ?? run.skipReason}
                        </pre>
                      )}
                      {run.runMode === "script" && (
                        <PersonalAutomationOutput
                          client={client}
                          projectId={projectId}
                          automationId={saved.id}
                          runId={run.id}
                        />
                      )}
                      {run.threadId && (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            if (run.threadId) onOpenThread(run.threadId);
                          }}
                        >
                          Open run conversation
                        </Button>
                      )}
                      {run.status === "running" && (
                        <Button
                          variant="outline"
                          disabled={change.isPending}
                          onClick={() =>
                            change.mutate({
                              id: saved.id,
                              operation: "stop",
                              runId: run.id,
                            })
                          }
                        >
                          Stop run {run.id}
                        </Button>
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
                  More automation runs
                </Button>
              )}
            </section>
          )}
          {change.isError && (
            <p role="alert">
              Automation action failed or cleanup is still pending. Refresh and
              retry. A run cannot be stopped until its worker is attached.
            </p>
          )}
        </>
      )}
    </section>
  );
}
