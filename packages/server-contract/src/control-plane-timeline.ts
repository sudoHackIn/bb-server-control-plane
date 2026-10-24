import { z } from "zod";

const sequence = z.coerce
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const cursor = z.string().min(1).max(16384);
export const controlPlaneTimelinePageSchema = z
  .object({
    beforeAnchorId: cursor.optional(),
    beforeAnchorSeq: sequence.optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.beforeAnchorId === undefined) ===
      (value.beforeAnchorSeq === undefined),
    "Cursor fields must be supplied together",
  );
export const controlPlaneTimelineDetailsSchema = z
  .object({
    turnId: z.string().min(1).max(1000),
    sourceSeqStart: sequence,
    sourceSeqEnd: sequence,
    itemId: z.string().min(1).max(1000).optional(),
    beforeCursor: cursor.optional(),
  })
  .strict()
  .refine(
    (value) => value.sourceSeqStart <= value.sourceSeqEnd,
    "Invalid sequence range",
  );
export type ControlPlaneTimelineDetails = z.infer<
  typeof controlPlaneTimelineDetailsSchema
>;
