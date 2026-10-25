import { z } from "zod";
import {
  controlPlaneAutomationSchema,
  controlPlaneAutomationOutputSchema,
  controlPlaneAutomationPageSchema,
  controlPlaneAutomationHistorySchema,
  controlPlaneAutomationDetailSchema,
  controlPlaneAutomationMutationSchema,
  controlPlaneAutomationCreateSchema,
  controlPlaneAutomationUpdateSchema,
  controlPlaneAutomationRunInputSchema,
  controlPlaneAutomationRunSchema,
} from "@bb/domain";

export function createControlPlaneAutomationClient(
  request: (
    path: string,
    method: string,
    body?: object,
    signal?: AbortSignal,
  ) => Promise<unknown>,
) {
  const base = "/control-plane/user/automations";
  const path = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    async create(
      input: z.input<typeof controlPlaneAutomationCreateSchema>,
      signal?: AbortSignal,
    ) {
      return controlPlaneAutomationMutationSchema.parse(
        await request(
          base,
          "POST",
          controlPlaneAutomationCreateSchema.parse(input),
          signal,
        ),
      );
    },
    async update(
      id: string,
      input: z.input<typeof controlPlaneAutomationUpdateSchema>,
      signal?: AbortSignal,
    ) {
      return controlPlaneAutomationMutationSchema.parse(
        await request(
          path(id),
          "PUT",
          controlPlaneAutomationUpdateSchema.parse(input),
          signal,
        ),
      );
    },
    async definition(id: string, signal?: AbortSignal) {
      return controlPlaneAutomationDetailSchema.parse(
        await request(`${path(id)}/definition`, "GET", undefined, signal),
      );
    },
    async remove(id: string, signal?: AbortSignal) {
      return z
        .object({ deleted: z.literal(true) })
        .strict()
        .parse(await request(path(id), "DELETE", undefined, signal));
    },
    async pause(id: string, signal?: AbortSignal) {
      return controlPlaneAutomationSchema.parse(
        await request(`${path(id)}/pause`, "POST", undefined, signal),
      );
    },
    async resume(id: string, signal?: AbortSignal) {
      return controlPlaneAutomationSchema.parse(
        await request(`${path(id)}/resume`, "POST", undefined, signal),
      );
    },
    async run(
      id: string,
      input: z.input<typeof controlPlaneAutomationRunInputSchema> = {},
      signal?: AbortSignal,
    ) {
      return controlPlaneAutomationRunSchema.parse(
        await request(
          `${path(id)}/run`,
          "POST",
          controlPlaneAutomationRunInputSchema.parse(input),
          signal,
        ),
      );
    },
    async output(id: string, runId: string, signal?: AbortSignal) {
      return controlPlaneAutomationOutputSchema.parse(
        await request(
          `${path(id)}/runs/${encodeURIComponent(runId)}/output`,
          "GET",
          undefined,
          signal,
        ),
      );
    },
    async stop(id: string, runId: string, signal?: AbortSignal) {
      return z
        .object({ stopped: z.boolean() })
        .strict()
        .parse(
          await request(
            `${path(id)}/runs/${encodeURIComponent(runId)}/stop`,
            "POST",
            undefined,
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
      return controlPlaneAutomationPageSchema.parse(
        await request(
          `${base}${query.size ? `?${query}` : ""}`,
          "GET",
          undefined,
          options.signal,
        ),
      );
    },
    async get(id: string, signal?: AbortSignal) {
      return controlPlaneAutomationSchema.parse(
        await request(path(id), "GET", undefined, signal),
      );
    },
    async history(
      id: string,
      options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
    ) {
      const query = new URLSearchParams();
      if (options.cursor !== undefined) query.set("cursor", options.cursor);
      if (options.limit !== undefined)
        query.set("limit", String(options.limit));
      return controlPlaneAutomationHistorySchema.parse(
        await request(
          `${path(id)}/history${query.size ? `?${query}` : ""}`,
          "GET",
          undefined,
          options.signal,
        ),
      );
    },
  };
}
