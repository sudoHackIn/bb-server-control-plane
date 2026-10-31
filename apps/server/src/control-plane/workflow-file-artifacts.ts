import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import {
  events,
  getControlPlaneThread,
  hydrateRetainedEventOutputRowsWithinDataByteLimit,
  type DbConnection,
} from "@bb/db";
import { z } from "zod";
import { jsonValueSchema } from "@bb/domain";

const payload = z.object({
  item: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("fileChange"),
      status: z.string(),
      changes: z.array(
        z.object({
          path: z.string(),
          kind: z.enum(["add", "delete", "update"]),
          movePath: z.string().optional(),
          diff: z.string().optional(),
        }),
      ),
    }),
    z.object({
      type: z.literal("toolCall"),
      status: z.string(),
      tool: z.enum(["write_file", "edit"]),
      arguments: z.object({
        file_path: z.string().optional(),
        path: z.string().optional(),
      }),
      result: jsonValueSchema.optional(),
      error: z.string().optional(),
      truncation: z
        .object({
          result: z
            .object({ originalLength: z.number() })
            .passthrough()
            .optional(),
        })
        .passthrough()
        .optional(),
    }),
  ]),
});
function prefix(value: string, bytes: number) {
  const encoded = Buffer.from(value);
  if (encoded.byteLength <= bytes) return value;
  return new TextDecoder("utf-8", { fatal: false }).decode(
    encoded.subarray(0, bytes),
    { stream: true },
  );
}
export function readWorkflowFileArtifacts(
  db: DbConnection,
  userId: string,
  projectId: string,
  workers: Array<{ threadId: string }>,
) {
  const readable = workers.filter(
    (worker) =>
      getControlPlaneThread(db, userId, worker.threadId)?.projectId ===
      projectId,
  );
  const entries: Array<{
    eventId: string;
    threadId: string;
    sequence: number;
    createdAt: number;
    path: string;
    kind: "add" | "delete" | "update" | "write_file" | "edit";
    movePath: string | null;
    status: string;
    diff: string | null;
    diffTruncated: boolean;
    output: string | null;
    outputTruncated: boolean;
  }> = [];
  let truncated = false;
  let bytes = 0;
  if (readable.length) {
    const rows = db
      .select({
        id: events.id,
        type: events.type,
        threadId: events.threadId,
        sequence: events.sequence,
        createdAt: events.createdAt,
        data: sql<string>`CASE WHEN length(cast(${events.data} AS blob)) <= 1048576 THEN ${events.data} ELSE '{}' END`,
      })
      .from(events)
      .where(
        and(
          inArray(
            events.threadId,
            readable.map((worker) => worker.threadId),
          ),
          eq(events.type, "item/completed"),
          or(
            eq(events.itemKind, "fileChange"),
            and(
              eq(events.itemKind, "toolCall"),
              sql`CASE WHEN json_valid(${events.data}) THEN json_extract(${events.data}, '$.item.tool') ELSE NULL END IN ('write_file','edit')`,
            ),
          ),
        ),
      )
      .orderBy(asc(events.createdAt), asc(events.id))
      .limit(101)
      .all();
    truncated = rows.length > 100;
    for (const row of rows.slice(0, 100)) {
      if (Buffer.byteLength(row.data) > 1048576) {
        truncated = true;
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(
          hydrateRetainedEventOutputRowsWithinDataByteLimit(
            db,
            [row],
            1048576,
          )[0]?.data ?? row.data,
        );
      } catch {
        truncated = true;
        continue;
      }
      const parsed = payload.safeParse(raw);
      if (!parsed.success) {
        truncated = true;
        continue;
      }
      const item = parsed.data.item;
      const changes =
        item.type === "fileChange"
          ? item.changes.map((change) => ({
              ...change,
              output: null,
              outputWasTruncated: false,
            }))
          : [
              {
                path:
                  item.arguments.file_path ??
                  item.arguments.path ??
                  "(path not retained)",
                kind: item.tool,
                movePath: undefined,
                diff: undefined,
                outputWasTruncated: item.truncation?.result !== undefined,
                output:
                  item.error ??
                  (item.result === undefined
                    ? null
                    : JSON.stringify(item.result)),
              },
            ];
      for (const change of changes) {
        if (entries.length >= 100 || bytes >= 1048576) {
          truncated = true;
          break;
        }
        const diff =
          change.diff === undefined
            ? null
            : prefix(change.diff, Math.min(65536, 1048576 - bytes));
        bytes += diff === null ? 0 : Buffer.byteLength(diff);
        const output =
          change.output === null
            ? null
            : prefix(change.output, Math.min(65536, 1048576 - bytes));
        bytes += output === null ? 0 : Buffer.byteLength(output);
        entries.push({
          eventId: row.id,
          threadId: row.threadId,
          sequence: row.sequence,
          createdAt: row.createdAt,
          path: prefix(change.path, 4096),
          kind: change.kind,
          movePath:
            change.movePath === undefined
              ? null
              : prefix(change.movePath, 4096),
          status: prefix(parsed.data.item.status, 128),
          diff,
          diffTruncated: diff !== null && diff !== change.diff,
          output,
          outputTruncated:
            change.outputWasTruncated ||
            (output !== null && output !== change.output),
        });
      }
    }
  }
  return {
    entries,
    truncated,
    unavailableWorkers: workers.length - readable.length,
  };
}
