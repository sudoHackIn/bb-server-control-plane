import type { AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";
import type { SDKUserMessage } from "@qwen-code/sdk";
export const DEFAULT_MODEL = "qwen-configured-default";
export const DEFAULT_MODELS: AvailableModel[] = [
  {
    id: DEFAULT_MODEL,
    model: DEFAULT_MODEL,
    displayName: "Qwen configured model",
    description:
      "Uses the model and authentication configured in Qwen Code on this host.",
    isDefault: true,
    defaultReasoningEffort: "none",
    supportedReasoningEfforts: [
      {
        reasoningEffort: "none",
        label: "Qwen default",
        description: "Keep the backend's configured reasoning behavior.",
      },
    ],
  },
];
export async function* controlProbeInput(
  signal: AbortSignal,
): AsyncGenerator<SDKUserMessage> {
  await new Promise<never>((_resolve, reject) => {
    const aborted = () => reject(new Error("Qwen model probe closed"));
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
}
export function modelsFromQwen(
  response: Record<string, unknown> | null,
  configuredModel?: string,
): AvailableModel[] {
  if (!response || !Array.isArray(response.models))
    throw new Error("Qwen returned an invalid model catalog");
  const seen = new Set<string>();
  const models: AvailableModel[] = [];
  for (const value of response.models.slice(0, 500)) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      !item.id.trim() ||
      item.id.length > 512 ||
      /[\x00-\x1f]/.test(item.id) ||
      seen.has(item.id)
    )
      continue;
    seen.add(item.id);
    models.push({
      ...DEFAULT_MODELS[0],
      id: item.id,
      model: item.id,
      displayName:
        typeof item.label === "string" && item.label.trim()
          ? item.label.slice(0, 512)
          : item.id,
      description: "Available in Qwen Code",
      isDefault: item.id === configuredModel,
    });
  }
  if (models.length === 0) return DEFAULT_MODELS;
  if (configuredModel && !seen.has(configuredModel))
    return [...DEFAULT_MODELS, ...models];
  if (!models.some((model) => model.isDefault)) models[0].isDefault = true;
  return models;
}
