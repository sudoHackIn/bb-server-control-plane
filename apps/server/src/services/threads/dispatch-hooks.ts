import { withControlPlaneDispatchRead } from "../../control-plane/sdk-dispatch-read.js";
import { listRunningThreadsWithIntendedHosts } from "./dispatch-attempt.js";
import { getEnvironment } from "@bb/db";
import {
  QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH,
  type Environment,
  type Host,
  type Project,
  type PromptInput,
  type Thread,
  type StartedOnBehalfOf,
  type ThreadCreateOrigin,
  type ThreadQueuedMessage,
  type ThreadTurnInitiator,
} from "@bb/domain";
import { sliceUtf16Head } from "@bb/text-utils";
import type {
  ExecutionInputFieldSource,
  ThreadResponse,
} from "@bb/server-contract";
import type {
  MessageDispatchHookContext,
  PluginDispatchAttemptKind,
  PluginDispatchEnvironmentIntent,
  PluginDispatchExecution,
  PluginDispatchExecutionSources,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { toEnvironmentResponse } from "../environments/environment-response.js";
import { getNonDestroyedHostWithStatus } from "../lib/entity-lookup.js";
import { pluginHookProvider } from "../plugins/plugin-hook-registry.js";

type DispatchHookDeps = Pick<AppDeps, "db" | "hub">;

export type DispatchAttemptKind = PluginDispatchAttemptKind;

const messageDispatchHookDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("proceed") }),
  z.object({
    action: z.literal("wait"),
    reason: z.string().min(1).max(QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH),
    sendAt: z.number().int().nonnegative().nullable().optional(),
  }),
  z.object({ action: z.literal("reject"), message: z.string().min(1) }),
]);

export interface MessageDispatchWaitDecision {
  pluginId: string;
  reason: string;
  sendAt: number | null;
}

export type MessageDispatchHookPassOutcome =
  | { kind: "proceed" }
  | {
      kind: "wait";
      waiter: MessageDispatchWaitDecision;
      additionalWaiters: readonly MessageDispatchWaitDecision[];
    };

export interface MessageDispatchHookPassRequest {
  thread: Thread;
  threadResponse: ThreadResponse;
  project: Project;
  environmentId: string | null;
  intendedHostId: string | null;
  environmentIntent: PluginDispatchEnvironmentIntent | null;
  input: PromptInput[];
  requestedExecution: PluginDispatchExecution;
  executionSources: PluginDispatchExecutionSources;
  attempt: DispatchAttemptKind;
  initiator: ThreadTurnInitiator;
  senderThreadId: string | null;
  origin: ThreadCreateOrigin | null;
  originPluginId: string | null;
  startedOnBehalfOf: StartedOnBehalfOf | null;
  parentThreadId: string | null;
  queuedMessages: ThreadQueuedMessage[];
  pluginSubmission: MessageDispatchHookContext["experimental_submission"];
  continueAfterHooks?: () => Promise<void>;
}

const DISPATCH_REQUEUE_MIN_INTERVAL_MS = 1_000;

const lastRequeuedAtByThreadId = new Map<string, number>();

export function noteDispatchRequeued(threadId: string): void {
  const now = Date.now();
  for (const [id, at] of lastRequeuedAtByThreadId) {
    if (now - at >= DISPATCH_REQUEUE_MIN_INTERVAL_MS) {
      lastRequeuedAtByThreadId.delete(id);
    }
  }
  lastRequeuedAtByThreadId.set(threadId, now);
}

export function isDispatchRequeuedRecently(threadId: string): boolean {
  const at = lastRequeuedAtByThreadId.get(threadId);
  return at !== undefined && Date.now() - at < DISPATCH_REQUEUE_MIN_INTERVAL_MS;
}

export function hasMessageDispatchHooks(): boolean {
  const provider = pluginHookProvider();
  return (
    provider !== undefined && provider.listHooks("message.dispatch").length > 0
  );
}

let evaluationLock: Promise<unknown> = Promise.resolve();

