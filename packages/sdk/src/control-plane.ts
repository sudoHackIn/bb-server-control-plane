import { z } from "zod";
import {
  controlPlaneProfileCreateSchema,
  controlPlaneProfileDefinitionSchema,
  controlPlaneProfileDetailSchema,
  controlPlaneProfileSummarySchema,
  controlPlaneProfileVersionSchema,
  type ControlPlaneProfileDefinition,
} from "@bb/domain";

const flowSchema = z.object({
  flowId: z.string().uuid(),
  authorizationUrl: z.string().url(),
  expiresAt: z.number(),
  pollIntervalMs: z.number().int().min(1000),
});
const exchangeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("authorized"),
    accessToken: z.string().regex(/^agt_[A-Za-z0-9_-]{43}$/u),
    tokenType: z.literal("Bearer"),
    expiresAt: z.number(),
  }),
]);
const userSchema = z.object({
  role: z.literal("user"),
  user: z.object({
    id: z.string().uuid(),
    login: z.string(),
    environmentStatus: z.enum(["allocated", "provisioning", "ready", "failed"]),
  }),
  expiresAt: z.number(),
});
const environmentSchema = z.object({
  userId: z.string().uuid(),
  uid: z.number().int(),
  gid: z.number().int(),
  home: z.string(),
  projectsRoot: z.string(),
  status: z.enum(["allocated", "provisioning", "ready", "failed"]),
});
const projectSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  slug: z.string(),
  hostId: z.string(),
  cwd: z.string(),
  role: z.enum(["owner", "runner", "viewer"]),
  canRun: z.boolean(),
  canManage: z.boolean(),
});

