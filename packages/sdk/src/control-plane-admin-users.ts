import { z } from "zod";

const userSchema = z.object({
  userId: z.string().uuid(),
  login: z.string(),
  enabled: z.boolean(),
  environmentStatus: z.enum(["allocated", "provisioning", "ready", "failed"]),
});
const pageSchema = z.object({
  users: z.array(userSchema),
  nextCursor: z.string().nullable(),
});
const listOptionsSchema = z.object({
  prefix: z.string().max(100).optional(),
  cursor: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export function createControlPlaneAdminUsersClient(
  request: (
    path: string,
    method: string,
    body?: object,
    signal?: AbortSignal,
  ) => Promise<unknown>,
) {
  return {
    async list(
      options: z.input<typeof listOptionsSchema> = {},
      signal?: AbortSignal,
    ) {
      const parsed = listOptionsSchema.parse(options);
      const query = new URLSearchParams();
      if (parsed.prefix !== undefined) query.set("prefix", parsed.prefix);
      if (parsed.cursor !== undefined) query.set("cursor", parsed.cursor);
      if (parsed.limit !== undefined) query.set("limit", String(parsed.limit));
      const suffix = query.size === 0 ? "" : `?${query.toString()}`;
      return pageSchema.parse(
        await request(
          `/control-plane/admin/users${suffix}`,
          "GET",
          undefined,
          signal,
        ),
      );
    },
  };
}
