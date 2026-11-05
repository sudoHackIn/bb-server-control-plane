import { z } from "zod";
import {
  controlPlaneTaskSourceCreateSchema,
  controlPlaneTaskSourceSchema,
  controlPlaneTaskSourcePageSchema,
  controlPlaneTaskSourceHistorySchema,
} from "@bb/domain";
export function createControlPlaneTaskSourceClient(
  request: (
    path: string,
    method: string,
    body?: object,
    signal?: AbortSignal,
  ) => Promise<unknown>,
) {
  const base = "/control-plane/user/task-sources";
  const path = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    async create(input: z.input<typeof controlPlaneTaskSourceCreateSchema>) {
      return controlPlaneTaskSourceSchema.parse(
        await request(
          base,
          "POST",
          controlPlaneTaskSourceCreateSchema.parse(input),
        ),
      );
    },
    async get(id: string, signal?: AbortSignal) {
      return controlPlaneTaskSourceSchema.parse(
        await request(path(id), "GET", undefined, signal),
      );
    },
    async list(options: {
      projectId: string;
      cursor?: string;
      signal?: AbortSignal;
    }) {
      const q = new URLSearchParams({ projectId: options.projectId });
      if (options.cursor) q.set("cursor", options.cursor);
      return controlPlaneTaskSourcePageSchema.parse(
        await request(`${base}?${q}`, "GET", undefined, options.signal),
      );
    },
    async setEnabled(id: string, enabled: boolean) {
      return controlPlaneTaskSourceSchema.parse(
        await request(path(id), "PUT", { enabled }),
      );
    },
    async poll(id: string) {
      return controlPlaneTaskSourceSchema.parse(
        await request(`${path(id)}/poll`, "POST"),
      );
    },
    async history(
      id: string,
      options: { cursor?: string; signal?: AbortSignal } = {},
    ) {
      const q = new URLSearchParams();
      if (options.cursor) q.set("cursor", options.cursor);
      return controlPlaneTaskSourceHistorySchema.parse(
        await request(
          `${path(id)}/history?${q}`,
          "GET",
          undefined,
          options.signal,
        ),
      );
    },
  };
}
