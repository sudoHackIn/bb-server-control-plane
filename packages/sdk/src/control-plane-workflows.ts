import { createControlPlaneWorkflowDefinitionsClient } from "./control-plane-workflow-definitions.js";
import { z } from "zod";
import {
  controlPlaneWorkflowStartSchema,
  controlPlaneWorkflowInspectionSchema,
  controlPlaneWorkflowCallInspectionSchema,
  controlPlaneWorkflowRunSchema,
  controlPlaneWorkflowPageSchema,
  controlPlaneWorkflowResultSchema,
  controlPlaneWorkflowHistorySchema,
} from "@bb/domain";

export function createControlPlaneWorkflowClient(
  request: (
    path: string,
    method: string,
    body?: object,
    signal?: AbortSignal,
  ) => Promise<unknown>,
) {
  const base = "/control-plane/user/workflows";
  const path = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    definitions: createControlPlaneWorkflowDefinitionsClient(request),
    async start(
      input: z.input<typeof controlPlaneWorkflowStartSchema>,
      signal?: AbortSignal,
    ) {
      return controlPlaneWorkflowRunSchema.parse(
        await request(
          base,
          "POST",
          controlPlaneWorkflowStartSchema.parse(input),
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
      return controlPlaneWorkflowPageSchema.parse(
        await request(
          `${base}${query.size ? `?${query}` : ""}`,
          "GET",
          undefined,
          options.signal,
        ),
      );
    },
    async get(id: string, signal?: AbortSignal) {
      return controlPlaneWorkflowRunSchema.parse(
        await request(path(id), "GET", undefined, signal),
      );
    },
    async stop(id: string, signal?: AbortSignal) {
      return z
        .object({ stopped: z.boolean() })
        .strict()
        .parse(await request(`${path(id)}/stop`, "POST", undefined, signal));
    },
    async result(id: string, signal?: AbortSignal) {
      return controlPlaneWorkflowResultSchema.parse(
        await request(`${path(id)}/result`, "GET", undefined, signal),
      );
    },
    async inspect(
      id: string,
      options: { after?: number; limit?: number; signal?: AbortSignal } = {},
    ) {
      const query = new URLSearchParams();
      if (options.after !== undefined)
        query.set("after", String(options.after));
      if (options.limit !== undefined)
        query.set("limit", String(options.limit));
      return controlPlaneWorkflowInspectionSchema.parse(
        await request(
          `${path(id)}/inspection${query.size ? `?${query}` : ""}`,
          "GET",
          undefined,
          options.signal,
        ),
      );
    },
    async inspectCall(id: string, callId: string, signal?: AbortSignal) {
      return controlPlaneWorkflowCallInspectionSchema.parse(
        await request(
          `${path(id)}/calls/${encodeURIComponent(callId)}`,
          "GET",
          undefined,
          signal,
        ),
      );
    },
    async history(
      id: string,
      options: { after?: number; limit?: number; signal?: AbortSignal } = {},
    ) {
      const query = new URLSearchParams();
      if (options.after !== undefined)
        query.set("after", String(options.after));
      if (options.limit !== undefined)
        query.set("limit", String(options.limit));
      return controlPlaneWorkflowHistorySchema.parse(
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
