import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Icon } from "@bb/shared-ui/icon";
import {
  PersonalPageHeader,
  PersonalStatus,
  PersonalEmpty,
  personalCodeClass,
} from "./PersonalWorkspaceUi";
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
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background"
    >
      <PersonalPageHeader
        title="Automations"
        icon="Calendar"
        description="Put recurring work on a schedule. Review upcoming runs and their results."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh}>
              <Icon name="ArrowReloadHorizontal" aria-hidden />
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
          </>
        }
      />
      <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
        {unavailable ? (
          <p role="alert">
            Automations are unavailable. Check your access and refresh.
          </p>
        ) : (
          <div className="grid overflow-hidden rounded-lg border border-border lg:grid-cols-[17rem_minmax(0,1fr)]">
            <aside
              className={`${selected || creating ? "hidden lg:block" : ""} min-w-0 border-b border-border bg-surface-recessed/40 p-2 lg:border-r lg:border-b-0`}
            >
              <h2 className="px-3 py-3 text-xs font-medium text-muted-foreground">
                Schedules
              </h2>
              <ul aria-label="Automation definitions" className="space-y-1">
                {definitions.data?.pages
                  .flatMap((page) => page.automations)
                  .map((item) => (
                    <li key={item.id}>
                      <Button
                        variant="ghost"
                        className="h-auto min-h-14 w-full justify-start whitespace-normal px-3 py-3 text-left"
                        aria-label={`${item.name} · ${item.enabled ? "enabled" : "paused"}`}
                        aria-pressed={selected === item.id}
                        onClick={() => {
                          select(item.id);
                          change.reset();
                        }}
                      >
                        <Icon
                          name="Calendar"
                          className="self-start text-muted-foreground"
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 space-y-1">
                          <span className="block break-words">{item.name}</span>
                          <PersonalStatus
                            status={item.enabled ? "enabled" : "paused"}
                          />
                        </span>
                      </Button>
                    </li>
                  ))}
              </ul>
              {definitions.isPending && (
                <p role="status">Loading automations…</p>
              )}
              {definitions.data?.pages.every(
                (page) => page.automations.length === 0,
              ) &&
                !definitions.hasNextPage && (
                  <PersonalEmpty icon="Calendar">
                    No automations yet.
                  </PersonalEmpty>
                )}
              {definitions.hasNextPage && (
                <Button
                  variant="outline"
                  disabled={definitions.isFetchingNextPage}
                  onClick={() => void definitions.fetchNextPage()}
                >
                  More automations
                </Button>
              )}
            </aside>
            <div className="min-w-0 space-y-5 p-4 sm:p-5">
              {(selected || creating) && (
                <Button
                  className="lg:hidden"
                  variant="ghost"
                  size="sm"
                  onClick={() => select(null)}
                >
                  <Icon name="ChevronLeft" aria-hidden />
                  All schedules
                </Button>
              )}
              {!saved && !creating && (
                <PersonalEmpty icon="Calendar">
                  Select a schedule to review its next run, history and
                  settings.
                </PersonalEmpty>
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
                <section aria-label="Selected automation" className="space-y-5">
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
                        {saved.enabled
                          ? "Pause automation"
                          : "Resume automation"}
                      </Button>
                    )}
                    {canExecute && (
                      <Button
                        variant="default"
                        disabled={change.isPending || !saved.enabled}
                        onClick={() =>
                          change.mutate({ id: saved.id, operation: "run" })
                        }
                      >
                        <Icon name="Play" aria-hidden />
                        Run automation
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      className="text-destructive-text"
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
                        Delete this automation and its run records? Active runs
                        will be stopped. Conversations remain available.
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
                  <h3 className="text-base font-medium">Run history</h3>
                  {history.isPending && (
                    <p role="status">Loading automation history…</p>
                  )}
                  <ul aria-label="Automation runs" className="space-y-3">
                    {history.data?.pages
                      .flatMap((page) => page.runs)
                      .map((run) => (
                        <li
                          key={run.id}
                          aria-label={`${run.id} · ${run.status} · ${run.trigger}`}
                          className="space-y-2 rounded-md border border-border bg-surface-recessed/40 p-3 text-sm"
                        >
                          <p>
                            <PersonalStatus status={run.status} /> ·{" "}
                            {run.trigger}
                            <span className="mt-1 block break-all font-mono text-xs text-muted-foreground">
                              {run.id}
                            </span>
                          </p>
                          <p>{new Date(run.startedAt).toLocaleString()}</p>
                          {(run.error || run.skipReason) && (
                            <pre className={personalCodeClass}>
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
                  <PersonalAutomationEditor
                    key={saved.id}
                    onReload={async () => {
                      const result = await detail.refetch({
                        throwOnError: true,
                      });
                      if (!result.data)
                        throw new Error("Automation unavailable");
                      return result.data;
                    }}
                    client={client}
                    saved={saved}
                    originThreadId={saved.createdByThreadId}
                    canExecute={canExecute}
                    onSaved={refresh}
                  />
                </section>
              )}
              {change.isError && (
                <p role="alert">
                  Automation action failed or cleanup is still pending. Refresh
                  and retry. A run cannot be stopped until its worker is
                  attached.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
