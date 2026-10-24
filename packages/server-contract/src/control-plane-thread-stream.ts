import { z } from "zod";
import { threadChangedMessageSchema, threadEventRowSchema } from "@bb/domain";
import { threadTimelineSignalSchema } from "./api/threads.js";

export const controlPlaneThreadRealtimeSchema = z.union([
  threadChangedMessageSchema.extend({ id: z.string() }),
  threadTimelineSignalSchema,
]);
export const controlPlaneThreadStreamMessageSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("event"), event: threadEventRowSchema }),
    z.object({
      kind: z.literal("realtime"),
      message: controlPlaneThreadRealtimeSchema,
    }),
    z.object({
      kind: z.literal("ready"),
      cursor: z.number().int().nonnegative(),
    }),
  ],
);
export type ControlPlaneThreadStreamMessage = z.infer<
  typeof controlPlaneThreadStreamMessageSchema
>;
