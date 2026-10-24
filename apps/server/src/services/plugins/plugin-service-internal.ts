import type { TunnelIngressLease } from "../connect-next/tunnel-ingress.js";
import type { EnvironmentRemoval } from "@bb/domain";
import type { MachineEnrollmentService } from "../machines/machine-services.js";
import type { AiServiceRegistry } from "../ai/ai-service-registry.js";
import type { DbConnection, HostRow } from "@bb/db";
import type {
  DynamicTool,
  PendingInteraction,
  Thread,
  ThreadQueuedMessage,
} from "@bb/domain";
import type {
  HostDaemonConnectTunnelIdentity,
  HostDaemonContributedEnvEntry,
} from "@bb/host-daemon-contract";
import type {
  PluginApplyUpdateResult,
  PluginRuntimeStatus,
} from "@bb/server-contract";
import type { ServerLogger } from "../../types.js";
import type { TelemetryService } from "../system/telemetry.js";
import type { NotificationHub } from "../../ws/hub.js";
import type {
  BundledPluginRegistration,
  RetiredBundledPlugin,
} from "./builtin-registry.js";
import type { PluginManifest } from "./manifest.js";
import type {
  PluginApiHandle,
  PluginBackgroundServiceRecord,
  PluginMentionTrigger,
} from "./plugin-api.js";
import type { HostSharedPortCoordinator } from "../../ws/host-shared-ports.js";
import type { ProviderRegistryService } from "../providers/provider-registry.js";
import type { PluginHostArtifactRegistry } from "./plugin-host-artifact-registry.js";

type PluginServiceState = "running" | "backoff" | "stopped";

export interface ServiceRuntime {
  record: PluginBackgroundServiceRecord;
  state: PluginServiceState;
  controller: AbortController | null;
  current: Promise<void> | null;
  restartTimer: NodeJS.Timeout | null;
  consecutiveCrashes: number;
  startedAt: number;
  disposed: boolean;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  handle: PluginApiHandle;
  services: ServiceRuntime[];
  moduleRootUrls: Set<string>;
}

export interface PluginHostArtifactSnapshot {
  path: string;
  byteLength: number;
  digest: string;
  generation: string;
}

export interface PluginServiceDeps {
  machineEnrollments?: MachineEnrollmentService;
  db: DbConnection;
  sharedPorts?: Pick<
    HostSharedPortCoordinator,
    | "declareSharedPorts"
    | "validateSharedPortDeclaration"
    | "replaceDeclarationsForOwner"
    | "clearDeclarationsForOwner"
    | "setNextTunnelConfig"
    | "listNextTunnelStatuses"
    | "onNextTunnelStatusChange"
  >;
  ensureSharedPortTunnel?: (
    hostId: string,
  ) => Promise<HostDaemonConnectTunnelIdentity>;
  providerRegistry?: ProviderRegistryService;
  pluginHostArtifacts?: PluginHostArtifactRegistry;
  aiServices: AiServiceRegistry;
  onSettingsChanged?: (pluginId: string) => void;
  onPluginUnregistered?: (pluginId: string) => void;
  requestQueueDrain?: () => void;
  hub: Pick<
    NotificationHub,
    | "getDaemonSessionIdForHost"
    | "notifyPluginSignal"
    | "notifySystem"
    | "notifyPluginChanged"
    | "onWatchedTargets"
  >;
  logger: ServerLogger;
  telemetry: TelemetryService;
  pendingInteractions?: Pick<
    import("../interactions/pending-interactions.js").PendingInteractionLifecycle,
    | "requestPluginInteraction"
    | "interruptPluginInteractions"
    | "setPluginDirectory"
  >;
  getBackgroundJobs?: (
    pluginId: string,
    builtin: boolean,
  ) => import("@get-bb/plugin-sdk").PluginServerApi["internal_DO_NOT_USE_backgroundJobs"];
  getAppUrl?: () => string | null;
  dataDir: string;
  appVersion: string;
  bundledPlugins?: readonly BundledPluginRegistration[];
  retiredBundledPlugins?: readonly RetiredBundledPlugin[];
  watchBuiltinPluginSources?: boolean;
  loadTimeoutMs?: number;
  installHandlerTimeoutMs?: number;
  serviceStopTimeoutMs?: number;
  serviceRestartBaseMs?: number;
  mentionSearchTimeoutMs?: number;
  mentionResolveTimeoutMs?: number;
  providerEnvResolveTimeoutMs?: number;
  stabilizationWindowMs?: number;
  artifactRetentionMs?: number;
  now?: () => number;
  scheduleStabilizationWindow?: (
    durationMs: number,
    onElapsed: () => void,
  ) => () => void;
  scheduleUpdateCheck?: (
    delayMs: number,
    onElapsed: () => Promise<void>,
  ) => () => void;
  afterPluginRollbackStateRestored?: (args: {
    pluginId: string;
    snapshotId: string;
  }) => Promise<void>;
  afterArtifactPromoted?: (args: {
    pluginId: string;
    artifactId: string;
    path: string;
  }) => Promise<void>;
  onArtifactMaterialize?: (args: { path: string }) => void;
  callPluginHost?: (args: {
    pluginId: string;
    contract: import("@get-bb/plugin-sdk").PluginRpcContract;
    method: string;
    input: unknown;
    hostId: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    artifact: PluginHostArtifactSnapshot;
  }) => Promise<unknown>;
  disposePluginHost?: (args: {
    pluginId: string;
    generation: string;
  }) => Promise<void>;
  openTunnelIngress?: (audience: string) => Promise<TunnelIngressLease>;
}

