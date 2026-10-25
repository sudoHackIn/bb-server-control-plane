import { z } from "zod";
import {
  controlPlaneWorkflowDefinitionCreateSchema,
  controlPlaneWorkflowDefinitionUpdateSchema,
  controlPlaneWorkflowDefinitionRunSchema,
  controlPlaneWorkflowDefinitionSchema,
  controlPlaneWorkflowDefinitionPageSchema,
  controlPlaneWorkflowRunSchema,
} from "@bb/domain";
export function createControlPlaneWorkflowDefinitionsClient(
  request: (
    path: string,
    method: string,
    body?: object,
    signal?: AbortSignal,
  ) => Promise<unknown>,
) {
  const base = "/control-plane/user/workflow-definitions";
  const path = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    async create(
      input: z.input<typeof controlPlaneWorkflowDefinitionCreateSchema>,
      signal?: AbortSignal,
    ) {
      return controlPlaneWorkflowDefinitionSchema.parse(
        await request(
          base,
          "POST",
          controlPlaneWorkflowDefinitionCreateSchema.parse(input),
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
      return controlPlaneWorkflowDefinitionPageSchema.parse(
        await request(
          `${base}${query.size ? `?${query}` : ""}`,
          "GET",
          undefined,
          options.signal,
        ),
      );
    },
    async get(
      id: string,
      options: { revision?: number; signal?: AbortSignal } = {},
    ) {
      return controlPlaneWorkflowDefinitionSchema.parse(
        await request(
          `${path(id)}${options.revision === undefined ? "" : `?revision=${options.revision}`}`,
          "GET",
          undefined,
          options.signal,
        ),
      );
    },
    async update(
      id: string,
      input: z.input<typeof controlPlaneWorkflowDefinitionUpdateSchema>,
      signal?: AbortSignal,
    ) {
      return controlPlaneWorkflowDefinitionSchema.parse(
        await request(
          path(id),
          "PUT",
          controlPlaneWorkflowDefinitionUpdateSchema.parse(input),
          signal,
        ),
      );
    },
    async setEnabled(id: string, enabled: boolean, signal?: AbortSignal) {
      return controlPlaneWorkflowDefinitionSchema.parse(
        await request(`${path(id)}/enabled`, "POST", { enabled }, signal),
      );
    },
    async remove(id: string, signal?: AbortSignal) {
      return z
        .object({ deleted: z.literal(true) })
        .strict()
        .parse(await request(path(id), "DELETE", undefined, signal));
    },
    async run(
      id: string,
      input: z.input<typeof controlPlaneWorkflowDefinitionRunSchema>,
      signal?: AbortSignal,
    ) {
      return controlPlaneWorkflowRunSchema.parse(
        await request(
          `${path(id)}/run`,
          "POST",
          controlPlaneWorkflowDefinitionRunSchema.parse(input),
          signal,
        ),
      );
    },
  };
}
