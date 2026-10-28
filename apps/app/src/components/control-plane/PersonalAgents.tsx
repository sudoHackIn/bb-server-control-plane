import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import type { PersonalWorkspaceClient } from "./PersonalWorkspace";

export function PersonalAgents({
  client,
  canStart,
  onStart,
}: {
  client: PersonalWorkspaceClient;
  canStart: boolean;
  onStart: (profileId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
