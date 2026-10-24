import { z } from "zod";
import {
  approvalPendingInteractionResolutionSchema,
  userQuestionPendingInteractionResolutionSchema,
} from "./pending-interactions.js";
import { threadStatusSchema } from "./thread-status.js";

const message = z
  .string()
  .min(1)
  .max(131072)
  .refine((value) => value.trim().length > 0, "Message is empty");
export const controlPlaneThreadStartSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    profileVersionId: z.string().uuid(),
    message,
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export const controlPlaneThreadSendSchema = z
  .object({
    message,
    mode: z.literal("queue-if-active").default("queue-if-active"),
  })
  .strict();
export const controlPlaneThreadSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  profileVersionId: z.string().uuid().nullable(),
  title: z.string().nullable(),
  status: threadStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  archived: z.boolean(),
});
export type ControlPlaneThreadStart = z.infer<
  typeof controlPlaneThreadStartSchema
>;
export type ControlPlaneThreadSend = z.infer<
  typeof controlPlaneThreadSendSchema
>;

export const controlPlaneThreadResolutionSchema = z.union([
  approvalPendingInteractionResolutionSchema,
  userQuestionPendingInteractionResolutionSchema,
]);
