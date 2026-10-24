import { z } from "zod";
import type { PermissionMode } from "@get-bb/plugin-sdk/provider-bridge";

const permissionRequest = z.object({
  type: z.literal("control_request"),
  request_id: z.string().min(1).max(200),
  request: z.object({
    subtype: z.literal("can_use_tool"),
    tool_name: z.string().min(1).max(200),
    tool_use_id: z.string().min(1).max(200),
    input: z.record(z.string(), z.unknown()),
    blocked_path: z.string().nullable().optional(),
  }),
});
const cancellation = z.object({
  type: z.literal("control_cancel_request"),
  request_id: z.string(),
});
export type NativeApproval = {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  blockedPath: string | null;
  signal: AbortSignal;
};
export type ApprovalAdapter = {
  mode: PermissionMode;
  request(request: NativeApproval): Promise<boolean>;
};

export function createApprovalTransport({
  request,
  write,
  timeoutMs = 300000,
}: {
  request(value: NativeApproval): Promise<boolean>;
  write(value: object): void;
  timeoutMs?: number;
}) {
  const pending = new Map<string, AbortController>();
  function deny(id: string) {
    write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: id,
        response: {
          behavior: "deny",
          message: "Tool approval was denied or is unavailable",
        },
      },
    });
  }
  return {
    handle(value: unknown) {
      const cancelled = cancellation.safeParse(value);
      if (cancelled.success && pending.has(cancelled.data.request_id)) {
        pending.get(cancelled.data.request_id)?.abort();
        return true;
      }
      const parsed = permissionRequest.safeParse(value);
      if (!parsed.success) return false;
      const { request_id: id, request: payload } = parsed.data;
      if (pending.has(id)) throw new Error("Duplicate native approval request");
      if (pending.size >= 64) {
        deny(id);
        return true;
      }
      const controller = new AbortController();
      pending.set(id, controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const aborted = new Promise<boolean>((resolve) =>
        controller.signal.addEventListener("abort", () => resolve(false), {
          once: true,
        }),
      );
      void (async () => {
        let allowed = false;
        try {
          allowed = await Promise.race([
            request({
              toolName: payload.tool_name,
              toolUseId: payload.tool_use_id,
              input: payload.input,
              blockedPath: payload.blocked_path ?? null,
              signal: controller.signal,
            }),
            aborted,
          ]);
        } catch {
        } finally {
          clearTimeout(timer);
          pending.delete(id);
        }
        try {
          if (!allowed || controller.signal.aborted) deny(id);
          else
            write({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: id,
                response: { behavior: "allow", updatedInput: payload.input },
              },
            });
        } catch {}
      })();
      return true;
    },
    cancel() {
      for (const controller of pending.values()) controller.abort();
    },
  };
}
