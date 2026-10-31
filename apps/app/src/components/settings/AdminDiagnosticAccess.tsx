import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import { SettingsSection } from "@/components/ui/settings-section";
import { personalFieldClass } from "@/components/control-plane/PersonalWorkspaceUi";
import type { PersonalWorkspaceClient } from "@/components/control-plane/PersonalWorkspace";

export function AdminDiagnosticAccess({
  client,
  projectId,
}: {
  client: PersonalWorkspaceClient;
  projectId: string;
}) {
  const [open, setOpen] = useState(false),
    [prefix, setPrefix] = useState(""),
    [userId, setUserId] = useState(""),
    [role, setRole] = useState<"reviewer" | "developer" | "none">("reviewer"),
    [saving, setSaving] = useState(false),
    [error, setError] = useState<string | null>(null);
  const directory = useQuery({
    queryKey: ["admin", "diagnostic-users", prefix],
    queryFn: ({ signal }) =>
      client.admin.users.list({ prefix, limit: 20 }, signal),
    enabled: open,
    retry: false,
  });
  const current = useQuery({
    queryKey: ["admin", "diagnostic-grant", projectId, userId],
    queryFn: ({ signal }) =>
      client.admin.diagnosticGrants.get(projectId, userId, signal),
    enabled: open && userId !== "",
    retry: false,
  });
  async function save() {
    if (!current.data || saving) return;
    setSaving(true);
    setError(null);
    try {
      await client.admin.diagnosticGrants.set(projectId, userId, {
        role: role === "none" ? null : role,
        expectedRevision: current.data.grant?.revision ?? 0,
      });
      await current.refetch();
    } catch {
      setError(
        "Diagnostic access could not be saved. Reload the grant before retrying.",
      );
      await current.refetch();
    } finally {
      setSaving(false);
    }
  }
  return (
    <SettingsSection
      title="Server run diagnostics"
      description="Diagnostic access is separate from project roles and permission to invoke an agent."
    >
      <div className="space-y-3">
        <Link
          className="inline-flex min-h-10 items-center underline underline-offset-4"
          to={`/settings/projects/${encodeURIComponent(projectId)}/inspections`}
        >
          Inspect all project runs as administrator
        </Link>
        <p className="text-sm text-muted-foreground">
          Developer and reviewer grants permit read-only inspection of project
          runs and worker conversations. Current project read access is also
          required.
        </p>
        <Button
          variant="outline"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          Manage diagnostic grants
        </Button>
        {open && (
          <div className="space-y-3">
            <label className="block">
              Find user
              <input
                className={personalFieldClass}
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
              />
            </label>
            {directory.isError && (
              <p role="alert">User directory is unavailable.</p>
            )}
            <label className="block">
              Diagnostic user
              <select
                className={personalFieldClass}
                aria-label="Diagnostic user"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
              >
                <option value="">Select user</option>
                {directory.data?.users.map((user) => (
                  <option key={user.userId} value={user.userId}>
                    {user.login}
                    {user.enabled ? "" : " · disabled"}
                  </option>
                ))}
              </select>
            </label>
            {current.isError && <p role="alert">This grant is unavailable.</p>}
            {current.data && (
              <p role="status">
                Current access: {current.data.grant?.role ?? "none"} · revision{" "}
                {current.data.grant?.revision ?? 0}
              </p>
            )}
            <label className="block">
              Diagnostic role
              <select
                className={personalFieldClass}
                aria-label="Diagnostic role"
                value={role}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "reviewer" || v === "developer" || v === "none")
                    setRole(v);
                }}
              >
                <option value="reviewer">Reviewer</option>
                <option value="developer">Developer</option>
                <option value="none">Revoke</option>
              </select>
            </label>
            <Button
              disabled={saving || !current.data || current.isError}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save diagnostic access"}
            </Button>
            {error && <p role="alert">{error}</p>}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
