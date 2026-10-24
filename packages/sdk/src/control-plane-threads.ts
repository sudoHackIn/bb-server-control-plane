import { threadTimelineResponseSchema } from "@bb/server-contract";
import {
  controlPlaneTimelineDetailsSchema,
  timelineTurnSummaryDetailsResponseSchema,
  timelinePaginationCursorSchema,
  type TimelinePaginationCursor,
  type ControlPlaneTimelineDetails,
} from "@bb/server-contract";
import { readControlPlaneThreadStream } from "./control-plane-thread-stream.js";
import { z } from "zod";
import {
  controlPlaneThreadStartSchema,
  controlPlaneThreadSendSchema,
  controlPlaneThreadSummarySchema,
  threadEventRowSchema,
  pendingInteractionSchema,
  controlPlaneThreadResolutionSchema,
} from "@bb/domain";

export function createControlPlaneThreadClient(
  request: (
    path: string,
    method: string,
    body?: object,
    signal?: AbortSignal,
  ) => Promise<unknown>,
  requestResponse: (
    path: string,
    method: string,
    body?: object,
    signal?: AbortSignal,
  ) => Promise<Response>,
) {
  const base = "/control-plane/user/threads";
  const path = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    async list(
      options: {
        projectId?: string;
        cursor?: string;
        limit?: number;
        signal?: AbortSignal;
      } = {},
    ) {
      const query = new URLSearchParams();
      if (options.projectId !== undefined)
        query.set("projectId", options.projectId);
      if (options.cursor !== undefined) query.set("cursor", options.cursor);
      if (options.limit !== undefined)
        query.set("limit", String(options.limit));
      return z
        .object({
          threads: z.array(controlPlaneThreadSummarySchema),
          nextCursor: z.string().nullable(),
        })
        .parse(
          await request(
            `${base}${query.size ? `?${query}` : ""}`,
            "GET",
            undefined,
            options.signal,
          ),
        );
    },
    async start(
      input: z.input<typeof controlPlaneThreadStartSchema>,
      signal?: AbortSignal,
    ) {
      return controlPlaneThreadSummarySchema.parse(
        await request(
          base,
          "POST",
          controlPlaneThreadStartSchema.parse(input),
          signal,
        ),
      );
    },
    async get(id: string, signal?: AbortSignal) {
      return controlPlaneThreadSummarySchema.parse(
        await request(path(id), "GET", undefined, signal),
      );
    },
    async send(
      id: string,
      input: z.input<typeof controlPlaneThreadSendSchema>,
      signal?: AbortSignal,
    ) {
      return z
        .object({ ok: z.literal(true), delivery: z.enum(["sent", "queued"]) })
        .parse(
          await request(
            `${path(id)}/send`,
            "POST",
            controlPlaneThreadSendSchema.parse(input),
            signal,
          ),
        );
    },
    async stop(id: string, signal?: AbortSignal) {
      return z
        .object({ ok: z.literal(true) })
        .parse(await request(`${path(id)}/stop`, "POST", undefined, signal));
    },
    async events(
      id: string,
      options: { after?: number; limit?: number; signal?: AbortSignal } = {},
    ) {
      const query = new URLSearchParams();
      if (options.after !== undefined)
        query.set("after", String(options.after));
      if (options.limit !== undefined)
        query.set("limit", String(options.limit));
      return z
        .object({
          events: z.array(threadEventRowSchema),
          cursor: z.number().int().nonnegative(),
          hasMore: z.boolean(),
          maxSequence: z.number().int().nonnegative(),
        })
        .parse(
          await request(
            `${path(id)}/events${query.size ? `?${query}` : ""}`,
            "GET",
            undefined,
            options.signal,
          ),
        );
    },
    async timeline(id: string, signal?: AbortSignal) {
      return threadTimelineResponseSchema.parse(
        await request(`${path(id)}/timeline`, "GET", undefined, signal),
      );
    },
    async olderTimeline(
      id: string,
      cursor: TimelinePaginationCursor,
      signal?: AbortSignal,
    ) {
      const value = timelinePaginationCursorSchema.parse(cursor);
      const query = new URLSearchParams({
        beforeAnchorId: value.anchorId,
        beforeAnchorSeq: String(value.anchorSeq),
      });
      return threadTimelineResponseSchema.parse(
        await request(
          `${path(id)}/timeline?${query}`,
          "GET",
          undefined,
          signal,
        ),
      );
    },
    async timelineDetails(
      id: string,
      input: ControlPlaneTimelineDetails,
      signal?: AbortSignal,
    ) {
      const value = controlPlaneTimelineDetailsSchema.parse(input);
      const query = new URLSearchParams({
        turnId: value.turnId,
        sourceSeqStart: String(value.sourceSeqStart),
        sourceSeqEnd: String(value.sourceSeqEnd),
      });
      if (value.itemId !== undefined) query.set("itemId", value.itemId);
      if (value.beforeCursor !== undefined)
        query.set("beforeCursor", value.beforeCursor);
      return timelineTurnSummaryDetailsResponseSchema.parse(
        await request(
          `${path(id)}/timeline-details?${query}`,
          "GET",
          undefined,
          signal,
        ),
      );
    },
    async *stream(
      id: string,
      options: { after?: number; signal?: AbortSignal } = {},
    ) {
      const after = z
        .number()
        .int()
        .nonnegative()
        .parse(options.after ?? 0);
      const response = await requestResponse(
        `${path(id)}/stream?${new URLSearchParams({ after: String(after) })}`,
        "GET",
        undefined,
        options.signal,
      );
      yield* readControlPlaneThreadStream(response, id, options.signal);
    },
    async result(id: string, signal?: AbortSignal) {
      return z
        .object({
          thread: controlPlaneThreadSummarySchema,
          text: z.string().nullable(),
        })
        .parse(await request(`${path(id)}/result`, "GET", undefined, signal));
    },
    interactions: {
      async list(id: string, signal?: AbortSignal) {
        return z
          .array(pendingInteractionSchema)
          .parse(
            await request(`${path(id)}/interactions`, "GET", undefined, signal),
          );
      },
      async resolve(
        id: string,
        interactionId: string,
        input: z.input<typeof controlPlaneThreadResolutionSchema>,
        signal?: AbortSignal,
      ) {
        return pendingInteractionSchema.parse(
          await request(
            `${path(id)}/interactions/${encodeURIComponent(interactionId)}/resolve`,
            "POST",
            controlPlaneThreadResolutionSchema.parse(input),
            signal,
          ),
        );
      },
    },
  };
}
