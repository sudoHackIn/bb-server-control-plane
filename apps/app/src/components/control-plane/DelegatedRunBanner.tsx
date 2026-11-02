import type { ControlPlaneDelegation } from "@bb/domain";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { PersonalStatus } from "./PersonalWorkspaceUi";

export function DelegatedRunBanner({
  value,
  projectId,
}: {
  value: ControlPlaneDelegation;
  projectId?: string;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const active = ["pending", "running"].includes(value.state);
  function openParent() {
    if (!value.parent) return;
    const query = new URLSearchParams(location.search);
    for (const key of ["inspectCall", "inspectThread", "testRun"])
      query.delete(key);
    query.set("inspectKind", value.parent.kind);
    query.set("inspectRun", value.parent.id);
    if (projectId) query.set("view", "inspections");
    navigate({
      ...(projectId
        ? { pathname: `/projects/${encodeURIComponent(projectId)}` }
        : {}),
      search: `?${query}`,
    });
  }
  return (
    <aside
      aria-label="Delegated run"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3"
    >
      <div className="min-w-0 space-y-1 text-sm">
        <div className="flex flex-wrap items-center gap-2 font-medium">
          <Icon name="GitBranch" aria-hidden />
          <span>
            {active ? "Parent-controlled agent" : "Closed delegated run"}
          </span>
          <PersonalStatus
            status={value.state === "pending" ? "queued" : value.state}
          />
        </div>
        <p className="text-muted-foreground">
          {value.cleanupPending
            ? "Execution is fenced. Child cleanup is pending."
            : active
              ? "Execution is controlled by its parent. This inspection is read-only."
              : "Recorded result is read-only. Use the parent to start new work."}
        </p>
      </div>
      {value.parent && (
        <Button variant="outline" onClick={openParent}>
          <Icon name="ChevronLeft" aria-hidden />
          Inspect parent
        </Button>
      )}
    </aside>
  );
}
