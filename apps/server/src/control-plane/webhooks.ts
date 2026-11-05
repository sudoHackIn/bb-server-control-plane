import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import {
  controlPlaneWebhooks as hooks,
  controlPlaneWebhookDeliveries as deliveries,
  requireControlPlaneThreadOwner,
  getControlPlaneProject,
  type DbConnection,
} from "@bb/db";
import {
  controlPlaneWebhookCreateSchema,
  controlPlaneWebhookSchema,
  controlPlaneWebhookDeliverySchema,
  controlPlaneAgentRunStartSchema,
} from "@bb/domain";
import { ApiError } from "../errors.js";
import { withControlPlaneUser } from "./access.js";
import type { ControlPlaneAgentWorkflowService } from "./agent-workflows.js";

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const keySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/u);
const payloadSchema = z.record(z.string(), z.unknown());
type Hook = typeof hooks.$inferSelect;
export function createControlPlaneWebhookService(
  db: DbConnection,
  agents: Pick<ControlPlaneAgentWorkflowService, "start">,
) {
  const active = new Map<string, Promise<ReturnType<typeof viewDelivery>>>();
  function view(row: Hook) {
    return controlPlaneWebhookSchema.parse({
      id: row.id,
      projectId: row.projectId,
      profileVersionId: row.profileVersionId,
      name: row.name,
      inputField: row.inputField,
      enabled: row.enabled,
      createdAt: row.createdAt,
      deliveryPath: `/control-plane/webhooks/${row.id}/deliver`,
    });
  }
  function viewDelivery(row: typeof deliveries.$inferSelect) {
    return controlPlaneWebhookDeliverySchema.parse({
      id: row.id,
      webhookId: row.webhookId,
      deliveryKey: row.deliveryKey,
      state: row.state,
      runId: row.runId,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
  function owned(userId: string, id: string) {
    const row = db
      .select()
      .from(hooks)
      .where(and(eq(hooks.id, id), eq(hooks.ownerUserId, userId)))
      .get();
    if (!row || !getControlPlaneProject(db, userId, row.projectId))
      throw new ApiError(404, "webhook_not_found", "Webhook not found");
    return row;
  }
  function authority(
    userId: string,
    projectId: string,
    profileVersionId: string,
  ) {
    const value = requireControlPlaneThreadOwner(db, {
      projectId,
      ownerUserId: userId,
      profileVersionId,
      providerId: "qwen-server",
      relatedThreadIds: [],
    });
    if (!value)
      throw new ApiError(
        403,
        "execution_not_authorized",
        "Execution not authorized",
      );
  }
  function authenticated(id: string, authorization: string | undefined) {
    const token = /^Bearer whk_[A-Za-z0-9_-]{43}$/u.test(authorization ?? "")
      ? authorization?.slice(7)
      : undefined;
    const row = db.select().from(hooks).where(eq(hooks.id, id)).get();
    if (
      !row ||
      !token ||
      !timingSafeEqual(
        Buffer.from(digest(token), "hex"),
        Buffer.from(row.secretHash, "hex"),
      )
    )
      throw new ApiError(
        401,
        "invalid_webhook_credentials",
        "Invalid webhook credentials",
      );
    if (!row.enabled)
      throw new ApiError(409, "webhook_disabled", "Webhook disabled");
    return row;
  }
  async function execute(
    row: Hook,
    saved: typeof deliveries.$inferSelect,
    raw: string,
  ) {
    try {
      const current = db.select().from(hooks).where(eq(hooks.id, row.id)).get();
      if (!current?.enabled || current.secretHash !== row.secretHash)
        throw new Error("Webhook changed before admission");
      authority(row.ownerUserId, row.projectId, row.profileVersionId);
      if (saved.state === "accepted") return viewDelivery(saved);
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
      const parsed = payloadSchema.safeParse(payload);
      const input = controlPlaneAgentRunStartSchema.shape.input.safeParse(
        parsed.success ? parsed.data[row.inputField] : undefined,
      );
      if (!input.success)
        throw new ApiError(
          422,
          "invalid_webhook_input",
          "Selected field must contain task text",
        );
      const run = await withControlPlaneUser(row.ownerUserId, () =>
        agents.start(row.ownerUserId, {
          projectId: row.projectId,
          profileVersionId: row.profileVersionId,
          input: input.data,
          source: "manual",
          idempotencyKey: `webhook:${saved.id}`,
        }),
      );
      return viewDelivery(
        db
          .update(deliveries)
          .set({
            state: "accepted",
            runId: run.runId,
            error: null,
            updatedAt: Date.now(),
          })
          .where(eq(deliveries.id, saved.id))
          .returning()
          .get(),
      );
    } catch (error) {
      const code =
        error instanceof ApiError && error.body.code === "invalid_webhook_input"
          ? "invalid_webhook_input"
          : "launch_not_available";
      if (saved.state === "accepted")
        throw new ApiError(
          403,
          "execution_not_authorized",
          "Execution not authorized",
        );
      return viewDelivery(
        db
          .update(deliveries)
          .set({ state: "failed", error: code, updatedAt: Date.now() })
          .where(eq(deliveries.id, saved.id))
          .returning()
          .get(),
      );
    }
  }
  return {
    create(
      userId: string,
      input: z.infer<typeof controlPlaneWebhookCreateSchema>,
    ) {
      const value = controlPlaneWebhookCreateSchema.parse(input);
      authority(userId, value.projectId, value.profileVersionId);
      const secret = `whk_${randomBytes(32).toString("base64url")}`;
      const row = db
        .insert(hooks)
        .values({
          ...value,
          id: randomUUID(),
          ownerUserId: userId,
          secretHash: digest(secret),
          enabled: true,
          createdAt: Date.now(),
        })
        .returning()
        .get();
      return { webhook: view(row), secret };
    },
    list(
      userId: string,
      options: { projectId: string; cursor?: string; limit: number },
    ) {
      if (!getControlPlaneProject(db, userId, options.projectId))
        throw new ApiError(404, "project_not_found", "Project not found");
      const rows = db
        .select()
        .from(hooks)
        .where(
          and(
            eq(hooks.ownerUserId, userId),
            eq(hooks.projectId, options.projectId),
            options.cursor ? gt(hooks.id, options.cursor) : undefined,
          ),
        )
        .orderBy(asc(hooks.id))
        .limit(options.limit + 1)
        .all();
      return {
        webhooks: rows.slice(0, options.limit).map(view),
        nextCursor:
          rows.length > options.limit ? rows[options.limit - 1].id : null,
      };
    },
    get(userId: string, id: string) {
      return view(owned(userId, id));
    },
    setEnabled(userId: string, id: string, enabled: boolean) {
      const row = owned(userId, id);
      if (enabled) authority(userId, row.projectId, row.profileVersionId);
      return view(
        db
          .update(hooks)
          .set({ enabled })
          .where(eq(hooks.id, id))
          .returning()
          .get(),
      );
    },
    rotate(userId: string, id: string) {
      owned(userId, id);
      const secret = `whk_${randomBytes(32).toString("base64url")}`;
      const row = db
        .update(hooks)
        .set({ secretHash: digest(secret) })
        .where(eq(hooks.id, id))
        .returning()
        .get();
      return { webhook: view(row), secret };
    },
    history(
      userId: string,
      id: string,
      options: { cursor?: string; limit: number },
    ) {
      owned(userId, id);
      const rows = db
        .select()
        .from(deliveries)
        .where(
          and(
            eq(deliveries.webhookId, id),
            options.cursor ? gt(deliveries.id, options.cursor) : undefined,
          ),
        )
        .orderBy(asc(deliveries.id))
        .limit(options.limit + 1)
        .all();
      return {
        deliveries: rows.slice(0, options.limit).map(viewDelivery),
        nextCursor:
          rows.length > options.limit ? rows[options.limit - 1].id : null,
      };
    },
    async deliver(
      id: string,
      authorization: string | undefined,
      deliveryKey: string | undefined,
      raw: string,
    ) {
      const row = authenticated(id, authorization);
      const key = keySchema.safeParse(deliveryKey);
      if (!key.success)
        throw new ApiError(
          400,
          "invalid_delivery_id",
          "X-BB-Delivery-ID is required",
        );
      if (Buffer.byteLength(raw) > 262144)
        throw new ApiError(413, "payload_too_large", "Payload too large");
      const payloadHash = digest(raw);
      const saved = db.transaction(
        (tx) => {
          const existing = tx
            .select()
            .from(deliveries)
            .where(
              and(
                eq(deliveries.webhookId, id),
                eq(deliveries.deliveryKey, key.data),
              ),
            )
            .get();
          if (existing) {
            if (existing.payloadHash !== payloadHash)
              throw new ApiError(
                409,
                "delivery_conflict",
                "Delivery ID belongs to another payload",
              );
            return existing;
          }
          if (active.size >= 64)
            throw new ApiError(429, "webhook_busy", "Retry delivery later");
          const now = Date.now();
          return tx
            .insert(deliveries)
            .values({
              id: randomUUID(),
              webhookId: id,
              deliveryKey: key.data,
              payloadHash,
              state: "pending",
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get();
        },
        { behavior: "immediate" },
      );
      const previous = active.get(saved.id);
      if (previous) return previous;
      if (active.size >= 64)
        throw new ApiError(429, "webhook_busy", "Retry delivery later");
      const task = withControlPlaneUser(row.ownerUserId, () =>
        execute(row, saved, raw),
      );
      active.set(saved.id, task);
      try {
        return await task;
      } finally {
        if (active.get(saved.id) === task) active.delete(saved.id);
      }
    },
  };
}
export type ControlPlaneWebhookService = ReturnType<
  typeof createControlPlaneWebhookService
>;
