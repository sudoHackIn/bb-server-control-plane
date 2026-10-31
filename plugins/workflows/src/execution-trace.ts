import { createHash } from "node:crypto";
import { z } from "zod";
import type { JsonValue } from "./types.js";
import { utf8Prefix } from "./utf8.js";

const localId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const traceEventSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("start"),
      id: localId,
      scopeId: localId.nullable(),
      kind: z.enum(["workflow", "parallel"]),
      name: z.string().max(1024),
      branchCount: z.number().int().min(0).max(4096).nullable(),
    })
    .strict(),
  z
    .object({
      op: z.literal("source"),
      id: localId,
      name: z.string().max(1024),
      sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .strict(),
  z
    .object({
      op: z.literal("end"),
      id: localId,
      status: z.enum(["succeeded", "failed", "cancelled"]),
      error: z.string().max(1024).nullable(),
      failedBranches: z.number().int().min(0).max(4096).nullable(),
    })
    .strict(),
  z.object({ op: z.literal("truncated") }).strict(),
]);
export type TraceEvent = z.infer<typeof traceEventSchema>;
export function createTraceEmitter(emit: (event: TraceEvent) => void) {
  let sequence = 0;
  let bytes = 0;
  let truncated = false;
  function send(event: TraceEvent) {
    if (truncated) return;
    const encoded = JSON.stringify(event);
    bytes += Buffer.byteLength(encoded);
    if (sequence > 1024 || bytes > 1048576) {
      truncated = true;
      emit({ op: "truncated" });
    } else emit(event);
  }
  return {
    start(
      scopeId: number | null,
      kind: "workflow" | "parallel",
      name: string,
      branchCount: number | null = null,
    ) {
      const id = ++sequence;
      send({
        op: "start",
        id,
        scopeId,
        kind,
        name: utf8Prefix(name, 1024),
        branchCount,
      });
      return id;
    },
    source(id: number, name: string, source: string) {
      send({
        op: "source",
        id,
        name: utf8Prefix(name, 1024),
        sourceHash: createHash("sha256").update(source).digest("hex"),
      });
    },
    end(
      id: number,
      status: "succeeded" | "failed" | "cancelled",
      error: string | null = null,
      failedBranches: number | null = null,
    ) {
      send({
        op: "end",
        id,
        status,
        error: error === null ? null : utf8Prefix(error, 1024),
        failedBranches,
      });
    },
    parallel(scopeId: number | null) {
      return {
        start: (branches: number) =>
          this.start(scopeId, "parallel", "Parallel", branches),
        finish: (id: number, failedBranches: number) =>
          this.end(id, "succeeded", null, failedBranches),
      };
    },
  };
}
export type WorkflowEvaluatorEvent =
  | { type: "log" | "phase"; value: string }
  | { type: "trace"; value: JsonValue };
