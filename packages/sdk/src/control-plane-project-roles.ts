import { z } from "zod";

const grantSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["owner", "runner", "viewer"]),
  login: z.string(),
  enabled: z.boolean(),
  environmentStatus: z.enum(["allocated", "provisioning", "ready", "failed"]),
});
const accessSchema = z.object({
  projectId: z.string(),
  revision: z.number().int().positive(),
  appliedRevision: z.number().int().positive().nullable(),
  grants: z.array(grantSchema),
  pendingOperationId: z.string().uuid().nullable(),
});
const operationSchema = z.object({
  operationId: z.string().uuid(),
  projectId: z.string(),
  revision: z.number().int().positive(),
  phase: z.enum(["preparing", "draining", "applying", "releasing", "complete"]),
  participantCount: z.number().int().nonnegative(),
});
const changeSchema = z.discriminatedUnion("changed", [
  z.object({
    changed: z.literal(false),
    revision: z.number().int().positive(),
    operationId: z.null(),
    phase: z.null(),
  }),
  z.object({
    changed: z.literal(true),
    revision: z.number().int().positive(),
    operationId: z.string().uuid(),
    phase: operationSchema.shape.phase,
  }),
]);
const roleInput = z
  .object({
    role: z.enum(["runner", "viewer"]).nullable(),
    expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export function createControlPlaneProjectRoleClient(
  request: (
    path: string,
    method: string,
    body?: object,
    signal?: AbortSignal,
  ) => Promise<unknown>,
) {
  const base = (projectId: string) =>
    `/control-plane/admin/projects/${encodeURIComponent(projectId)}/access`;
  return {
    async list(projectId: string, signal?: AbortSignal) {
      return accessSchema.parse(
        await request(base(projectId), "GET", undefined, signal),
      );
    },
    async set(
      projectId: string,
      userId: string,
      input: z.input<typeof roleInput>,
      signal?: AbortSignal,
    ) {
      return changeSchema.parse(
        await request(
          `${base(projectId)}/${encodeURIComponent(userId)}`,
          "PUT",
          roleInput.parse(input),
          signal,
        ),
      );
    },
    async operation(
      projectId: string,
      operationId: string,
      signal?: AbortSignal,
    ) {
      return operationSchema.parse(
        await request(
          `${base(projectId)}/maintenance/${encodeURIComponent(operationId)}`,
          "GET",
          undefined,
          signal,
        ),
      );
    },
  };
}
