import type { PersonalWorkspaceClient } from "./PersonalWorkspace";
import { personalCodeClass } from "./PersonalWorkspaceUi";

type Detail = Awaited<
  ReturnType<PersonalWorkspaceClient["workflows"]["inspectCall"]>
>;
export function PersonalCallDiagnostics({ detail }: { detail: Detail }) {
  return (
    <>
      <section
        aria-label="Retry and error history"
        className="space-y-3 border-t border-border pt-4"
      >
        <h3 className="font-medium">Retry and error history</h3>
        {detail.diagnostics.recordedSince === null ? (
          <p className="text-muted-foreground">
            Complete error history is unavailable for this call. Any recorded
            entries are shown below; counters and worker conversations may still
            be available.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Recorded since{" "}
            {new Date(detail.diagnostics.recordedSince).toLocaleString()}.
            Entries describe this call; cached results link to original work
            separately.
          </p>
        )}
        <ol className="space-y-2">
          {detail.diagnostics.entries.map((entry) => (
            <li
              key={entry.id}
              className="space-y-2 rounded-md border border-border p-3"
            >
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium">
                  {entry.kind === "started"
                    ? "Call admitted"
                    : entry.kind === "provider-retry"
                      ? `Provider retry ${entry.attempt}`
                      : entry.kind === "repair"
                        ? `Output rejection ${entry.attempt}`
                        : "Call failed"}
                </span>
                <time
                  className="text-xs text-muted-foreground"
                  dateTime={new Date(entry.createdAt).toISOString()}
                >
                  {new Date(entry.createdAt).toLocaleString()}
                </time>
              </div>
              {entry.threadId && (
                <p className="break-all text-xs text-muted-foreground">
                  Worker {entry.threadId}
                </p>
              )}
              {entry.message && (
                <pre className={personalCodeClass}>{entry.message}</pre>
              )}
            </li>
          ))}
        </ol>
        {detail.diagnostics.truncated && (
          <p role="status">Only the first 100 diagnostic entries are shown.</p>
        )}
      </section>
      <section
        aria-label="Recorded file changes"
        className="space-y-3 border-t border-border pt-4"
      >
        <h3 className="font-medium">Recorded file changes</h3>
        <p className="text-xs text-muted-foreground">
          Changes reported by native worker events, including failed attempts.
          These are recorded patches or edit-tool results, not the current
          project state or every possible shell write.
        </p>
        {detail.fileArtifacts.entries.length === 0 && (
          <p className="text-muted-foreground">
            No readable file-change events are available for this call.
          </p>
        )}
        {detail.fileArtifacts.entries.map((entry, index) => (
          <details
            key={`${entry.eventId}:${index}`}
            className="min-w-0 rounded-md border border-border p-3"
          >
            <summary className="cursor-pointer break-all font-medium">
              {entry.kind} · {entry.path}
            </summary>
            <div className="mt-3 space-y-2">
              <p className="break-all text-xs text-muted-foreground">
                {entry.status} · {new Date(entry.createdAt).toLocaleString()} ·{" "}
                {entry.threadId} · event {entry.sequence}
              </p>
              {entry.movePath && (
                <p className="break-all">Moved to {entry.movePath}</p>
              )}
              {entry.diff === null ? (
                <p>No patch was retained for this event.</p>
              ) : (
                <pre className={personalCodeClass}>{entry.diff}</pre>
              )}
              {entry.output !== null && (
                <pre className={personalCodeClass}>{entry.output}</pre>
              )}
              {entry.outputTruncated && (
                <p role="status">This edit-tool result is truncated.</p>
              )}
              {entry.diffTruncated && (
                <p role="status">This patch is truncated.</p>
              )}
            </div>
          </details>
        ))}
        {detail.fileArtifacts.truncated && (
          <p role="status">
            Some file-change events were omitted by the display limits or could
            not be read.
          </p>
        )}
        {detail.fileArtifacts.unavailableWorkers > 0 && (
          <p role="status">
            Some worker artifacts are unavailable or cannot be matched to this
            call.
          </p>
        )}
      </section>
    </>
  );
}
