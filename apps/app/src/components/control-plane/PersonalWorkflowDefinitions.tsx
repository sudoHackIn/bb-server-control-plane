import { useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import {
  controlPlaneWorkflowDefinitionCreateSchema,
  type ControlPlaneWorkflowDefinition,
} from "@bb/domain";
import type { PersonalWorkspaceClient } from "./PersonalWorkspace";

export function PersonalWorkflowDefinitions({
  client,
  projectId,
  originThreadId,
  canExecute,
  script,
  args,
  onLoad,
  onStarted,
}: {
  client: PersonalWorkspaceClient;
  projectId: string;
  originThreadId: string | null;
  canExecute: boolean;
  script: string;
  args: string;
  onLoad: (definition: ControlPlaneWorkflowDefinition) => void;
  onStarted: (
    run: Awaited<
      ReturnType<PersonalWorkspaceClient["workflows"]["definitions"]["run"]>
    >,
  ) => void;
}) {
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const cache = useQueryClient();
  const [loaded, setLoaded] = useState<ControlPlaneWorkflowDefinition | null>(
    null,
  );
  const key = ["personal", "workflow-definitions", projectId];
  const api = client.workflows.definitions;
  const definitions = useInfiniteQuery({
    queryKey: key,
    initialPageParam: null,
    queryFn: ({
      pageParam,
      signal,
    }: {
      pageParam: string | null;
      signal: AbortSignal;
    }) => api.list({ projectId, cursor: pageParam ?? undefined, signal }),
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: 15000,
  });
  const load = useMutation({
    mutationFn: async (id: string) => {
      const saved = await api.get(id);
      if (saved.projectId !== projectId)
        throw new Error("Definition project mismatch");
      return saved;
    },
    onSuccess: (saved) => {
      if (!live.current) return;
      setLoaded(saved);
      onLoad(saved);
    },
  });
  const change = useMutation({
    mutationFn: async (
      operation: "create" | "update" | "enable" | "disable" | "delete" | "run",
    ) => {
      if (operation === "create" || operation === "update") {
        const value: unknown = JSON.parse(args);
        const input = controlPlaneWorkflowDefinitionCreateSchema.parse({
          originThreadId: loaded?.originThreadId ?? originThreadId,
          script,
          args: value,
        });
        const saved =
          operation === "create"
            ? await api.create({
                ...input,
                originThreadId: originThreadId ?? "",
              })
            : loaded
              ? await api.update(loaded.id, {
                  expectedRevision: loaded.revision,
                  script: input.script,
                  args: input.args,
                })
              : null;
        if (!saved) throw new Error("No definition selected");
        setLoaded(saved);
      } else {
        if (!loaded) throw new Error("No definition selected");
        if (operation === "delete") {
          await api.remove(loaded.id);
          setLoaded(null);
        } else if (operation === "run") {
          const started = await api.run(loaded.id, {
            revision: loaded.revision,
          });
          if (live.current) onStarted(started);
        } else {
          const saved = await api.setEnabled(loaded.id, operation === "enable");
          setLoaded((previous) =>
            previous ? { ...previous, enabled: saved.enabled } : null,
          );
        }
      }
    },
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: key });
    },
  });
  return (
    <section
      aria-label="Saved workflow definitions"
      className="space-y-3 border-b pb-4"
    >
      <h2 className="text-base font-medium">Saved definitions</h2>
      <p className="text-sm text-muted-foreground">
        Immutable source and default-argument revisions. Saved runs use the
        definition's original conversation and current execution grants.
      </p>
      {definitions.isError ? (
        <p role="alert">
          Saved definitions are unavailable. Refresh to check your access.
        </p>
      ) : (
        <>
          <ul aria-label="Workflow definitions">
            {definitions.data?.pages
              .flatMap((page) => page.definitions)
              .map((saved) => (
                <li key={saved.id}>
                  <Button
                    variant="ghost"
                    disabled={load.isPending || change.isPending}
                    onClick={() => {
                      change.reset();
                      load.mutate(saved.id);
                    }}
                  >
                    Load {saved.name} · v{saved.revision}
                    {saved.enabled ? "" : " · disabled"}
                  </Button>
                </li>
              ))}
          </ul>
          {definitions.isPending && <p role="status">Loading definitions…</p>}
          {definitions.hasNextPage && (
            <Button
              variant="outline"
              disabled={definitions.isFetchingNextPage}
              onClick={() => void definitions.fetchNextPage()}
            >
              More definitions
            </Button>
          )}
          {loaded && !load.isError && (
            <div className="space-y-2">
              <p className="break-words text-sm">
                Definition {loaded.id} · v{loaded.revision} ·{" "}
                {loaded.enabled ? "enabled" : "disabled"}
              </p>
              <p className="break-words text-sm text-muted-foreground">
                Saved origin {loaded.originThreadId}. Updating retains this
                origin; running uses the saved source and arguments.
              </p>
              <div className="flex flex-wrap gap-2">
                {originThreadId && (
                  <Button
                    variant="outline"
                    disabled={change.isPending || !script.trim()}
                    onClick={() => change.mutate("update")}
                  >
                    Update saved definition
                  </Button>
                )}
                <Button
                  variant="outline"
                  disabled={change.isPending}
                  onClick={() =>
                    change.mutate(loaded.enabled ? "disable" : "enable")
                  }
                >
                  {loaded.enabled ? "Disable definition" : "Enable definition"}
                </Button>
                {canExecute && (
                  <Button
                    variant="outline"
                    disabled={change.isPending || !loaded.enabled}
                    onClick={() => change.mutate("run")}
                  >
                    Run saved workflow
                  </Button>
                )}
                <Button
                  variant="outline"
                  disabled={change.isPending}
                  onClick={() => change.mutate("delete")}
                >
                  Delete definition
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {originThreadId && (
          <Button
            variant="outline"
            disabled={change.isPending || !script.trim()}
            onClick={() => change.mutate("create")}
          >
            Save new definition
          </Button>
        )}
        <Button variant="ghost" onClick={() => void definitions.refetch()}>
          Refresh definitions
        </Button>
      </div>
      {(load.isError || change.isError) && (
        <p role="alert">
          Definition action failed. Check access and reload the latest revision
          before editing.
        </p>
      )}
    </section>
  );
}
