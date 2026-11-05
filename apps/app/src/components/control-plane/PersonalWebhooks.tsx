import { useId, useState } from "react";
import { Link } from "react-router-dom";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import type { PersonalWorkspaceClient } from "./PersonalWorkspace";
import {
  PersonalPageHeader,
  PersonalEmpty,
  PersonalStatus,
  personalFieldClass,
  personalPanelClass,
} from "./PersonalWorkspaceUi";
export function PersonalWebhooks({
  client,
  projectId,
  canCreate,
}: {
  client: PersonalWorkspaceClient;
  projectId: string;
  canCreate: boolean;
}) {
  const cache = useQueryClient();
  const agentFieldId = useId();
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [field, setField] = useState("input");
  const [selected, setSelected] = useState<string | null>(null);
  const [credential, setCredential] = useState<{
    id: string;
    secret: string;
    path: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const hooks = useInfiniteQuery({
    queryKey: ["personal", "webhooks", projectId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      client.webhooks.list({
        projectId,
        cursor: pageParam ?? undefined,
        signal,
      }),
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: 10000,
  });
  const catalog = useInfiniteQuery({
    queryKey: ["personal", "agents"],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      client.profiles.list({ cursor: pageParam ?? undefined, signal }),
    getNextPageParam: (page) => page.nextCursor,
  });
  const history = useInfiniteQuery({
    queryKey: ["personal", "webhook-deliveries", selected],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      if (!selected) throw new Error("Select a webhook");
      return client.webhooks.history(selected, {
        cursor: pageParam ?? undefined,
        signal,
      });
    },
    getNextPageParam: (page) => page.nextCursor,
    enabled: selected !== null,
    refetchInterval: 3000,
  });
  const refresh = () =>
    cache.invalidateQueries({ queryKey: ["personal", "webhooks", projectId] });
  const create = useMutation({
    mutationFn: () =>
      client.webhooks.create({
        projectId,
        profileVersionId: version,
        name,
        inputField: field,
      }),
    onSuccess: (result) => {
      setCredential({
        id: result.webhook.id,
        secret: result.secret,
        path: result.webhook.deliveryPath,
      });
      setCopied(false);
      setSelected(result.webhook.id);
      setName("");
      void refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      client.webhooks.setEnabled(id, enabled),
    onSuccess: () => void refresh(),
  });
  const rotate = useMutation({
    mutationFn: (id: string) => client.webhooks.rotate(id),
    onSuccess: (result) => {
      setCredential({
        id: result.webhook.id,
        secret: result.secret,
        path: result.webhook.deliveryPath,
      });
      setCopied(false);
      void refresh();
    },
  });
  const rows = hooks.isError
    ? []
    : (hooks.data?.pages.flatMap((page) => page.webhooks) ?? []);
  const current = rows.find((row) => row.id === selected);
  return (
    <section
      aria-label="Webhook triggers"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <PersonalPageHeader
        title="Webhooks"
        icon="Zap"
        description="Start an approved agent when an external service sends an event to your project."
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
            <h2 className="text-sm font-semibold">New trigger</h2>
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
              <label htmlFor={agentFieldId}>Agent</label>
              <select
                id={agentFieldId}
                className={personalFieldClass}
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                required
                disabled={!canCreate || catalog.isError}
              >
                <option value="">Choose an agent</option>
                {!catalog.isError &&
                  catalog.data?.pages
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
            {catalog.hasNextPage && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => void catalog.fetchNextPage()}
              >
                More agents
              </Button>
            )}
            {catalog.isError && (
              <p role="alert" className="text-sm text-destructive">
                Agent catalog unavailable.
              </p>
            )}
            <label className="block text-sm">
              Text field
              <input
                className={personalFieldClass}
                value={field}
                onChange={(event) => setField(event.target.value)}
                pattern="[A-Za-z][A-Za-z0-9_]*"
                maxLength={100}
                required
                disabled={!canCreate}
              />
            </label>
            <p className="text-sm text-muted-foreground">
              The selected top-level JSON field becomes the agent task. The
              project, owner and published version are fixed by this trigger.
            </p>
            <Button
              type="submit"
              disabled={
                !canCreate || !version || !name.trim() || create.isPending
              }
            >
              {create.isPending ? "Creating…" : "Create webhook"}
            </Button>
            {create.isError && (
              <p role="alert" className="text-sm text-destructive">
                Could not create the trigger. Check project and agent access.
              </p>
            )}
          </form>
          {credential && (
            <div className={personalPanelClass} role="status">
              <h2 className="text-sm font-semibold">
                Save your webhook secret
              </h2>
              <p className="text-sm text-muted-foreground">
                Shown once. Send it in the Authorization: Bearer header. Include
                a stable X-BB-Delivery-ID for each event.
              </p>
              <label className="block text-sm">
                Webhook URL
                <input
                  className={personalFieldClass}
                  readOnly
                  value={new URL(credential.path, window.location.origin).href}
                />
              </label>
              <label className="block text-sm">
                Secret
                <input
                  className={personalFieldClass}
                  type="password"
                  readOnly
                  value={credential.secret}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard.writeText(credential.secret).then(
                      () => setCopied(true),
                      () => setCopied(false),
                    );
                  }}
                >
                  {copied ? "Copied" : "Copy secret"}
                </Button>
                <Button variant="ghost" onClick={() => setCredential(null)}>
                  Dismiss secret
                </Button>
              </div>
            </div>
          )}
          <div className="overflow-hidden rounded-lg border border-border">
            <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">
              Project triggers
            </h2>
            {hooks.isError ? (
              <p role="alert" className="p-4 text-sm text-destructive">
                Triggers unavailable.
              </p>
            ) : hooks.isPending ? (
              <p role="status" className="p-4 text-sm">
                Loading triggers…
              </p>
            ) : rows.length === 0 ? (
              <PersonalEmpty icon="Zap">No webhook triggers yet.</PersonalEmpty>
            ) : (
              rows.map((row) => (
                <button
                  type="button"
                  key={row.id}
                  aria-pressed={selected === row.id}
                  className="flex min-h-14 w-full items-center justify-between gap-3 border-b border-border px-4 py-3 text-left text-sm last:border-0 hover:bg-accent aria-pressed:bg-accent"
                  onClick={() => setSelected(row.id)}
                >
                  <span className="min-w-0 break-words font-medium">
                    {row.name}
                  </span>
                  <PersonalStatus
                    status={row.enabled ? "enabled" : "disabled"}
                  />
                </button>
              ))
            )}
            {hooks.hasNextPage && (
              <Button
                variant="ghost"
                disabled={hooks.isFetchingNextPage}
                onClick={() => void hooks.fetchNextPage()}
              >
                More triggers
              </Button>
            )}
          </div>
        </div>
        <div className="min-w-0 space-y-4">
          {!current ? (
            <PersonalEmpty icon="Zap">
              Select a trigger to see delivery history.
            </PersonalEmpty>
          ) : (
            <>
              <div className={personalPanelClass}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold break-words">
                    {current.name}
                  </h2>
                  <PersonalStatus
                    status={current.enabled ? "enabled" : "disabled"}
                  />
                </div>
                <label className="block text-sm">
                  Delivery URL
                  <input
                    className={personalFieldClass}
                    readOnly
                    value={
                      new URL(current.deliveryPath, window.location.origin).href
                    }
                  />
                </label>
                <p className="text-sm text-muted-foreground">
                  Task field: <code>{current.inputField}</code>. Disabling
                  prevents future deliveries; existing runs continue.
                </p>
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
                    {current.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={rotate.isPending}
                    onClick={() => rotate.mutate(current.id)}
                  >
                    Rotate secret
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Rotating immediately invalidates the previous secret.
                </p>
                {(update.isError || rotate.isError) && (
                  <p role="alert" className="text-sm text-destructive">
                    Change failed. Check your access and try again.
                  </p>
                )}
              </div>
              <div className="rounded-lg border border-border">
                <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">
                  Deliveries
                </h2>
                {history.isError ? (
                  <p role="alert" className="p-4 text-sm text-destructive">
                    Delivery history unavailable.
                  </p>
                ) : history.isPending ? (
                  <p role="status" className="p-4 text-sm">
                    Loading deliveries…
                  </p>
                ) : history.data?.pages.every(
                    (page) => page.deliveries.length === 0,
                  ) ? (
                  <PersonalEmpty icon="Zap">
                    Waiting for the first event.
                  </PersonalEmpty>
                ) : (
                  history.data?.pages
                    .flatMap((page) => page.deliveries)
                    .map((delivery) => (
                      <div
                        key={delivery.id}
                        className="space-y-2 border-b border-border p-4 text-sm last:border-0"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="min-w-0 break-all font-mono text-xs">
                            {delivery.deliveryKey}
                          </span>
                          <PersonalStatus status={delivery.state} />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {new Date(delivery.createdAt).toLocaleString()}
                        </p>
                        {delivery.error && (
                          <p className="text-destructive">
                            {delivery.error === "invalid_webhook_input"
                              ? "The selected field must contain task text."
                              : "Launch unavailable. Check permissions and resend the same event ID."}
                          </p>
                        )}
                        {delivery.runId && (
                          <Link
                            className="font-medium text-primary underline underline-offset-4"
                            to={`/projects/${encodeURIComponent(projectId)}?view=inspections&inspectKind=${delivery.runId.startsWith("wfa_") ? "workflow" : "thread"}&inspectRun=${encodeURIComponent(delivery.runId)}`}
                          >
                            Open run
                          </Link>
                        )}
                      </div>
                    ))
                )}
                {history.hasNextPage && (
                  <Button
                    variant="ghost"
                    onClick={() => void history.fetchNextPage()}
                  >
                    More deliveries
                  </Button>
                )}
                <p className="border-t border-border p-4 text-xs text-muted-foreground">
                  Accepted means the run was created. Open it to see execution
                  status and results. Repeated event IDs reuse the same run.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
