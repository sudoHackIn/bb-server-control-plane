import { z } from "zod";
import type { Db, WorkflowCallRow } from "./data.js";
import { utf8Prefix } from "./utf8.js";

export const callDiagnosticsMigration = `CREATE TABLE workflow_call_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL REFERENCES workflow_calls(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL,
  thread_id TEXT, message TEXT, attempt INTEGER
);
CREATE INDEX workflow_call_diagnostics_call_idx ON workflow_call_diagnostics(call_id,cache_key,id);`;

export function recordCallDiagnostic(
  db: Db,
  call: WorkflowCallRow,
  kind: "started" | "provider-retry" | "repair" | "failure",
  message: string | null,
  attempt: number | null,
) {
  db.prepare(
    `INSERT INTO workflow_call_diagnostics(call_id,cache_key,kind,created_at,thread_id,message,attempt) VALUES(?,?,?,?,?,?,?)`,
  ).run(
    call.id,
    call.cacheKey,
    kind,
    Date.now(),
    call.childThreadId,
    message === null
      ? null
      : Buffer.byteLength(message) > 8192
        ? `${utf8Prefix(message, 8170)}\n[truncated]`
        : message,
    attempt,
  );
}
const rowSchema = z.object({
  id: z.number().int().positive(),
  kind: z.enum(["started", "provider-retry", "repair", "failure"]),
  createdAt: z.number(),
  threadId: z.string().nullable(),
  message: z.string().nullable(),
  attempt: z.number().int().nonnegative().nullable(),
});
export function readCallDiagnostics(db: Db, call: WorkflowCallRow) {
  const rows = z
    .array(rowSchema)
    .parse(
      db
        .prepare(
          `SELECT id,kind,created_at AS createdAt,thread_id AS threadId,message,attempt FROM workflow_call_diagnostics WHERE call_id=? AND cache_key=? ORDER BY id LIMIT 101`,
        )
        .all(call.id, call.cacheKey),
    );
  return {
    recordedSince:
      rows.find((row) => row.kind === "started")?.createdAt ?? null,
    entries: rows.slice(0, 100),
    truncated: rows.length > 100,
  };
}
