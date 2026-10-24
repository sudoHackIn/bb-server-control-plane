import type { AuthType } from "@qwen-code/sdk";
import type { BridgeExecutionOptions } from "@get-bb/plugin-sdk/provider-bridge";
import { DEFAULT_MODEL } from "./models.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
export const AUTH_TYPES = [
  "openai",
  "openai-responses",
  "anthropic",
  "qwen-oauth",
  "gemini",
  "vertex-ai",
] as const satisfies readonly AuthType[];
export function isAuthType(value: unknown): value is AuthType {
  return typeof value === "string" && AUTH_TYPES.some((type) => type === value);
}
export function backendOptions(
  options: BridgeExecutionOptions,
  hostEnv: NodeJS.ProcessEnv = process.env,
) {
  const provider = options.providerOptions ?? {};
  const env = { ...options.envVars };
  if (provider.preferIpv4 === true) {
    env.NODE_OPTIONS = [
      env.NODE_OPTIONS ?? hostEnv.NODE_OPTIONS,
      "--dns-result-order=ipv4first",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (provider.baseUrl) {
    if (typeof provider.baseUrl !== "string")
      throw new Error("API base URL must be a string");
    const url = new URL(provider.baseUrl);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "API base URL must be HTTP(S) without credentials, query or fragment",
      );
    }
    env.OPENAI_BASE_URL = provider.baseUrl;
    const name = provider.apiKeyEnv || "OPENAI_API_KEY";
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error("API key environment variable name is invalid");
    }
    const key = options.envVars?.[name] ?? hostEnv[name];
    if (!key)
      throw new Error(
        `API key environment variable ${name} is missing on the execution host`,
      );
    env.OPENAI_API_KEY = key;
    env[name] = key;
  }
  const configuredModel =
    typeof provider.model === "string" && provider.model.trim()
      ? provider.model.trim()
      : undefined;
  const model =
    options.model && options.model !== DEFAULT_MODEL
      ? options.model
      : configuredModel;
  return { env, ...(model ? { model } : {}) };
}
export async function readShellKey(name: string): Promise<string> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error("API key environment variable name is invalid");
  if (process.platform !== "darwin")
    throw new Error("Shell key lookup currently supports macOS zsh only");
  const { stdout } = await promisify(execFile)(
    "/bin/zsh",
    [
      "-f",
      "-c",
      `source "$HOME/.zshrc" >/dev/null 2>&1; printf '%s' "$${name}"`,
    ],
    { timeout: 5000, maxBuffer: 65536, encoding: "utf8" },
  );
  return stdout;
}
export async function backendOptionsForHost(
  options: BridgeExecutionOptions,
  resolveShellKey: (name: string) => Promise<string> = readShellKey,
  hostEnv: NodeJS.ProcessEnv = process.env,
) {
  const provider = options.providerOptions ?? {};
  const name = provider.apiKeyEnv || "OPENAI_API_KEY";
  if (
    provider.baseUrl &&
    provider.apiKeyFromShell === true &&
    typeof name === "string" &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !options.envVars?.[name] &&
    !hostEnv[name]
  ) {
    const value = await resolveShellKey(name);
    return backendOptions(options, { ...hostEnv, [name]: value });
  }
  return backendOptions(options, hostEnv);
}
