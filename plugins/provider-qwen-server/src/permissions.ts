import type { BridgeExecutionOptions } from "@get-bb/plugin-sdk/provider-bridge";

export function validatePermissionMode(options: BridgeExecutionOptions) {
  if (options.permissionMode !== "full")
    throw new Error(
      "Qwen Server supports Full access only, isolated by its registered Unix UID",
    );
}
