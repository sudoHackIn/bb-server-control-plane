import { z } from "zod";
import {
  controlPlaneWebhookCreateSchema,
  controlPlaneWebhookSchema,
  controlPlaneWebhookSecretSchema,
  controlPlaneWebhookPageSchema,
  controlPlaneWebhookHistorySchema,
  controlPlaneWebhookDeliverySchema,
} from "@bb/domain";
export function createControlPlaneWebhookClient(
  request: (
    path: string,
    method: string,
    body?: object,
    signal?: AbortSignal,
  ) => Promise<unknown>,
  transport: { origin: string; fetch: typeof fetch },
) {
  const base = "/control-plane/user/webhooks";
  const path = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    async create(input: z.input<typeof controlPlaneWebhookCreateSchema>) {
      return controlPlaneWebhookSecretSchema.parse(
        await request(
          base,
          "POST",
          controlPlaneWebhookCreateSchema.parse(input),
        ),
      );
    },
    async get(id: string, signal?: AbortSignal) {
      return controlPlaneWebhookSchema.parse(
        await request(path(id), "GET", undefined, signal),
      );
    },
    async list(options: {
      projectId: string;
      cursor?: string;
      limit?: number;
      signal?: AbortSignal;
    }) {
      const q = new URLSearchParams({ projectId: options.projectId });
      if (options.cursor) q.set("cursor", options.cursor);
      if (options.limit) q.set("limit", String(options.limit));
      return controlPlaneWebhookPageSchema.parse(
        await request(`${base}?${q}`, "GET", undefined, options.signal),
      );
    },
    async setEnabled(id: string, enabled: boolean) {
      return controlPlaneWebhookSchema.parse(
        await request(path(id), "PUT", { enabled }),
      );
    },
    async rotate(id: string) {
      return controlPlaneWebhookSecretSchema.parse(
        await request(`${path(id)}/rotate`, "POST"),
      );
    },
    async history(
      id: string,
      options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
    ) {
      const q = new URLSearchParams();
      if (options.cursor) q.set("cursor", options.cursor);
      if (options.limit) q.set("limit", String(options.limit));
      return controlPlaneWebhookHistorySchema.parse(
        await request(
          `${path(id)}/history?${q}`,
          "GET",
          undefined,
          options.signal,
        ),
      );
    },
    async deliver(
      id: string,
      input: {
        secret: string;
        deliveryId: string;
        payload: Record<string, unknown>;
      },
      signal?: AbortSignal,
    ) {
      const secret = z
        .string()
        .regex(/^whk_[A-Za-z0-9_-]{43}$/u)
        .parse(input.secret);
      const response = await transport.fetch(
        new URL(
          `/control-plane/webhooks/${encodeURIComponent(id)}/deliver`,
          transport.origin,
        ),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${secret}`,
            "x-bb-delivery-id": input.deliveryId,
          },
          body: JSON.stringify(input.payload),
          redirect: "manual",
          credentials: "omit",
          signal,
        },
      );
      const value: unknown = await response.json();
      const parsed = controlPlaneWebhookDeliverySchema.safeParse(value);
      if (parsed.success && [202, 422].includes(response.status))
        return parsed.data;
      throw new Error(`Webhook delivery rejected (${response.status})`);
    },
  };
}
