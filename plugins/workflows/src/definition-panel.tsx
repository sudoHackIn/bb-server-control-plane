import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import type { z } from "zod";
import type {
  definitionSchema,
  definitionSummarySchema,
} from "./definitions.js";
import type { workflowDefinitionRpcContract } from "./definition-api.js";

type Definition = z.infer<typeof definitionSchema>;
type Summary = z.infer<typeof definitionSummarySchema> & {
  ownerUserId: string;
};
const field = "w-full rounded border border-border bg-background p-2 text-sm";
const initialSource =
  'export const meta = { name: "New workflow", description: "Saved workflow" };\nreturn args;';

export function WorkflowDefinitionsPanel() {
  const rpc = useRpc<typeof workflowDefinitionRpcContract>();
  const navigate = useBbNavigate();
  const sourceId = useId();
  const argumentsId = useId();
  const [rows, setRows] = useState<Summary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState("");
  const [selected, setSelected] = useState<Definition | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [originThreadId, setOriginThreadId] = useState("");
  const [script, setScript] = useState(initialSource);
  const [argsText, setArgsText] = useState("null");
  const [revisionText, setRevisionText] = useState("");
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const sequence = useRef(0);

  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );

  const request = useCallback(
    async (action: (current: () => boolean) => Promise<void>) => {
      const attempt = ++sequence.current;
      const current = () => sequence.current === attempt;
      setBusy(true);
      setError(null);
      try {
        await action(current);
      } catch (cause) {
        if (current())
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (current()) setBusy(false);
      }
    },
    [],
  );

  function fill(value: Definition, ownerUserId: string | null) {
    setSelected(value);
    setOwner(ownerUserId);
    setProjectId(value.projectId);
    setOriginThreadId(value.originThreadId);
    setScript(value.script);
    setArgsText(JSON.stringify(value.args, null, 2));
    setRevisionText(String(value.revision));
    setLastRun(null);
  }

  const inventory = useCallback(
    async (cursor: string | null, filter: string) => {
      setAvailable(false);
      setRows([]);
      setNextCursor(null);
      setSelected(null);
      setOwner(null);
      setProjectId("");
      setOriginThreadId("");
      setRevisionText("");
      setScript(initialSource);
      setArgsText("null");
      setLastRun(null);
      await request(async (current) => {
        const page = await rpc.call("controlPlaneDefinitionInventory", {
          cursor,
          limit: 20,
          ...(filter ? { projectId: filter } : {}),
        });
        if (!current()) return;
        setRows(page.definitions);
        setNextCursor(page.nextCursor);
        setAvailable(true);
      });
    },
    [rpc, request],
  );

  useEffect(() => {
    const timeout = setTimeout(() => void inventory(null, ""), 0);
    return () => clearTimeout(timeout);
  }, [inventory]);

  async function load(
    id: string,
    ownerUserId: string | null,
    revision?: number,
  ) {
    setSelected(null);
    setScript("");
    setArgsText("null");
    setLastRun(null);
    await request(async (current) => {
      const value = await rpc.call("controlPlaneDefinitionGet", {
        id,
        ...(revision === undefined ? {} : { revision }),
      });
      if (current()) fill(value, ownerUserId);
    });
  }

  function fresh() {
    sequence.current++;
    setBusy(false);
    setSelected(null);
    setOwner(null);
    setProjectId("");
    setOriginThreadId("");
    setScript(initialSource);
    setArgsText("null");
    setRevisionText("");
    setLastRun(null);
    setError(null);
  }

  async function save() {
    await request(async (current) => {
      const args: unknown = JSON.parse(argsText);
      const value = selected
        ? await rpc.call("controlPlaneDefinitionUpdate", {
            id: selected.id,
            expectedRevision: selected.revision,
            script,
            args,
          })
        : await rpc.call("controlPlaneDefinitionCreate", {
            projectId: projectId.trim(),
            originThreadId: originThreadId.trim(),
            script,
            args,
          });
      if (!current()) return;
      fill(value, owner);
      setRows((previous) =>
        previous.map((row) =>
          row.id === value.id
            ? {
                ...row,
                revision: value.revision,
                name: value.name,
                updatedAt: value.updatedAt,
              }
            : row,
        ),
      );
    });
  }

  async function toggle() {
    if (!selected) return;
    await request(async (current) => {
      const value = await rpc.call("controlPlaneDefinitionEnabled", {
        id: selected.id,
        enabled: !selected.enabled,
      });
      if (!current()) return;
      setSelected({ ...selected, enabled: value.enabled });
      setRows((previous) =>
        previous.map((row) =>
          row.id === value.id ? { ...row, enabled: value.enabled } : row,
        ),
      );
    });
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 overflow-auto p-4">
      <h1 className="text-lg font-semibold">Workflow definitions</h1>
      <p className="text-sm text-muted-foreground">
        Managed server definitions. Execution uses the saved owner's current
        project and profile permissions. Disabling or deleting a definition also
        stops its active descendants.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex-1 text-sm">
          Filter by project ID
          <input
            className={field}
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
            disabled={busy}
          />
        </label>
        <Button
          disabled={busy}
          onClick={() => void inventory(null, projectFilter.trim())}
        >
          Refresh definitions
        </Button>
        <Button
          disabled={busy || !nextCursor}
          onClick={() => void inventory(nextCursor, projectFilter.trim())}
        >
          Next definitions
        </Button>
        <Button disabled={busy || !available} onClick={fresh}>
          New definition
        </Button>
      </div>
      {busy && <p role="status">Loading definitions…</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th>Name</th>
              <th>Owner</th>
              <th>Project</th>
              <th>Revision</th>
              <th>Enabled</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void load(row.id, row.ownerUserId)}
                  >
                    {row.name}
                  </Button>
                </td>
                <td className="break-all">{row.ownerUserId}</td>
                <td className="break-all">{row.projectId}</td>
                <td>{row.revision}</td>
                <td>{row.enabled ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {available && (
        <section aria-label="Definition editor" className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">
            {selected
              ? `Loaded revision ${selected.revision}: ${selected.name}`
              : "Create definition"}
          </h2>
          {selected && (
            <p className="break-all text-sm">
              Definition: {selected.id}. Owner:{" "}
              {owner ?? "derived from the origin thread"}.
            </p>
          )}
          <label className="text-sm">
            Project ID
            <input
              className={field}
              value={projectId}
              disabled={busy || !!selected}
              onChange={(event) => setProjectId(event.target.value)}
            />
          </label>
          <label className="text-sm">
            Origin thread ID
            <input
              className={field}
              value={originThreadId}
              disabled={busy || !!selected}
              onChange={(event) => setOriginThreadId(event.target.value)}
            />
          </label>
          <div className="text-sm">
            <label htmlFor={sourceId}>Definition source</label>
            <textarea
              id={sourceId}
              className={`${field} min-h-48 font-mono`}
              value={script}
              disabled={busy}
              onChange={(event) => setScript(event.target.value)}
            />
          </div>
          <div className="text-sm">
            <label htmlFor={argumentsId}>Default arguments</label>
            <textarea
              id={argumentsId}
              className={`${field} min-h-20 font-mono`}
              value={argsText}
              disabled={busy}
              onChange={(event) => setArgsText(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                busy ||
                !script.trim() ||
                !projectId.trim() ||
                !originThreadId.trim()
              }
              onClick={() => void save()}
            >
              {selected ? "Save new revision" : "Create definition"}
            </Button>
            {selected && (
              <>
                <Button
                  disabled={busy || !selected.enabled}
                  onClick={() =>
                    void request(async (current) => {
                      const run = await rpc.call("controlPlaneDefinitionRun", {
                        id: selected.id,
                        revision: selected.revision,
                      });
                      if (current()) setLastRun(run.id);
                    })
                  }
                >
                  Run saved revision
                </Button>
                <Button disabled={busy} onClick={() => void toggle()}>
                  {selected.enabled
                    ? "Disable definition"
                    : "Enable definition"}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void request(async (current) => {
                      await rpc.call("controlPlaneDefinitionRemove", {
                        id: selected.id,
                      });
                      if (!current()) return;
                      setRows((previous) =>
                        previous.filter((row) => row.id !== selected.id),
                      );
                      fresh();
                    })
                  }
                >
                  Delete definition
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => navigate.toThread(selected.originThreadId)}
                >
                  Open origin thread
                </Button>
              </>
            )}
          </div>
          {selected && (
            <div className="flex items-end gap-2">
              <label className="text-sm">
                Revision to load
                <input
                  className={field}
                  inputMode="numeric"
                  value={revisionText}
                  disabled={busy}
                  onChange={(event) => setRevisionText(event.target.value)}
                />
              </label>
              <Button
                disabled={
                  busy ||
                  !/^[1-9]\d*$/.test(revisionText) ||
                  !Number.isSafeInteger(Number(revisionText))
                }
                onClick={() =>
                  void load(selected.id, owner, Number(revisionText))
                }
              >
                Load revision
              </Button>
              <Button
                disabled={busy}
                onClick={() => void load(selected.id, owner)}
              >
                Load latest revision
              </Button>
            </div>
          )}
          {selected && (
            <p className="text-sm text-muted-foreground">
              Run uses the loaded saved revision and its saved arguments. Save
              edits before running them. Saving an older revision reports a
              conflict if the definition has changed.
            </p>
          )}
          {lastRun && (
            <p role="status" className="break-all text-sm">
              Started workflow: {lastRun}
            </p>
          )}
        </section>
      )}
    </main>
  );
}
