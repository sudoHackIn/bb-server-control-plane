import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import { personalCodeClass, personalFieldClass } from "./PersonalWorkspaceUi";
import type { PersonalWorkspaceClient } from "./PersonalWorkspace";

export function RunTestForm({
  client,
  sourceRunId,
  administrator = false,
}: {
  client: PersonalWorkspaceClient["testRuns"];
  sourceRunId: string;
  administrator?: boolean;
}) {
  const location = useLocation(),
    navigate = useNavigate();
  const [open, setOpen] = useState(false),
    [kind, setKind] = useState<"published" | "draft">("published"),
    [project, setProject] = useState(""),
    [profile, setProfile] = useState(""),
    [user, setUser] = useState(""),
    [definition, setDefinition] = useState(""),
    [revision, setRevision] = useState("1"),
    [key, setKey] = useState(() => crypto.randomUUID()),
    [pending, setPending] = useState(false),
    [error, setError] = useState(false);
  const testId = new URLSearchParams(location.search).get("testRun");
  const record = useQuery({
    queryKey: ["personal", "test-run", sourceRunId, testId],
    queryFn: ({ signal }) =>
      testId
        ? client.get(testId, signal)
        : client.find(sourceRunId, signal).then((value) => value.testRun),
    enabled: true,
    retry: false,
  });
  const provenance =
    record.data?.runId === sourceRunId ? record.data : undefined;
  function path(projectId: string, runId: string) {
    return administrator
      ? `/settings/projects/${encodeURIComponent(projectId)}/inspections?inspectKind=workflow&inspectRun=${encodeURIComponent(runId)}`
      : `/projects/${encodeURIComponent(projectId)}?view=inspections&inspectKind=workflow&inspectRun=${encodeURIComponent(runId)}`;
  }
  async function submit() {
    if (pending) return;
    setPending(true);
    setError(false);
    try {
      const target =
        kind === "published"
          ? { kind, profileVersionId: profile }
          : {
              kind,
              profileVersionId: profile,
              definitionId: definition,
              revision: Number(revision),
            };
      const result = await client.start({
        sourceRunId,
        projectId: project,
        target,
        idempotencyKey: key,
        ...(administrator ? { executionUserId: user } : {}),
      });
      navigate(
        `${path(result.projectId, result.runId)}&testRun=${encodeURIComponent(result.id)}`,
      );
      setOpen(false);
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <section
      aria-label="Test preparation"
      className="max-h-[60vh] shrink-0 space-y-3 overflow-y-auto border-b border-border p-4"
    >
      {provenance && (
        <div className="space-y-1 text-sm">
          <p>
            Separate test · {provenance.target.kind} ·{" "}
            {provenance.state === "started" ? "admitted" : "admission pending"}
          </p>
          <p className="break-all">
            Profile version: {provenance.target.profileVersionId}
          </p>
          {provenance.target.kind === "draft" && (
            <p className="break-all">
              Draft: {provenance.target.definitionId} · revision{" "}
              {provenance.target.revision}
            </p>
          )}
          <details>
            <summary>Tested profile configuration</summary>
            <pre className={personalCodeClass}>
              {JSON.stringify(provenance.profile, null, 2)}
            </pre>
          </details>
          <p className="break-all">
            Tested source: {provenance.testedSourceHash}
          </p>
          <Button
            variant="ghost"
            onClick={() =>
              navigate(path(provenance.sourceProjectId, provenance.sourceRunId))
            }
          >
            Open source run
          </Button>
        </div>
      )}
      {record.isError && (
        <p role="alert">
          Test provenance is unavailable with your current access.
        </p>
      )}
      <Button
        variant="outline"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Prepare separate test
      </Button>
      {open && (
        <form
          aria-label="Separate test run"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          onChange={() => setKey(crypto.randomUUID())}
        >
          <p className="text-sm text-muted-foreground">
            Uses the captured workflow input in an explicitly selected project.
            Execution requires that user's current project and profile
            permissions. The original run is retained.
          </p>
          <fieldset disabled={pending} className="grid gap-3 sm:grid-cols-2">
            {administrator && (
              <label className="block text-sm">
                Execution user UUID
                <input
                  aria-label="Execution user UUID"
                  className={personalFieldClass}
                  required
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                />
              </label>
            )}
            <label className="block text-sm">
              Test project ID
              <input
                aria-label="Test project ID"
                className={personalFieldClass}
                required
                value={project}
                onChange={(e) => setProject(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              Profile version UUID
              <input
                aria-label="Profile version UUID"
                className={personalFieldClass}
                required
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              Test configuration
              <select
                aria-label="Test configuration"
                className={personalFieldClass}
                value={kind}
                onChange={(e) =>
                  setKind(e.target.value === "draft" ? "draft" : "published")
                }
              >
                <option value="published">Published workflow agent</option>
                <option value="draft">Saved draft workflow revision</option>
              </select>
            </label>
            {kind === "draft" && (
              <>
                <label className="block text-sm">
                  Draft workflow definition ID
                  <input
                    aria-label="Draft workflow definition ID"
                    className={personalFieldClass}
                    required
                    value={definition}
                    onChange={(e) => setDefinition(e.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  Draft revision
                  <input
                    aria-label="Draft revision"
                    className={personalFieldClass}
                    required
                    type="number"
                    min="1"
                    value={revision}
                    onChange={(e) => setRevision(e.target.value)}
                  />
                </label>
              </>
            )}
          </fieldset>
          {kind === "draft" && (
            <p className="text-sm text-muted-foreground">
              Use an ordinary worker profile with a saved revision from advanced
              workflow authoring. Source editing stays in that authoring screen.
            </p>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Starting test…" : "Start separate test"}
          </Button>
          {error && (
            <p role="alert">
              Test could not start. Check source access, target permissions, IDs
              and revision. Retry retains the same request key until the
              configuration changes.
            </p>
          )}
        </form>
      )}
    </section>
  );
}
