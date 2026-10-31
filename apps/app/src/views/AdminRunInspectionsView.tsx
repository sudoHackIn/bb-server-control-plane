import { useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { createControlPlaneClient } from "@bb/sdk/browser";
import { RunInspections } from "@/components/control-plane/RunInspections";
export function AdminRunInspectionsView() {
  const { projectId } = useParams();
  const client = useMemo(
    () => createControlPlaneClient({ origin: window.location.origin }),
    [],
  );
  if (!projectId) return <p role="alert">Project is unavailable.</p>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Link
        to={`/settings/projects/${encodeURIComponent(projectId)}`}
        className="border-b border-border px-6 py-3 text-sm underline underline-offset-4"
      >
        Back to project settings
      </Link>
      <RunInspections
        key={projectId}
        client={client.admin.inspections}
        testClient={client.admin.testRuns}
        administrator
        projectId={projectId}
      />
    </div>
  );
}
