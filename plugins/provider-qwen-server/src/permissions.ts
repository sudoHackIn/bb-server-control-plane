import type {
  BridgeExecutionOptions,
  PermissionMode,
} from "@get-bb/plugin-sdk/provider-bridge";

export function qwenPermissionMode(mode: PermissionMode) {
  return mode === "full" ? "yolo" : mode === "auto" ? "auto" : "default";
}

export function validatePermissionMode(options: BridgeExecutionOptions) {
  if (!["accept-edits", "auto", "full"].includes(options.permissionMode))
    throw new Error("Unsupported Qwen Server permission mode");
}
