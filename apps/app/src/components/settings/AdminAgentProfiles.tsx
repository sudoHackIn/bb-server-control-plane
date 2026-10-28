import { useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createControlPlaneClient } from "@bb/sdk/browser";
import {
  controlPlaneProfileCreateSchema,
  controlPlaneProfilePublicationSchema,
  type ControlPlaneProfileDefinition,
} from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { SettingsSection } from "@/components/ui/settings-section";

type Client = ReturnType<typeof createControlPlaneClient>;
type AgentDraft = {
  slug: string;
  name: string;
  purpose: string;
  prompt: string;
  model: string;
  reasoningLevel: string;
  permissionMode: ControlPlaneProfileDefinition["permissionMode"];
  tools: string;
  mcpServers: string;
};

const emptyDraft: AgentDraft = {
  slug: "",
  name: "",
  purpose: "",
  prompt: "",
  model: "",
  reasoningLevel: "medium",
  permissionMode: "accept-edits",
  tools: "",
  mcpServers: "",
};

function identifiers(value: string): string[] {
  return value
    .split(/[\s,]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function definition(draft: AgentDraft): ControlPlaneProfileDefinition {
  return controlPlaneProfilePublicationSchema.parse({
    purpose: draft.purpose,
    prompt: draft.prompt,
    providerId: "qwen-server",
    model: draft.model,
    reasoningLevel: draft.reasoningLevel,
    permissionMode: draft.permissionMode,
    tools: identifiers(draft.tools),
    mcpServers: identifiers(draft.mcpServers),
  });
}

export function AdminAgentProfiles({ client }: { client: Client }) {
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftForId, setDraftForId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft);
  const [userPrefix, setUserPrefix] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const catalogKey = ["admin", "agent-profiles"];
  const catalog = useInfiniteQuery({
    queryKey: catalogKey,
    initialPageParam: null,
    queryFn: ({
      pageParam,
      signal,
    }: {
      pageParam: string | null;
      signal: AbortSignal;
    }) =>
      client.admin.profiles.list({ cursor: pageParam ?? undefined, signal }),
    getNextPageParam: (page) => page.nextCursor,
    enabled: open,
  });
  const agents = catalog.isError
    ? []
    : (catalog.data?.pages.flatMap((page) => page.profiles) ?? []);
  const selected = agents.find((agent) => agent.id === selectedId);
  const detailKey = ["admin", "agent-profile", selected?.id];
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) => {
      if (!selected) throw new Error("No agent selected");
      return client.admin.profiles.get(selected.id, { signal });
    },
    enabled: open && selected !== undefined,
  });
  const access = useInfiniteQuery({
    queryKey: ["admin", "agent-access", selected?.id],
    initialPageParam: null,
    queryFn: ({
      pageParam,
      signal,
    }: {
      pageParam: string | null;
      signal: AbortSignal;
    }) => {
      if (!selected) throw new Error("No agent selected");
      return client.admin.profiles.access(selected.id, {
        cursor: pageParam ?? undefined,
        signal,
      });
    },
    getNextPageParam: (page) => page.nextCursor,
    enabled: open && selected !== undefined,
  });
  const users = useQuery({
    queryKey: ["admin", "agent-users", userPrefix],
    queryFn: ({ signal }) =>
      client.admin.users.list({ prefix: userPrefix, limit: 20 }, signal),
    enabled: open && selected !== undefined,
  });
  const granted = new Set(
    access.data?.pages.flatMap((page) =>
      page.users.map((user) => user.userId),
    ) ?? [],
  );
  async function change(action: () => Promise<unknown>, message: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await Promise.all([
        cache.invalidateQueries({ queryKey: catalogKey }),
        cache.invalidateQueries({ queryKey: detailKey }),
        cache.invalidateQueries({ queryKey: ["admin", "agent-access"] }),
      ]);
      setNotice(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent action failed");
    } finally {
      setBusy(false);
    }
  }
  const current =
    !detail.isError && detail.data?.profile.id === selected?.id
      ? detail.data
      : undefined;
  return (
    <SettingsSection
      title="Server agents"
      description="Publish approved Qwen agent versions and grant access to registered users."
    >
      {!open ? (
        <Button variant="outline" onClick={() => setOpen(true)}>
          Manage server agents
        </Button>
      ) : catalog.isError ? (
        <p role="alert">
          Agent management is unavailable.{" "}
          <Button onClick={() => void catalog.refetch()}>Retry</Button>
        </p>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-2">
            {agents.map((agent) => (
              <Button
                key={agent.id}
                variant={selectedId === agent.id ? "secondary" : "ghost"}
                aria-pressed={selectedId === agent.id}
                onClick={() => {
                  setSelectedId(agent.id);
                  setDraftForId(null);
                  setDraft(emptyDraft);
                  setError(null);
                  setNotice(null);
                }}
              >
                {agent.name} · v{agent.latestVersion}
              </Button>
            ))}
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
          {current && (
            <div className="space-y-3 rounded-lg border p-4">
              <h3 className="text-base font-medium">{current.profile.name}</h3>
              <p className="text-sm text-muted-foreground">
                {current.profile.slug} · version {current.version.version} ·{" "}
                {current.version.definition.model}
              </p>
              <p className="text-sm">
                {current.version.definition.purpose ??
                  "No purpose was recorded for this version."}
              </p>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Reasoning</dt>
                  <dd>{current.version.definition.reasoningLevel}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Permissions</dt>
                  <dd>{current.version.definition.permissionMode}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Native and BB tools</dt>
                  <dd>
                    {current.version.definition.tools.join(", ") || "None"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">MCP sources</dt>
                  <dd>
                    {current.version.definition.mcpServers.join(", ") || "None"}
                  </dd>
                </div>
              </dl>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    const source = current.version.definition;
                    setDraft({
                      slug: current.profile.slug,
                      name: current.profile.name,
                      purpose: source.purpose ?? "",
                      prompt: source.prompt,
                      model: source.model,
                      reasoningLevel: source.reasoningLevel,
                      permissionMode: source.permissionMode,
                      tools: source.tools.join(", "),
                      mcpServers: source.mcpServers.join(", "),
                    });
                    setDraftForId(current.profile.id);
                  }}
                >
                  Edit next version
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void change(
                      () =>
                        client.admin.profiles.setEnabled(
                          current.profile.id,
                          !current.profile.enabled,
                        ),
                      current.profile.enabled
                        ? "Agent disabled"
                        : "Agent enabled",
                    )
                  }
                >
                  {current.profile.enabled ? "Disable agent" : "Enable agent"}
                </Button>
              </div>
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Access</h4>
                {access.isError && <p role="alert">Unable to load grants.</p>}
                {access.data?.pages
                  .flatMap((page) => page.users)
                  .map((user) => (
                    <div
                      key={user.userId}
                      className="flex items-center gap-2 text-sm"
                    >
                      <span>{user.login}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void change(
                            () =>
                              client.admin.profiles.setAccess(
                                current.profile.id,
                                user.userId,
                                false,
                              ),
                            `Access removed for ${user.login}`,
                          )
                        }
                      >
                        Revoke
                      </Button>
                    </div>
                  ))}
                {access.hasNextPage && (
                  <Button
                    variant="ghost"
                    disabled={access.isFetchingNextPage}
                    onClick={() => void access.fetchNextPage()}
                  >
                    More grants
                  </Button>
                )}
                <label className="flex max-w-sm flex-col gap-1 text-sm">
                  Find registered user
                  <input
                    value={userPrefix}
                    onChange={(event) => setUserPrefix(event.target.value)}
                    className="rounded border bg-background p-2"
                  />
                </label>
                {users.isError && <p role="alert">Unable to search users.</p>}
                {users.data?.users
                  .filter((user) => !granted.has(user.userId))
                  .map((user) => (
                    <div
                      key={user.userId}
                      className="flex items-center gap-2 text-sm"
                    >
                      <span>{user.login}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || !user.enabled}
                        onClick={() =>
                          void change(
                            () =>
                              client.admin.profiles.setAccess(
                                current.profile.id,
                                user.userId,
                                true,
                              ),
                            `Access granted to ${user.login}`,
                          )
                        }
                      >
                        Grant
                      </Button>
                    </div>
                  ))}
              </div>
            </div>
          )}
          <form
            aria-label="Agent editor"
            className="space-y-3 rounded-lg border p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void change(
                async () => {
                  if (selectedId && current) {
                    await client.admin.profiles.publish(
                      selectedId,
                      definition(draft),
                    );
                  } else {
                    const created = await client.admin.profiles.create(
                      controlPlaneProfileCreateSchema.parse({
                        slug: draft.slug,
                        name: draft.name,
                        definition: definition(draft),
                      }),
                    );
                    setSelectedId(created.profile.id);
                  }
                },
                selectedId ? "New version published" : "Agent created",
              );
            }}
          >
            <h3 className="text-base font-medium">
              {selectedId ? "Publish a version" : "Create an agent"}
            </h3>
            {selectedId && draftForId !== selectedId && (
              <p className="text-sm text-muted-foreground">
                Select Edit next version above to load this agent's settings.
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                Slug
                <input
                  value={draft.slug}
                  onChange={(event) =>
                    setDraft({ ...draft, slug: event.target.value })
                  }
                  disabled={selectedId !== null}
                  className="rounded border bg-background p-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Name
                <input
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                  disabled={selectedId !== null}
                  className="rounded border bg-background p-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                Purpose
                <textarea
                  aria-label="Purpose"
                  value={draft.purpose}
                  onChange={(event) =>
                    setDraft({ ...draft, purpose: event.target.value })
                  }
                  maxLength={280}
                  rows={2}
                  required
                  className="rounded border bg-background p-2"
                />
                <span className="text-xs text-muted-foreground">
                  One sentence explaining when to choose this agent.
                </span>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Model
                <input
                  value={draft.model}
                  onChange={(event) =>
                    setDraft({ ...draft, model: event.target.value })
                  }
                  className="rounded border bg-background p-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Reasoning level
                <select
                  value={draft.reasoningLevel}
                  onChange={(event) =>
                    setDraft({ ...draft, reasoningLevel: event.target.value })
                  }
                  className="rounded border bg-background p-2"
                >
                  {["none", "low", "medium", "high", "xhigh", "max"].map(
                    (level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Permissions
                <select
                  value={draft.permissionMode}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      permissionMode:
                        event.target.value === "full"
                          ? "full"
                          : event.target.value === "auto"
                            ? "auto"
                            : "accept-edits",
                    })
                  }
                  className="rounded border bg-background p-2"
                >
                  <option value="accept-edits">Accept edits</option>
                  <option value="auto">Auto</option>
                  <option value="full">Full</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Tools, comma separated
                <input
                  value={draft.tools}
                  onChange={(event) =>
                    setDraft({ ...draft, tools: event.target.value })
                  }
                  className="rounded border bg-background p-2"
                />
                <span className="text-xs text-muted-foreground">
                  Exact Qwen tool names or approved bb:/mcp: selectors.
                </span>
              </label>
              <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                MCP sources, comma separated
                <input
                  value={draft.mcpServers}
                  onChange={(event) =>
                    setDraft({ ...draft, mcpServers: event.target.value })
                  }
                  className="rounded border bg-background p-2"
                />
                <span className="text-xs text-muted-foreground">
                  Supported sources: bb, project.
                </span>
              </label>
              <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                Agent instructions
                <textarea
                  value={draft.prompt}
                  onChange={(event) =>
                    setDraft({ ...draft, prompt: event.target.value })
                  }
                  rows={8}
                  className="rounded border bg-background p-2"
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                disabled={
                  busy ||
                  !draft.model.trim() ||
                  !draft.purpose.trim() ||
                  (selectedId !== null && draftForId !== selectedId)
                }
              >
                {selectedId ? "Publish version" : "Create agent"}
              </Button>
              {selectedId && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setSelectedId(null);
                    setDraftForId(null);
                    setDraft(emptyDraft);
                  }}
                >
                  New agent
                </Button>
              )}
            </div>
          </form>
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
        </div>
      )}
    </SettingsSection>
  );
}