function withEvaluationLock<T>(run: () => Promise<T>): Promise<T> {
  const result = evaluationLock.then(run, run);
  evaluationLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function messageDispatchHookFailure(
  pluginId: string,
  detail: string,
): ApiError {
  return new ApiError(
    502,
    "dispatch_hook_failed",
    `The "${pluginId}" plugin's message.dispatch hook failed: ${detail}`,
    { details: { pluginId } },
  );
}

function dispatchRejection(pluginId: string, message: string): ApiError {
  return new ApiError(409, "dispatch_rejected", message, {
    details: { pluginId },
  });
}

export async function decideWithinBox<T>(
  run: () => Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run().then(
        (value) => ({ ok: true, value }) as const,
        (error: unknown) =>
          ({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }) as const,
      ),
      new Promise<{ ok: false; error: string }>((resolveTimeout) => {
        timer = setTimeout(
          () =>
            resolveTimeout({
              ok: false,
              error: `did not decide within ${timeoutMs}ms`,
            }),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function dispatchEnvironmentAndHost(
  deps: Pick<AppDeps, "db" | "hub">,
  environmentId: string | null,
): { environment: Environment | null; host: Host | null } {
  if (environmentId === null) return { environment: null, host: null };
  const environment = getEnvironment(deps.db, environmentId);
  if (environment === null) return { environment: null, host: null };
  return {
    environment: toEnvironmentResponse(deps.db, environment),
    host: getNonDestroyedHostWithStatus(deps, environment.hostId),
  };
}

export function dispatchInputText(input: readonly PromptInput[]): string {
  return input
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

interface DroppedFromContractStillEmitted {
  startedOnBehalfOf: StartedOnBehalfOf | null;
  queuedMessage: ThreadQueuedMessage | null;
}

function summarizeDispatchProvenance(
  request: MessageDispatchHookPassRequest,
): Pick<
  MessageDispatchHookContext,
  "initiator" | "senderThreadId" | "origin" | "originPluginId"
> {
  const [first, ...rest] = request.queuedMessages;
  if (first === undefined) {
    return {
      initiator: request.initiator,
      senderThreadId: request.senderThreadId,
      origin: request.origin,
      originPluginId: request.originPluginId,
    };
  }
  return {
    origin: rest.every((message) => message.origin === first.origin)
      ? first.origin
      : "mixed",
    originPluginId: rest.every(
      (message) => message.originPluginId === first.originPluginId,
    )
      ? first.originPluginId
      : "mixed",
    initiator: rest.every((message) => message.initiator === first.initiator)
      ? first.initiator
      : "mixed",
    senderThreadId: rest.every(
      (message) => message.senderThreadId === first.senderThreadId,
    )
      ? first.senderThreadId
      : "mixed",
  };
}

function buildHookContext(
  deps: DispatchHookDeps,
  request: MessageDispatchHookPassRequest,
): MessageDispatchHookContext {
  const { environment, host } = dispatchEnvironmentAndHost(
    deps,
    request.environmentId,
  );
  const droppedFromContractStillEmitted: DroppedFromContractStillEmitted = {
    startedOnBehalfOf: request.startedOnBehalfOf,
    queuedMessage: request.queuedMessages[0] ?? null,
  };
  return {
    ...droppedFromContractStillEmitted,
    ...summarizeDispatchProvenance(request),
    thread: request.threadResponse,
    attempt: request.attempt,
    project: request.project,
    environment,
    host:
      host ??
      (request.intendedHostId === null
        ? null
        : getNonDestroyedHostWithStatus(deps, request.intendedHostId)),
    environmentIntent: request.environmentIntent,
    input: {
      blocks: [...request.input],
      text: dispatchInputText(request.input),
    },
    requestedExecution: { ...request.requestedExecution },
    executionSources: { ...request.executionSources },
    parentThreadId: request.parentThreadId,
    queuedMessages: request.queuedMessages,
    experimental_submission: request.pluginSubmission,
  };
}

export async function runMessageDispatchHookPass(
  deps: DispatchHookDeps,
  request: MessageDispatchHookPassRequest,
): Promise<MessageDispatchHookPassOutcome> {
  const provider = pluginHookProvider();
  if (provider === undefined) {
    return { kind: "proceed" };
  }
  const hooks = provider.listHooks("message.dispatch");
  if (hooks.length === 0) {
    return { kind: "proceed" };
  }

  return withEvaluationLock(async () => {
    const context = buildHookContext(deps, request);
    const waits: MessageDispatchWaitDecision[] = [];

    for (const hook of hooks) {
      const invocation = await provider.invokeHook(
        hook.pluginId,
        "message.dispatch hook",
        () =>
          decideWithinBox(
            async () =>
              withControlPlaneDispatchRead(
                {
                  db: deps.db,
                  threadId: request.thread.id,
                  pluginId: hook.pluginId,
                  running: () =>
                    Response.json(listRunningThreadsWithIntendedHosts(deps)),
                },
                () => hook.handler(context),
              ),
            provider.decisionTimeoutMs,
          ),
      );
      if (!invocation.ok) {
        throw messageDispatchHookFailure(hook.pluginId, invocation.error);
      }
      if (!invocation.value.ok) {
        throw messageDispatchHookFailure(hook.pluginId, invocation.value.error);
      }
      const parsed = messageDispatchHookDecisionSchema.safeParse(
        invocation.value.value,
      );
      if (!parsed.success) {
        throw messageDispatchHookFailure(
          hook.pluginId,
          `returned an invalid decision: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")} ${issue.message}`)
            .join("; ")}`,
        );
      }
      const decision = parsed.data;
      if (decision.action === "reject") {
        throw dispatchRejection(hook.pluginId, decision.message);
      }
      if (decision.action === "wait") {
        waits.push({
          pluginId: hook.pluginId,
          reason: decision.reason,
          sendAt: decision.sendAt ?? null,
        });
        continue;
      }
    }

    const waiter = waits[0];
    if (waiter === undefined) {
      await request.continueAfterHooks?.();
      return { kind: "proceed" };
    }
    return { kind: "wait", waiter, additionalWaiters: waits.slice(1) };
  });
}

export function dispatchWaitReasonForPass(
  outcome: Extract<MessageDispatchHookPassOutcome, { kind: "wait" }>,
): string {
  const extra = outcome.additionalWaiters
    .map((entry) => `${entry.pluginId}: ${entry.reason}`)
    .join("; ");
  const reason =
    extra.length === 0
      ? outcome.waiter.reason
      : `${outcome.waiter.reason} (also waiting on ${extra})`;
  return reason.length > QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH
    ? `${sliceUtf16Head(reason, QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH - 1)}…`
    : reason;
}

export function dispatchExecutionSources(args: {
  model?: ExecutionInputFieldSource;
  permissionMode?: ExecutionInputFieldSource;
  providerId?: ExecutionInputFieldSource;
  reasoningLevel?: ExecutionInputFieldSource;
  serviceTier?: ExecutionInputFieldSource;
}): PluginDispatchExecutionSources {
  return {
    providerId: args.providerId ?? null,
    model: args.model ?? null,
    reasoningLevel: args.reasoningLevel ?? null,
    serviceTier: args.serviceTier ?? null,
    permissionMode: args.permissionMode ?? null,
  };
}
