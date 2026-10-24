import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  pendingInteractionResolutionSchema,
  isApprovalPendingInteractionResolution,
  experimental_toolPresentation as toolPresentation,
  type ApprovalPendingInteractionPayload,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { NativeApproval } from "./approval-transport.js";
import { toolDisplay } from "./tool-items.js";

async function canonicalTarget(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      return null;
    const parent = dirname(path);
    if (parent === path) return null;
    const canonical = await canonicalTarget(parent);
    return canonical ? resolve(canonical, relative(parent, path)) : null;
  }
}

export async function approvalPayload(
  request: NativeApproval,
  cwd: string,
): Promise<ApprovalPendingInteractionPayload | null> {
  const { toolName: name, toolUseId: itemId, input } = request;
  const decisions = ["allow_once", "deny"] as const;
  const base = {
    kind: "approval" as const,
    reason: null,
    availableDecisions: [...decisions],
  };
  if (
    name === "run_shell_command" &&
    typeof input.command === "string" &&
    input.command.trim()
  )
    return {
      ...base,
      subject: {
        kind: "command",
        itemId,
        command: input.command,
        cwd,
        actions: [],
        sessionGrant: null,
      },
    };
  if (name === "write_file" || name === "edit") {
    const path =
      typeof input.file_path === "string" ? input.file_path : input.path;
    if (typeof path !== "string" || !path || path.length > 4096) return null;
    const target = resolve(cwd, path);
    const [root, canonical] = await Promise.all([
      canonicalTarget(cwd),
      canonicalTarget(target),
    ]);
    if (
      !request.blockedPath &&
      root &&
      canonical &&
      (canonical === root || canonical.startsWith(root + sep))
    )
      return {
        ...base,
        subject: {
          kind: "file_change",
          itemId,
          writeScope: canonical,
          sessionGrant: null,
        },
      };
  }
  const display = toolDisplay(name, input, cwd);
  return {
    ...base,
    subject: {
      kind: "tool_use",
      itemId,
      tool: name,
      presentation: display.presentation ?? toolPresentation(name),
    },
  };
}

export function createApprovalRequests(
  send: (request: {
    jsonrpc: "2.0";
    id: string;
    method: "interaction/request";
    params: {
      threadId: string;
      providerThreadId: string;
      turnId: string;
      providerNativeIds: true;
      payload: ApprovalPendingInteractionPayload;
    };
  }) => void,
) {
  const pending = new Map<
    string,
    { scope: object; finish(allowed: boolean): void }
  >();
  return {
    request(
      scope: object,
      args: {
        threadId: string;
        providerThreadId: string;
        turnId: string;
        signal: AbortSignal;
        payload: ApprovalPendingInteractionPayload;
      },
    ): Promise<boolean> {
      if (args.signal.aborted) return Promise.resolve(false);
      const id = `qwen-approval-${randomUUID()}`;
      return new Promise((resolve) => {
        const finish = (allowed: boolean) => {
          if (!pending.delete(id)) return;
          args.signal.removeEventListener("abort", abort);
          resolve(allowed);
        };
        const abort = () => finish(false);
        pending.set(id, { scope, finish });
        args.signal.addEventListener("abort", abort, { once: true });
        try {
          send({
            jsonrpc: "2.0",
            id,
            method: "interaction/request",
            params: {
              threadId: args.threadId,
              providerThreadId: args.providerThreadId,
              turnId: args.turnId,
              providerNativeIds: true,
              payload: args.payload,
            },
          });
        } catch {
          finish(false);
        }
      });
    },
    handle(response: { id: string | number; result?: unknown }) {
      const entry = pending.get(String(response.id));
      if (!entry) return false;
      const parsed = pendingInteractionResolutionSchema.safeParse(
        response.result,
      );
      entry.finish(
        parsed.success &&
          isApprovalPendingInteractionResolution(parsed.data) &&
          parsed.data.decision === "allow_once" &&
          parsed.data.grantedPermissions === null,
      );
      return true;
    },
    cancel(scope: object) {
      for (const entry of pending.values())
        if (entry.scope === scope) entry.finish(false);
    },
  };
}
