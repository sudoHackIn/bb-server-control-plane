import { createContext, useContext } from "react";
import type { PendingInteraction } from "@bb/domain";
import type { ResolvePendingInteractionRequest } from "@bb/server-contract";

export interface ThreadInteractionSource {
  resolve(input: {
    threadId: string;
    interactionId: string;
    resolution: ResolvePendingInteractionRequest;
  }): Promise<PendingInteraction>;
  stop(threadId: string): Promise<void>;
}
export const ThreadInteractionSourceContext =
  createContext<ThreadInteractionSource | null>(null);
export function useThreadInteractionSource() {
  return useContext(ThreadInteractionSourceContext);
}
