import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DEFAULT_MODELS } from "./src/models.js";
export default async function plugin(bb: BbPluginApi) {
  bb.providers.register({
    id: "qwen-server",
    displayName: "Qwen Server",
    icon: "Server",
    strings: {
      signInHint: "Configure the registered user's Qwen HOME on the server.",
      expiredHint: "Renew authentication for the registered server user.",
      installUrl: "https://qwenlm.github.io/qwen-code-docs/",
    },
    maintenance: { health: false, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: ["none"],
    },
    reasoningLevels: [{ id: "none", label: "Qwen default" }],
    composerActions: [],
    completedTurnDisplay: "flat",
    models: { fallback: DEFAULT_MODELS, scope: "workspace" },
    experimental_bridgeOptions: {},
    env: {
      passthrough: [
        "QWEN_SERVER_CONTEXT_SOCKET",
        "QWEN_SERVER_BASE_URL",
        "NEURALDEAP_KEY",
      ],
    },
    deriveProviderOptions: () => ({}),
  });
}
