import { z } from "zod";
import {
  controlPlaneMcpConnectorSchema,
  controlPlaneMcpConnectorCreateSchema,
  controlPlaneMcpConnectorUpdateSchema,
  controlPlaneMcpConnectionSchema,
  controlPlaneMcpConnectionCreateSchema,
  controlPlaneMcpCredentialMetadataSchema,
  controlPlaneMcpCredentialInputSchema,
} from "@bb/domain";

type Request = (
  path: string,
  method: string,
  body?: object,
  signal?: AbortSignal,
) => Promise<unknown>;
export function createControlPlaneMcpClient(request: Request) {
  const admin = "/control-plane/admin/mcp/connectors",
    user = "/control-plane/user/mcp/connectors";
  const id = (value: string) => z.string().uuid().parse(value);
  const reader = (base: string) => ({
    async list(
      options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
    ) {
      const query = new URLSearchParams();
      if (options.cursor) query.set("cursor", id(options.cursor));
      if (options.limit !== undefined)
        query.set(
          "limit",
          String(z.number().int().min(1).max(100).parse(options.limit)),
        );
      return z
        .object({
          connectors: z.array(controlPlaneMcpConnectorSchema),
          nextCursor: z.string().uuid().nullable(),
        })
        .parse(
          await request(
            base + (query.size ? `?${query}` : ""),
            "GET",
            undefined,
            options.signal,
          ),
        );
    },
    async get(connectorId: string, signal?: AbortSignal) {
      return controlPlaneMcpConnectorSchema.parse(
        await request(`${base}/${id(connectorId)}`, "GET", undefined, signal),
      );
    },
  });
  const projectPath = (projectId: string) =>
    `/control-plane/user/projects/${encodeURIComponent(projectId)}/mcp`;
  return {
    admin: {
      ...reader(admin),
      async create(
        input: z.infer<typeof controlPlaneMcpConnectorCreateSchema>,
      ) {
        return controlPlaneMcpConnectorSchema.parse(
          await request(
            admin,
            "POST",
            controlPlaneMcpConnectorCreateSchema.parse(input),
          ),
        );
      },
      async update(
        connectorId: string,
        input: z.infer<typeof controlPlaneMcpConnectorUpdateSchema>,
      ) {
        return controlPlaneMcpConnectorSchema.parse(
          await request(
            `${admin}/${id(connectorId)}`,
            "PUT",
            controlPlaneMcpConnectorUpdateSchema.parse(input),
          ),
        );
      },
      async grant(connectorId: string, userId: string, allowed: boolean) {
        return z
          .object({ ok: z.literal(true) })
          .parse(
            await request(
              `${admin}/${id(connectorId)}/access/${id(userId)}`,
              "PUT",
              { allowed },
            ),
          );
      },
    },
    user: {
      ...reader(user),
      async credential(connectorId: string, signal?: AbortSignal) {
        return controlPlaneMcpCredentialMetadataSchema.parse(
          await request(
            `${user}/${id(connectorId)}/credential`,
            "GET",
            undefined,
            signal,
          ),
        );
      },
      async setCredential(
        connectorId: string,
        input: z.infer<typeof controlPlaneMcpCredentialInputSchema>,
      ) {
        return controlPlaneMcpCredentialMetadataSchema.parse(
          await request(
            `${user}/${id(connectorId)}/credential`,
            "PUT",
            controlPlaneMcpCredentialInputSchema.parse(input),
          ),
        );
      },
      async revokeCredential(connectorId: string, expectedRevision: number) {
        return controlPlaneMcpCredentialMetadataSchema.parse(
          await request(`${user}/${id(connectorId)}/credential`, "DELETE", {
            expectedRevision: z
              .number()
              .int()
              .positive()
              .parse(expectedRevision),
          }),
        );
      },
      async connections(projectId: string, signal?: AbortSignal) {
        return z
          .object({
            connections: z.array(controlPlaneMcpConnectionSchema),
            executionSupported: z.boolean(),
          })
          .parse(
            await request(projectPath(projectId), "GET", undefined, signal),
          );
      },
      async configure(
        projectId: string,
        input: z.infer<typeof controlPlaneMcpConnectionCreateSchema> & {
          expectedRevision: number;
          enabled?: boolean;
        },
      ) {
        const parsed = controlPlaneMcpConnectionCreateSchema
          .extend({
            expectedRevision: z.number().int().nonnegative(),
            enabled: z.boolean().default(false),
          })
          .strict()
          .parse(input);
        return controlPlaneMcpConnectionSchema.parse(
          await request(projectPath(projectId), "PUT", parsed),
        );
      },
      async remove(
        projectId: string,
        connectionId: string,
        expectedRevision: number,
      ) {
        return z.object({ ok: z.literal(true) }).parse(
          await request(
            `${projectPath(projectId)}/${id(connectionId)}`,
            "DELETE",
            {
              expectedRevision: z
                .number()
                .int()
                .positive()
                .parse(expectedRevision),
            },
          ),
        );
      },
    },
  };
}
