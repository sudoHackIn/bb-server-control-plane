import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db, WorkflowCallRow } from "./data.js";
import { traceEventSchema, type TraceEvent } from "./execution-trace.js";
import { utf8Prefix } from "./utf8.js";

const status = z.enum([
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "incomplete",
]);
const attemptSchema = z.object({
  id: z.string().uuid(),
  sequence: z.number().int().positive(),
  status,
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
  truncated: z.union([z.literal(0), z.literal(1)]).transform((v) => v === 1),
});
const entrySchema = z.object({
  index: z.number().int().nonnegative(),
  nodeId: z.number().nullable(),
  scopeId: z.number().nullable(),
  kind: z.enum(["workflow", "parallel", "agent"]),
  name: z.string(),
  sourceHash: z.string().nullable(),
  branchCount: z.number().nullable(),
  failedBranches: z.number().nullable(),
  status,
  error: z.string().nullable(),
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
  callId: z.string().nullable(),
  callIndex: z.number().nullable(),
  source: z.enum(["live", "cached"]).nullable(),
});
export function interruptWorkflowTraces(db: Db) {
  db.prepare(
    "UPDATE workflow_trace_entries SET status='interrupted', finished_at=? WHERE status='running'",
  ).run(Date.now());
  db.prepare(
    "UPDATE workflow_trace_attempts SET status='interrupted', finished_at=? WHERE status='running'",
  ).run(Date.now());
}
export function createStoredWorkflowTrace(db: Db, runId: string) {
  const id = randomUUID();
  db.transaction(() => {
    db.prepare(
      "UPDATE workflow_trace_entries SET status='interrupted', finished_at=? WHERE attempt_id IN (SELECT id FROM workflow_trace_attempts WHERE run_id=? AND status='running') AND status='running'",
    ).run(Date.now(), runId);
    db.prepare(
      "UPDATE workflow_trace_attempts SET status='interrupted', finished_at=? WHERE run_id=? AND status='running'",
    ).run(Date.now(), runId);
    db.prepare(
      "INSERT INTO workflow_trace_attempts(id,run_id,sequence,status,created_at) SELECT ?,?,COALESCE(MAX(sequence),0)+1,'running',? FROM workflow_trace_attempts WHERE run_id=?",
    ).run(id, runId, Date.now(), runId);
  })();
  let ordinal = 0;
  let truncated = false;
  const nodes = new Map<
    number,
    { kind: "workflow" | "parallel"; open: boolean; branchCount: number | null }
  >();
  function scope(scopeId: number | null) {
    if (scopeId === null || truncated) return;
    const parent = nodes.get(scopeId);
    if (!parent || parent.kind !== "workflow" || !parent.open)
      throw new Error("Invalid workflow trace scope");
  }
  function observe(input: TraceEvent) {
    const event = traceEventSchema.parse(input);
    if (event.op === "truncated") {
      truncated = true;
      db.prepare(
        "UPDATE workflow_trace_attempts SET truncated=1 WHERE id=?",
      ).run(id);
      return;
    }
    if (truncated) return;
    if (event.op === "start") {
      scope(event.scopeId);
      if (event.kind === "workflow" && event.scopeId !== null)
        throw new Error("Workflow trace depth limit exceeded");
      if (
        nodes.has(event.id) ||
        nodes.size >= 1024 ||
        (event.kind === "parallel") !== (event.branchCount !== null)
      )
        throw new Error("Invalid workflow trace node");
      nodes.set(event.id, {
        kind: event.kind,
        open: true,
        branchCount: event.branchCount,
      });
      db.prepare(
        "INSERT INTO workflow_trace_entries(attempt_id,ordinal,node_id,scope_id,kind,name,branch_count,status,created_at) VALUES(?,?,?,?,?,?,?,'running',?)",
      ).run(
        id,
        ordinal++,
        event.id,
        event.scopeId,
        event.kind,
        event.name,
        event.branchCount,
        Date.now(),
      );
    } else {
      const node = nodes.get(event.id);
      if (!node || !node.open)
        throw new Error("Unknown or completed workflow trace node");
      if (event.op === "source") {
        if (node.kind !== "workflow")
          throw new Error("Invalid workflow trace source");
        db.prepare(
          "UPDATE workflow_trace_entries SET name=?,source_hash=? WHERE attempt_id=? AND node_id=?",
        ).run(event.name, event.sourceHash, id, event.id);
      } else {
        if (
          node.kind === "parallel"
            ? event.failedBranches === null ||
              event.failedBranches > (node.branchCount ?? 0)
            : event.failedBranches !== null
        )
          throw new Error("Invalid workflow trace completion");
        node.open = false;
        db.prepare(
          "UPDATE workflow_trace_entries SET status=?,error=?,failed_branches=?,finished_at=? WHERE attempt_id=? AND node_id=?",
        ).run(
          event.status,
          event.error,
          event.failedBranches,
          Date.now(),
          id,
          event.id,
        );
      }
    }
  }
  return {
    id,
    observe,
    call(index: number, scopeId: number | null) {
      scope(scopeId);
      const entryIndex = ordinal++;
      db.prepare(
        "INSERT INTO workflow_trace_entries(attempt_id,ordinal,scope_id,kind,name,status,created_at,call_index) VALUES(?,?,?,'agent',?,'running',?,?)",
      ).run(
        id,
        entryIndex,
        scopeId,
        `Agent call ${index + 1}`,
        Date.now(),
        index,
      );
      return {
        admitted(call: WorkflowCallRow) {
          if (call.runId !== runId || call.callIndex !== index)
            throw new Error("Invalid workflow trace call binding");
          db.prepare(
            "UPDATE workflow_trace_entries SET call_id=?,cache_key=?,source=? WHERE attempt_id=? AND ordinal=?",
          ).run(
            call.id,
            call.cacheKey,
            call.replaySource === null ? "live" : "cached",
            id,
            entryIndex,
          );
        },
        finish(
          outcome: "succeeded" | "failed" | "cancelled",
          error: string | null = null,
        ) {
          db.prepare(
            "UPDATE workflow_trace_entries SET status=?,error=?,finished_at=? WHERE attempt_id=? AND ordinal=?",
          ).run(
            outcome,
            error === null ? null : utf8Prefix(error, 1024),
            Date.now(),
            id,
            entryIndex,
          );
        },
      };
    },
    finish(outcome: "succeeded" | "failed" | "cancelled" | "interrupted") {
      const now = Date.now();
      db.transaction(() => {
        db.prepare(
          "UPDATE workflow_trace_entries SET status=?,finished_at=? WHERE attempt_id=? AND status='running'",
        ).run(
          truncated
            ? "incomplete"
            : outcome === "succeeded"
              ? "cancelled"
              : outcome,
          now,
          id,
        );
        db.prepare(
          "UPDATE workflow_trace_attempts SET status=?,finished_at=? WHERE id=?",
        ).run(outcome, now, id);
      })();
    },
  };
}
export function readWorkflowTrace(
  db: Db,
  runId: string,
  attemptId: string | null,
  after: number,
  limit: number,
) {
  const raw = db
    .prepare(
      `SELECT id,sequence,status,created_at AS createdAt,finished_at AS finishedAt,truncated FROM workflow_trace_attempts WHERE run_id=? ${attemptId === null ? "ORDER BY sequence DESC LIMIT 1" : "AND id=?"}`,
    )
    .get(...(attemptId === null ? [runId] : [runId, attemptId]));
  if (!raw)
    return attemptId === null
      ? { runId, attempt: null, entries: [], nextCursor: null }
      : null;
  const attempt = attemptSchema.parse(raw);
  const rows = z.array(entrySchema).parse(
    db
      .prepare(`SELECT e.ordinal AS 'index', e.node_id AS nodeId,e.scope_id AS scopeId,e.kind,e.name,e.source_hash AS sourceHash,e.branch_count AS branchCount,e.failed_branches AS failedBranches,e.status,e.error,e.created_at AS createdAt,e.finished_at AS finishedAt,
    c.id AS callId,e.call_index AS callIndex,e.source FROM workflow_trace_entries e
    LEFT JOIN workflow_calls c ON c.run_id=? AND c.id=e.call_id AND c.cache_key=e.cache_key
    WHERE e.attempt_id=? AND e.ordinal>? ORDER BY e.ordinal LIMIT ?`)
      .all(runId, attempt.id, after, limit + 1),
  );
  const entries = rows.slice(0, limit);
  return {
    runId,
    attempt,
    entries,
    nextCursor: rows.length > limit ? (entries.at(-1)?.index ?? null) : null,
  };
}
