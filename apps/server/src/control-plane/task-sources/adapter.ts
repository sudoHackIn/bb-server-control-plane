import { z } from "zod";
import { controlPlaneAgentRunStartSchema } from "@bb/domain";
export const taskSourceBatchSchema = z
  .object({
    checkpoint: z.string().max(4096),
    tasks: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            title: z.string().min(1).max(500),
            input: controlPlaneAgentRunStartSchema.shape.input,
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export interface TaskSourceAdapter {
  kind: string;
  poll(context: {
    sourceId: string;
    userId: string;
    projectId: string;
    checkpoint: string | null;
    signal: AbortSignal;
    run: (source: string) => Promise<string>;
  }): Promise<z.infer<typeof taskSourceBatchSchema>>;
}