export interface PluginAgentToolContribution {
  pluginId: string;
  tool: DynamicTool;
  instructions: string | null;
}

export interface PluginInstructionContribution {
  pluginId: string;
  provider: (ctx: { threadId: string; projectId: string }) => string | null;
}

export interface PluginResolvedAgentConfiguration {
  tools: PluginAgentToolContribution[];
  selectedSkillIdsByPlugin: ReadonlyMap<string, ReadonlySet<string>>;
  dynamicInstructions: Array<{ pluginId: string; text: string }>;
}

export interface PluginResolvedProviderEnv {
  entries: HostDaemonContributedEnvEntry[];
}

export interface PluginResolvedProviderEnvHealth {
  label: string;
  statusMessage: string;
}

export interface PluginMentionProviderContribution {
  pluginId: string;
  id: string;
  label: string;
  triggers: readonly PluginMentionTrigger[];
}

export interface PluginMentionSearchItem {
  itemId: string;
  title: string;
  subtitle: string | null;
  icon: string | null;
}

export interface PluginMentionSearchGroup {
  pluginId: string;
  providerId: string;
  label: string;
  items: PluginMentionSearchItem[];
}

export type PluginMentionResolveResult =
  | {
      ok: true;
      context: string;
      images: Array<
        | { type: "image"; url: string; context?: string }
        | { type: "localImage"; path: string; context?: string }
      >;
    }
  | { ok: false; error: string };

export interface PluginThreadEventEmitter {
  emitEnvironmentRemoved(removal: EnvironmentRemoval): void;
  emitThreadEvents(threadId: string): void;
  emitTerminalInput(
    terminal: import("@bb/server-contract").TerminalSession,
  ): void;
  emitHostDeleted(host: HostRow): void;
  emitThreadCreated(thread: Thread): void;
  emitThreadActive(thread: Thread): void;
  emitThreadIdle(thread: Thread): void;
  emitThreadFailed(thread: Thread): void;
  emitThreadArchived(thread: Thread): void;
  emitThreadUnarchived(thread: Thread): void;
  emitThreadParentChanged(
    thread: Thread,
    previousParentThreadId: string | null,
  ): void;
  emitThreadDeleted(thread: Thread): void;
  emitInteractionPending(thread: Thread, interaction: PendingInteraction): void;
  emitMessageQueued(entry: ThreadQueuedMessage): void;
  emitMessageDispatched(entry: ThreadQueuedMessage): void;
  emitMessageCancelled(entry: ThreadQueuedMessage): void;
  emitTurnFailed(threadId: string): void;
}

export type PluginWireLookup<T> =
  | { outcome: "unknown-plugin" }
  | {
      outcome: "not-running";
      status: PluginRuntimeStatus;
      detail: string | null;
    }
  | { outcome: "not-found" }
  | { outcome: "found"; value: T };

export type PluginApplyUpdateOutcome =
  | { ok: true; result: PluginApplyUpdateResult }
  | { ok: false; error: string };
