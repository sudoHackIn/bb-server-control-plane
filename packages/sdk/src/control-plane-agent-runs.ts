import { z } from "zod";
import {
  controlPlaneAgentRunSchema,
  controlPlaneAgentRunStartSchema,
  threadEventRowSchema,
} from "@bb/domain";
import { readControlPlaneThreadStream } from "./control-plane-thread-stream.js";

export function createControlPlaneAgentRunClient(
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
  const base = "/control-plane/user/agent-runs";
  const path = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    async start(
      input: z.input<typeof controlPlaneAgentRunStartSchema>,
      signal?: AbortSignal,
    ) {
      return controlPlaneAgentRunSchema.parse(
        await request(
          base,
          "POST",
          controlPlaneAgentRunStartSchema.parse(input),
          signal,
        ),
      );
    },
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
          runs: z.array(controlPlaneAgentRunSchema),
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
    async get(id: string, signal?: AbortSignal) {
      return controlPlaneAgentRunSchema.parse(
        await request(path(id), "GET", undefined, signal),
      );
    },
    async status(id: string, signal?: AbortSignal) {
      return controlPlaneAgentRunSchema.parse(
        await request(path(id), "GET", undefined, signal),
      );
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
    async result(id: string, signal?: AbortSignal) {
      return z
        .object({
          run: controlPlaneAgentRunSchema,
          text: z.string().nullable(),
        })
        .parse(await request(`${path(id)}/result`, "GET", undefined, signal));
    },
    async cancel(id: string, signal?: AbortSignal) {
      return z
        .object({ ok: z.literal(true) })
        .parse(await request(`${path(id)}/cancel`, "POST", undefined, signal));
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
  };
}
