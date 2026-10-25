import {
  controlPlaneAutomationSchema,
  controlPlaneAutomationPageSchema,
  controlPlaneAutomationHistorySchema,
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
