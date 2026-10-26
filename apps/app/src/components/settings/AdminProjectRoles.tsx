import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { createControlPlaneClient } from "@bb/sdk/browser";
import { Button } from "@bb/shared-ui/button";
import {
  SettingsDetailRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";

type Client = ReturnType<typeof createControlPlaneClient>;
type Role = "runner" | "viewer" | null;

export function AdminProjectRoles({
  client,
  projectId,
}: {
  client: Client;
  projectId: string;
}) {
  const [open, setOpen] = useState(false);
  const [prefix, setPrefix] = useState("");
  const [grantRole, setGrantRole] = useState<"runner" | "viewer">("runner");
  const [operationId, setOperationId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const policy = useQuery({
    queryKey: ["admin", "project-roles", projectId],
    queryFn: ({ signal }) => client.admin.projectRoles.list(projectId, signal),
    enabled: open,
    retry: false,
  });
  const directory = useQuery({
    queryKey: ["admin", "users", prefix],
    queryFn: ({ signal }) =>
      client.admin.users.list({ prefix, limit: 20 }, signal),
    enabled: open && policy.isSuccess,
    retry: false,
  });
  const pendingOperationId =
    operationId ?? policy.data?.pendingOperationId ?? null;
  const operation = useQuery({
    queryKey: [
      "admin",
      "project-role-operation",
      projectId,
      pendingOperationId,
    ],
    queryFn: ({ signal }) => {
      if (!pendingOperationId) throw new Error("No pending operation");
      return client.admin.projectRoles.operation(
        projectId,
        pendingOperationId,
        signal,
      );
    },
    enabled: open && pendingOperationId !== null,
    refetchInterval: (query) =>
      query.state.data?.phase === "complete" ? false : 1000,
    retry: false,
  });
  const refetchPolicy = policy.refetch;
  useEffect(() => {
    if (operation.data?.phase !== "complete") return;
    void refetchPolicy();
  }, [operation.data?.phase, refetchPolicy]);

  const operationActive =
    pendingOperationId !== null && operation.data?.phase !== "complete";

  async function changeRole(userId: string, role: Role) {
    if (!policy.data || operationActive || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await client.admin.projectRoles.set(projectId, userId, {
        role,
        expectedRevision: policy.data.revision,
      });
      if (result.changed && result.phase !== "complete")
        setOperationId(result.operationId);
      await Promise.all([policy.refetch(), directory.refetch()]);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to change access",
      );
      await policy.refetch();
    } finally {
      setSaving(false);
    }
  }

  const busy = saving || operationActive;
  const granted = new Set(
    policy.data?.grants.map((grant) => grant.userId) ?? [],
  );
  return (
    <SettingsSection
      title="Server access"
      description="Roles for registered users on a managed server project."
    >
      {!open ? (
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          Manage server access
        </Button>
      ) : policy.isPending ? (
        <p role="status">Loading project access…</p>
      ) : policy.isError ? (
        <p role="alert">
          Server access is unavailable for this project.{" "}
          <button type="button" onClick={() => void policy.refetch()}>
            Retry
          </button>
        </p>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Policy revision {policy.data.revision}; applied{" "}
            {policy.data.appliedRevision ?? "pending"}.
          </p>
          {operationActive ? (
            <p role="status">
              {operation.isError
                ? "Access update needs attention."
                : `Applying access change: ${operation.data?.phase ?? "pending"}`}
              {operation.isError ? (
                <button type="button" onClick={() => void operation.refetch()}>
                  Retry status
                </button>
              ) : null}
            </p>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
          <SettingsRowList>
            {policy.data.grants.map((grant) => (
              <SettingsDetailRow key={grant.userId} label={grant.login}>
                {grant.role === "owner" ? (
                  <span>Owner</span>
                ) : (
                  <form
                    key={`${grant.userId}:${grant.role}`}
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const selected = new FormData(event.currentTarget).get(
                        "role",
                      );
                      if (
                        selected !== "runner" &&
                        selected !== "viewer" &&
                        selected !== "remove"
                      )
                        return;
                      void changeRole(
                        grant.userId,
                        selected === "remove" ? null : selected,
                      );
                    }}
                  >
                    <select
                      name="role"
                      defaultValue={grant.role}
                      disabled={busy}
                      aria-label={`${grant.login} role`}
                      className="rounded border bg-background p-1 text-sm"
                    >
                      <option value="runner">Runner</option>
                      <option value="viewer">Viewer</option>
                      <option value="remove">Remove access</option>
                    </select>
                    <Button type="submit" size="sm" disabled={busy}>
                      Save
                    </Button>
                  </form>
                )}
              </SettingsDetailRow>
            ))}
          </SettingsRowList>
          <div className="space-y-2">
            <label className="flex flex-col gap-1 text-sm">
              Find registered user
              <input
                value={prefix}
                onChange={(event) => setPrefix(event.target.value)}
                maxLength={100}
                className="rounded border bg-background p-2"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              New role
              <select
                value={grantRole}
                onChange={(event) =>
                  setGrantRole(
                    event.target.value === "viewer" ? "viewer" : "runner",
                  )
                }
                disabled={busy}
                className="rounded border bg-background p-1"
              >
                <option value="runner">Runner</option>
                <option value="viewer">Viewer</option>
              </select>
            </label>
            {directory.isError ? (
              <p role="alert">Unable to search users.</p>
            ) : null}
            {directory.data?.users
              .filter((user) => !granted.has(user.userId))
              .map((user) => (
                <div
                  key={user.userId}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span>{user.login}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      busy ||
                      !user.enabled ||
                      user.environmentStatus !== "ready"
                    }
                    onClick={() => void changeRole(user.userId, grantRole)}
                  >
                    Grant {grantRole}
                  </Button>
                </div>
              ))}
            {directory.data?.nextCursor ? (
              <p className="text-xs text-muted-foreground">
                Showing the first 20 matches. Narrow the login prefix to find
                another user.
              </p>
            ) : null}
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
