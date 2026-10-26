import { z } from "zod";

const revision = z.number().int().positive();
export const controlPlaneMcpEndpointSchema = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  }, "Expected an HTTPS endpoint or HTTP loopback without credentials, query or fragment");
export const controlPlaneMcpConnectorCreateSchema = z
  .object({
    slug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),
    name: z.string().trim().min(1).max(200),
    endpoint: controlPlaneMcpEndpointSchema,
  })
  .strict();
export const controlPlaneMcpConnectorUpdateSchema =
  controlPlaneMcpConnectorCreateSchema
    .omit({ slug: true })
    .extend({ expectedRevision: revision, enabled: z.boolean() })
    .strict();
export const controlPlaneMcpConnectorSchema =
  controlPlaneMcpConnectorCreateSchema
    .extend({
      id: z.string().uuid(),
      revision,
      enabled: z.boolean(),
      transport: z.literal("streamable-http"),
      authentication: z.literal("bearer"),
      createdAt: z.number(),
      updatedAt: z.number(),
    })
    .strict();
export const controlPlaneMcpCredentialInputSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    connectorRevision: revision,
    token: z
      .string()
      .min(1)
      .max(16384)
      .regex(/^[!-~]+$/u),
  })
  .strict();
export const controlPlaneMcpCredentialMetadataSchema = z
  .object({
    connectorId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    connectorRevision: revision.nullable(),
    configured: z.boolean(),
    updatedAt: z.number().nullable(),
  })
  .strict();
export const controlPlaneMcpConnectionCreateSchema = z
  .object({ connectorId: z.string().uuid(), connectorRevision: revision })
  .strict();
export const controlPlaneMcpConnectionSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().min(1),
    connectorId: z.string().uuid(),
    connectorRevision: revision,
    revision,
    enabled: z.boolean(),
    createdAt: z.number(),
    updatedAt: z.number(),
    name: z.string(),
    slug: z.string(),
    readiness: z.enum([
      "configured",
      "credentials_required",
      "connector_unavailable",
      "revision_mismatch",
      "access_denied",
    ]),
    executionState: z.literal("not_activated"),
  })
  .strict();
export type ControlPlaneMcpConnectorCreate = z.infer<
  typeof controlPlaneMcpConnectorCreateSchema
>;
export type ControlPlaneMcpConnectorUpdate = z.infer<
  typeof controlPlaneMcpConnectorUpdateSchema
>;
