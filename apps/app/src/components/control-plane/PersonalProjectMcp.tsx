import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Input } from "@bb/shared-ui/input";
import { Icon } from "@bb/shared-ui/icon";
import {
  PersonalPageHeader,
  PersonalEmpty,
  personalFieldClass,
  personalPanelClass,
} from "./PersonalWorkspaceUi";
import { Button } from "@bb/shared-ui/button";
import type { PersonalWorkspaceClient } from "./PersonalWorkspace";

const readiness = {
  configured: "Personal credential saved",
  credentials_required: "Personal token required",
  connector_unavailable: "Connector unavailable",
  revision_mismatch: "Connection update required",
  access_denied: "Connector access unavailable",
};

export function PersonalProjectMcp({
  client,
  projectId,
  userId,
  canManage,
}: {
  client: PersonalWorkspaceClient;
  projectId: string;
  userId: string;
  canManage: boolean;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const key = ["personal", "mcp", userId, projectId];
  const catalog = useInfiniteQuery({
    queryKey: [...key, "catalog"],
    initialPageParam: null,
    queryFn: ({
      pageParam,
      signal,
    }: {
      pageParam: string | null;
      signal: AbortSignal;
    }) => client.mcp.list({ cursor: pageParam ?? undefined, signal }),
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: 15_000,
  });
  const connections = useQuery({
    queryKey: [...key, "connections"],
    queryFn: ({ signal }) => client.mcp.connections(projectId, signal),
    refetchInterval: 15_000,
  });
  const connectors =
    catalog.data?.pages.flatMap((page) => page.connectors) ?? [];
  const selected = connectors.find((item) => item.id === selectedId);
  const credential = useQuery({
    queryKey: [...key, "credential", selected?.id, selected?.revision],
    queryFn: ({ signal }) => {
      if (!selected) throw new Error("No connector selected");
      return client.mcp.credential(selected.id, signal);
    },
    enabled: selected !== undefined && !catalog.isError && !connections.isError,
    refetchInterval: 15_000,
  });
  const rows = connections.data?.connections ?? [];
  const connection = rows.find((item) => item.connectorId === selected?.id);
  const metadata = !credential.isError ? credential.data : undefined;
  const ready =
    selected &&
    metadata?.configured &&
    metadata.connectorRevision === selected.revision;
  async function refresh() {
    await Promise.all([
      catalog.refetch(),
      connections.refetch(),
      ...(selected ? [credential.refetch()] : []),
    ]);
  }
  async function perform<T>(action: () => Promise<T>) {
    setBusy(true);
    setError(false);
    setSaved(false);
    try {
      await action();
      await refresh();
      setSaved(true);
    } catch {
      setError(true);
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Project integrations"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background"
    >
      <PersonalPageHeader
        title="Integrations"
        icon="Puzzle"
        description="Connect approved tools to this project using your personal credentials."
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void refresh()}
          >
            <Icon name="ArrowReloadHorizontal" aria-hidden />
            Refresh integrations
          </Button>
        }
      />
      <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-5 sm:px-6">
        {catalog.isError || connections.isError ? (
          <p
            role="alert"
            className="rounded-md border border-surface-destructive-border bg-surface-destructive p-4 text-sm text-destructive-text"
          >
            Integrations are unavailable. Check your access and refresh.
          </p>
        ) : (
          <>
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
              Enabled means configured, not a successful connection test. Your
              conversation profile must allow project tools. Start a new
              conversation after changing a connection or token.
            </p>
            {(catalog.isPending || connections.isPending) && (
              <p role="status">Loading integrations…</p>
            )}
            {error && (
              <p role="alert">
                Unable to save changes. Check your access and refresh before
                trying again.
              </p>
            )}
            {saved && <p role="status">Changes saved.</p>}
            <h2 className="text-sm font-medium">Project connections</h2>
            <ul
              aria-label="Project connections"
              className="grid gap-3 md:grid-cols-2"
            >
              {rows.map((item) => (
                <li
                  key={item.id}
                  className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-recessed/40 p-4"
                >
                  <span className="min-w-0 basis-full break-words">
                    {item.name} · {item.enabled ? "Enabled" : "Disabled"} ·{" "}
                    {readiness[item.readiness]}
                  </span>
                  {connectors.some(
                    (connector) => connector.id === item.connectorId,
                  ) && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setSelectedId(item.connectorId);
                        setSaved(false);
                        setError(false);
                      }}
                    >
                      Manage {item.name}
                    </Button>
                  )}
                  {canManage && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void perform(() =>
                          client.mcp.remove(projectId, item.id, item.revision),
                        )
                      }
                    >
                      Remove {item.name}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {connections.isSuccess && rows.length === 0 && (
              <div className="rounded-lg border border-dashed border-border">
                <PersonalEmpty icon="Plug02">
                  No project connections yet.
                </PersonalEmpty>
              </div>
            )}
            <label className="flex flex-col gap-2 text-sm">
              Approved connector
              <select
                aria-label="Approved connector"
                value={selectedId}
                disabled={busy}
                className={`${personalFieldClass} max-w-md`}
                onChange={(event) => {
                  setSelectedId(event.target.value);
                  setError(false);
                  setSaved(false);
                }}
              >
                <option value="">Choose a connector</option>
                {connectors.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {catalog.hasNextPage && (
              <Button
                variant="outline"
                disabled={catalog.isFetchingNextPage || busy}
                onClick={() => void catalog.fetchNextPage()}
              >
                More connectors
              </Button>
            )}
            {catalog.isSuccess && connectors.length === 0 && (
              <p>
                No connectors are available to your account. Ask an
                administrator for access.
              </p>
            )}
            {selected && (
              <div
                key={selected.id + ":" + selected.revision}
                className={personalPanelClass}
              >
                <h2 className="text-base font-medium">{selected.name}</h2>
                <p className="break-all text-sm text-muted-foreground">
                  {selected.endpoint}
                </p>
                {credential.isError ? (
                  <p role="alert">
                    Your credential is unavailable. Refresh to check access.
                  </p>
                ) : !metadata ? (
                  <p role="status">Loading your credential…</p>
                ) : (
                  <>
                    <p>
                      {ready
                        ? "Your credential is saved for this connector version."
                        : "Save your personal token to enable this connector."}
                    </p>
                    <form
                      autoComplete="off"
                      className="flex flex-wrap items-end gap-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const form = event.currentTarget;
                        const token = new FormData(form).get("token");
                        form.reset();
                        if (typeof token !== "string" || !token) return;
                        void perform(() =>
                          client.mcp.setCredential(selected.id, {
                            token,
                            connectorRevision: selected.revision,
                            expectedRevision: metadata.revision,
                          }),
                        );
                      }}
                    >
                      <label className="flex flex-col gap-2 text-sm">
                        Personal token
                        <Input
                          key={selected.id}
                          name="token"
                          type="password"
                          autoComplete="off"
                          required
                          maxLength={16384}
                          disabled={busy}
                          className={personalFieldClass}
                        />
                      </label>
                      <Button type="submit" disabled={busy}>
                        Save personal token
                      </Button>
                    </form>
                    {metadata.configured && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void perform(() =>
                            client.mcp.revokeCredential(
                              selected.id,
                              metadata.revision,
                            ),
                          )
                        }
                      >
                        Forget personal token
                      </Button>
                    )}
                    {canManage && (
                      <div className="flex flex-wrap gap-3">
                        <Button
                          disabled={
                            busy ||
                            !ready ||
                            !connections.data?.executionSupported
                          }
                          onClick={() =>
                            void perform(() =>
                              client.mcp.configure(projectId, {
                                connectorId: selected.id,
                                connectorRevision: selected.revision,
                                expectedRevision: connection?.revision ?? 0,
                                enabled: true,
                              }),
                            )
                          }
                        >
                          {connection
                            ? "Update and enable"
                            : "Connect to project"}
                        </Button>
                        {connection?.enabled && (
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              void perform(() =>
                                client.mcp.configure(projectId, {
                                  connectorId: selected.id,
                                  connectorRevision: selected.revision,
                                  expectedRevision: connection.revision,
                                  enabled: false,
                                }),
                              )
                            }
                          >
                            Disable connection
                          </Button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            {!canManage && (
              <p className="text-sm text-muted-foreground">
                Only project owners can change project connections. You can
                manage your own personal credential.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
