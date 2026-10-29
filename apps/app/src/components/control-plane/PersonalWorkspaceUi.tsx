import type { ReactNode } from "react";
import { Icon, type BuiltinIconName } from "@bb/shared-ui/icon";
import {
  ResourceStatus,
  type ResourceStatusTone,
} from "@bb/shared-ui/resource-list";

export const personalFieldClass =
  "mt-1.5 block min-h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 max-md:pointer-coarse:text-base";
export const personalCodeClass =
  "max-h-96 overflow-auto rounded-md border border-border bg-surface-recessed px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words";
export const personalPanelClass =
  "space-y-4 rounded-lg border border-border bg-surface-raised p-4 sm:p-5";

export function PersonalPageHeader({
  title,
  description,
  icon,
  actions,
}: {
  title: string;
  description: string;
  icon: BuiltinIconName;
  actions?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-start justify-between gap-4 border-b border-border px-4 py-5 sm:px-6">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-recessed text-muted-foreground">
          <Icon name={icon} className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 space-y-1">
          <h1 className="text-base font-semibold tracking-tight">{title}</h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 [&_button]:pointer-coarse:min-h-10">
          {actions}
        </div>
      )}
    </div>
  );
}

export function PersonalStatus({ status }: { status: string }) {
  const tone: ResourceStatusTone = [
    "succeeded",
    "completed",
    "enabled",
    "ready",
    "idle",
  ].includes(status)
    ? "success"
    : ["failed", "error"].includes(status)
      ? "error"
      : ["running", "active", "starting", "pending", "queued"].includes(status)
        ? "warning"
        : "muted";
  return <ResourceStatus tone={tone}>{status}</ResourceStatus>;
}

export function PersonalEmpty({
  icon,
  children,
}: {
  icon: BuiltinIconName;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-5 py-8 text-center">
      <Icon name={icon} className="size-7 text-subtle-foreground" aria-hidden />
      <div className="max-w-sm text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
    </div>
  );
}
