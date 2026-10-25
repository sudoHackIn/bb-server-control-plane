import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import type { PersonalWorkspaceClient } from "./PersonalWorkspace";

export function PersonalAutomationOutput({
  client,
  projectId,
  automationId,
  runId,
}: {
  client: PersonalWorkspaceClient;
  projectId: string;
  automationId: string;
  runId: string;
}) {
  const [open, setOpen] = useState(false);
  const output = useQuery({
    queryKey: [
      "personal",
      "automation",
      projectId,
      automationId,
      "output",
      runId,
    ],
    queryFn: async ({ signal }) => {
      const value = await client.automations.output(
        automationId,
        runId,
        signal,
      );
      if (value.automationId !== automationId || value.runId !== runId)
        throw new Error("Script result identity mismatch");
      return value;
    },
    enabled: open,
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 5000 : false,
  });
  return (
    <div className="space-y-2">
      <Button variant="ghost" onClick={() => setOpen(!open)}>
        {open ? "Hide" : "Show"} script output {runId}
      </Button>
      {open &&
        (output.isError ? (
          <p role="alert">Script output unavailable. Check access and retry.</p>
        ) : output.data ? (
          <section aria-label={`Script output ${runId}`} className="space-y-2">
            <p>
              {output.data.status}
              {output.data.cleanupPending ? " · cleanup pending" : ""}
            </p>
            {output.data.error && <p>{output.data.error}</p>}
            {output.data.result ? (
              <>
                <p>
                  {output.data.result.status} · exit{" "}
                  {output.data.result.exitCode ??
                    output.data.result.signal ??
                    "none"}{" "}
                  · {output.data.result.outputBytes} bytes
                  {output.data.result.truncated ? " · truncated" : ""}
                </p>
                <h4>Stdout</h4>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">
                  {output.data.result.stdout}
                </pre>
                <h4>Stderr</h4>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">
                  {output.data.result.stderr}
                </pre>
              </>
            ) : (
              <p>No completed process result.</p>
            )}
          </section>
        ) : (
          <p role="status">Loading script output…</p>
        ))}
    </div>
  );
}