export function createControlPlaneClient(args: {
  origin: string;
  fetch?: typeof fetch;
  token?: () => string | null;
}) {
  const url = new URL(args.origin);
  if (
    url.origin !== args.origin ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error(
      "Control-plane clients require an HTTPS origin or HTTP loopback",
    );
  const fetcher = args.fetch ?? fetch;
  const request = async (
    path: string,
    method: string,
    body?: object,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const headers = new Headers();
    if (body) headers.set("content-type", "application/json");
    const token = args.token?.();
    if (token) headers.set("authorization", `Bearer ${token}`);
    const response = await fetcher(new URL(path, url), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
      signal,
    });
    if (!response.ok)
      throw new Error(`Control-plane request failed (${response.status})`);
    return response.json();
  };
  const profilePath = (base: string, id: string) =>
    `${base}/${encodeURIComponent(id)}`;
  const profileReader = (base: string) => ({
    async versions(
      id: string,
      options: { cursor?: number; limit?: number; signal?: AbortSignal } = {},
    ) {
      const query = new URLSearchParams();
      if (options.cursor !== undefined)
        query.set("cursor", String(options.cursor));
      if (options.limit !== undefined)
        query.set("limit", String(options.limit));
      return z
        .object({
          versions: z.array(
            controlPlaneProfileVersionSchema.omit({ definition: true }),
          ),
          nextCursor: z.number().int().positive().nullable(),
        })
        .parse(
          await request(
            `${profilePath(base, id)}/versions${query.size ? `?${query}` : ""}`,
            "GET",
            undefined,
            options.signal,
          ),
        );
    },
    async list(
      options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
    ) {
      const query = new URLSearchParams();
      if (options.cursor !== undefined) query.set("cursor", options.cursor);
      if (options.limit !== undefined)
        query.set("limit", String(options.limit));
      return z
        .object({
          profiles: z.array(controlPlaneProfileSummarySchema),
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
    async get(
      id: string,
      options: { versionId?: string; signal?: AbortSignal } = {},
    ) {
      return controlPlaneProfileDetailSchema.parse(
        await request(
          `${profilePath(base, id)}${options.versionId ? `/versions/${encodeURIComponent(options.versionId)}` : ""}`,
          "GET",
          undefined,
          options.signal,
        ),
      );
    },
  });
  const adminProfiles = "/control-plane/admin/profiles";
  const ok = z.object({ ok: z.literal(true) });
  return {
    profiles: profileReader("/control-plane/user/profiles"),
    admin: {
      profiles: {
        ...profileReader(adminProfiles),
        async create(
          input: z.infer<typeof controlPlaneProfileCreateSchema>,
          signal?: AbortSignal,
        ) {
          return controlPlaneProfileDetailSchema.parse(
            await request(
              adminProfiles,
              "POST",
              controlPlaneProfileCreateSchema.parse(input),
              signal,
            ),
          );
        },
        async publish(
          id: string,
          definition: ControlPlaneProfileDefinition,
          signal?: AbortSignal,
        ) {
          return controlPlaneProfileDetailSchema.parse(
            await request(
              `${profilePath(adminProfiles, id)}/versions`,
              "POST",
              {
                definition:
                  controlPlaneProfileDefinitionSchema.parse(definition),
              },
              signal,
            ),
          );
        },
        async setEnabled(
          id: string,
          enabled: boolean,
          options: { versionId?: string; signal?: AbortSignal } = {},
        ) {
          return ok.parse(
            await request(
              `${profilePath(adminProfiles, id)}${options.versionId ? `/versions/${encodeURIComponent(options.versionId)}` : ""}/enabled`,
              "PUT",
              { enabled },
              options.signal,
            ),
          );
        },
        async setAccess(
          id: string,
          userId: string,
          allowed: boolean,
          signal?: AbortSignal,
        ) {
          return ok.parse(
            await request(
              `${profilePath(adminProfiles, id)}/access/${encodeURIComponent(userId)}`,
              "PUT",
              { allowed },
              signal,
            ),
          );
        },
        async access(
          id: string,
          options: {
            cursor?: string;
            limit?: number;
            signal?: AbortSignal;
          } = {},
        ) {
          const query = new URLSearchParams();
          if (options.cursor !== undefined) query.set("cursor", options.cursor);
          if (options.limit !== undefined)
            query.set("limit", String(options.limit));
          return z
            .object({
              users: z.array(
                z.object({
                  userId: z.string().uuid(),
                  login: z.string(),
                  enabled: z.boolean(),
                }),
              ),
              nextCursor: z.string().nullable(),
            })
            .parse(
              await request(
                `${profilePath(adminProfiles, id)}/access${query.size ? `?${query}` : ""}`,
                "GET",
                undefined,
                options.signal,
              ),
            );
        },
      },
    },
    projects: {
      async list(
        options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
      ) {
        const query = new URLSearchParams();
        if (options.cursor !== undefined) query.set("cursor", options.cursor);
        if (options.limit !== undefined)
          query.set("limit", String(options.limit));
        return z
          .object({
            projects: z.array(projectSchema),
            nextCursor: z.string().nullable(),
          })
          .parse(
            await request(
              `/control-plane/user/projects${query.size ? `?${query}` : ""}`,
              "GET",
              undefined,
              options.signal,
            ),
          );
      },
      async get(projectId: string, signal?: AbortSignal) {
        return projectSchema.parse(
          await request(
            `/control-plane/user/projects/${encodeURIComponent(projectId)}`,
            "GET",
            undefined,
            signal,
          ),
        );
      },
      async create(
        input: { name: string; slug: string },
        signal?: AbortSignal,
      ) {
        return projectSchema.parse(
          await request("/control-plane/user/projects", "POST", input, signal),
        );
      },
    },
    async environment(signal?: AbortSignal) {
      return environmentSchema.parse(
        await request(
          "/control-plane/user/environment",
          "GET",
          undefined,
          signal,
        ),
      );
    },
    async provisionEnvironment(signal?: AbortSignal) {
      return environmentSchema.parse(
        await request(
          "/control-plane/user/environment",
          "POST",
          undefined,
          signal,
        ),
      );
    },
    async start(clientName: string, challenge: string, signal?: AbortSignal) {
      const result = flowSchema.parse(
        await request(
          "/control-plane/auth/start",
          "POST",
          { clientName, challenge },
          signal,
        ),
      );
      if (new URL(result.authorizationUrl).origin !== url.origin)
        throw new Error("Invalid authorization origin");
      return result;
    },
    async exchange(flowId: string, verifier: string, signal?: AbortSignal) {
      return exchangeSchema.parse(
        await request(
          "/control-plane/auth/exchange",
          "POST",
          { flowId, verifier },
          signal,
        ),
      );
    },
    async session(signal?: AbortSignal) {
      return userSchema.parse(
        await request("/control-plane/user", "GET", undefined, signal),
      );
    },
    async logout(signal?: AbortSignal) {
      z.object({ ok: z.literal(true) }).parse(
        await request("/control-plane/user/logout", "POST", undefined, signal),
      );
    },
  };
}
