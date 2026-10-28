import { assertExecutionAdmission } from "../services/system/execution-admission.js";
import { createControlPlaneThreadStreams } from "./thread-stream.js";
import { createThreadTimelineWindows } from "../services/threads/thread-timeline-windows.js";
import {
  resolveThreadCompletedTurnDisplay,
  resolveThreadProviderDisplayName,
} from "../services/threads/thread-timeline-windows.js";
import { buildTimelineTurnSummaryDetails } from "../services/threads/timeline.js";
import {
  getAppSettings,
  controlPlaneThreads,
  getControlPlaneAgentRunByKey,
  listControlPlaneAgentRuns,
  isSqliteUniqueConstraintOnColumns,
} from "@bb/db";
import { createHash } from "node:crypto";
import type {
  ControlPlaneTimelineDetails,
  TimelinePaginationCursor,
} from "@bb/server-contract";
import {
  ControlPlaneThreadError,
  requireControlPlaneJobDispatch,
  controlPlaneProfileVersions,
  environments,
  getControlPlaneProject,
  getControlPlaneProfile,
  getControlPlaneThread,
  getThread,
  getLatestThreadSequence,
  listControlPlaneThreads,
  requireControlPlaneThreadDispatch,
} from "@bb/db";
import { and, eq } from "drizzle-orm";
import type {
  ControlPlaneThreadStart,
  ControlPlaneThreadSend,
  ControlPlaneAgentRunStart,
} from "@bb/domain";
import { CONTROL_PLANE_WORKFLOWS_PLUGIN_ID } from "@bb/domain";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { withControlPlaneEnvironmentRead } from "./sdk-environment-read.js";
import { withControlPlaneUser } from "./access.js";
import { createThreadFromRequest } from "../services/threads/thread-create.js";
import { acceptThreadSendRequest } from "../services/threads/thread-send-request.js";
import { stopThreadForCurrentState } from "../services/threads/thread-lifecycle.js";
import {
  getLastThreadOutput,
  listThreadEventRows,
} from "../services/threads/thread-data.js";
import { resolveThreadHostCommandEnvironment } from "../services/threads/thread-command-environment.js";

export function createControlPlaneThreadService({ deps }: { deps: AppDeps }) {
  const streams = createControlPlaneThreadStreams(deps.hub);
  const windows = createThreadTimelineWindows(deps);
  function snapshot(userId: string, id: string) {
    const { thread } = read(userId, id);
    return {
      type: "thread-timeline" as const,
      target: {
        kind: "thread-timeline" as const,
        threadId: id,
        segmentLimit: 20,
        deferContent: true,
      },
      afterSequence: null,
      timeline: windows.read(
        thread,
        {
          deferContent: true,
          includeNestedRows: false,
          page: { kind: "latest", segmentLimit: 20 },
          summaryOnly: false,
        },
        undefined,
      ),
    };
  }
  function events(
    userId: string,
    id: string,
    options: { after: number; limit: number },
  ) {
    read(userId, id);
    const rows = listThreadEventRows(deps.db, {
      threadId: id,
      afterSeq: options.after,
      order: "asc",
      limit: options.limit + 1,
    });
    const selected = rows.slice(0, options.limit);
    return {
      events: selected,
      cursor: selected.at(-1)?.seq ?? options.after,
      hasMore: rows.length > options.limit,
      maxSequence: getLatestThreadSequence(deps.db, { threadId: id }),
    };
  }
  function read(userId: string, id: string) {
    const row = getControlPlaneThread(deps.db, userId, id);
    const thread = row ? getThread(deps.db, id) : null;
    if (!row || !thread)
      throw new ApiError(404, "thread_not_found", "Thread not found");
    return { row, thread };
  }
  function executable(userId: string, id: string) {
    const value = read(userId, id);
    assertExecutionAdmission(deps.db);
    const context = requireControlPlaneThreadDispatch(deps.db, id);
    if (context?.user.id !== userId) throw new ControlPlaneThreadError();
    return { thread: value.thread, context };
  }
  function get(userId: string, id: string) {
    const { row } = read(userId, id);
    return {
      id: row.id,
      projectId: row.projectId,
      profileVersionId: row.profileVersionId,
      title: row.title,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archived: row.archivedAt !== null,
    };
  }
  function run(userId: string, id: string) {
    const { row } = read(userId, id);
    const binding = deps.db
      .select()
      .from(controlPlaneThreads)
      .where(eq(controlPlaneThreads.threadId, id))
      .get();
    if (binding?.runSource !== "manual" || !row.profileVersionId)
      throw new ApiError(404, "run_not_found", "Run not found");
    const version = deps.db
      .select({ profileId: controlPlaneProfileVersions.profileId })
      .from(controlPlaneProfileVersions)
      .where(eq(controlPlaneProfileVersions.id, row.profileVersionId))
      .get();
    if (!version) throw new ApiError(404, "run_not_found", "Run not found");
    return {
      runId: id,
      threadId: id,
      projectId: row.projectId,
      profileId: version.profileId,
      profileVersionId: row.profileVersionId,
      source: "manual" as const,
      title: row.title,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  return {
    close: () => streams.close(),
    get,
    run,
    listRuns(
      userId: string,
      options: { projectId?: string; cursor: string | null; limit: number },
    ) {
      if (
        options.projectId &&
        !getControlPlaneProject(deps.db, userId, options.projectId)
      )
        throw new ApiError(404, "project_not_found", "Project not found");
      return listControlPlaneAgentRuns(deps.db, userId, options);
    },
    async startRun(userId: string, input: ControlPlaneAgentRunStart) {
      const digest = createHash("sha256")
        .update(
          JSON.stringify({
            projectId: input.projectId,
            profileVersionId: input.profileVersionId,
            input: input.input,
            source: input.source,
          }),
        )
        .digest("hex");
      const existing = () =>
        getControlPlaneAgentRunByKey(deps.db, userId, input.idempotencyKey);
      const resolveExisting = () => {
        const found = existing();
        if (!found) return null;
        if (found.inputDigest !== digest)
          throw new ApiError(
            409,
            "idempotency_conflict",
            "Idempotency key was used for another request",
          );
        return run(userId, found.threadId);
      };
      const previous = resolveExisting();
      if (previous) return previous;
      try {
        const thread = await this.start(
          userId,
          {
            projectId: input.projectId,
            profileVersionId: input.profileVersionId,
            message: input.input,
            title: input.input.trim().slice(0, 120),
          },
          null,
          {
            source: "manual",
            idempotencyKey: input.idempotencyKey,
            inputDigest: digest,
          },
        );
        return run(userId, thread.id);
      } catch (error) {
        if (
          error instanceof Error &&
          isSqliteUniqueConstraintOnColumns(error, {
            tableName: "control_plane_threads",
            columnNames: ["owner_user_id", "run_idempotency_key"],
            indexName: "control_plane_threads_run_key_idx",
          })
        ) {
          const previous = resolveExisting();
          if (previous) return previous;
        }
        throw error;
      }
    },
    profile(userId: string, id: string) {
      const { row } = read(userId, id);
      const version = row.profileVersionId
        ? deps.db
            .select()
            .from(controlPlaneProfileVersions)
            .where(eq(controlPlaneProfileVersions.id, row.profileVersionId))
            .get()
        : null;
      const profile = version
        ? getControlPlaneProfile(deps.db, userId, version.profileId, version.id)
        : null;
      if (!profile)
        throw new ApiError(404, "profile_not_found", "Profile not found");
      return profile;
    },
    list(
      userId: string,
      options: { projectId?: string; cursor: string | null; limit: number },
    ) {
      if (
        options.projectId &&
        !getControlPlaneProject(deps.db, userId, options.projectId)
      )
        throw new ApiError(404, "project_not_found", "Project not found");
      return listControlPlaneThreads(deps.db, userId, options);
    },
    async start(
      userId: string,
      input: ControlPlaneThreadStart,
      worker: { bindingId: string; callId: string } | null = null,
      manualRun: {
        source: "manual";
        idempotencyKey: string;
        inputDigest: string;
      } | null = null,
    ) {
      assertExecutionAdmission(deps.db);
      const job = worker
        ? requireControlPlaneJobDispatch(deps.db, worker.bindingId)
        : null;
      if (
        job &&
        ((job.binding.kind !== "workflow-worker" &&
          job.binding.kind !== "automation-worker") ||
          job.user.id !== userId ||
          job.project.projectId !== input.projectId ||
          job.profileVersion.id !== input.profileVersionId ||
          job.binding.originThreadId === null)
      )
        throw new ControlPlaneThreadError();
      const parent = job?.binding.sourceBindingId
        ? requireControlPlaneJobDispatch(deps.db, job.binding.sourceBindingId)
        : null;
      const originThreadId = job?.binding.originThreadId;
      const jobOrigin =
        job && originThreadId
          ? requireControlPlaneThreadDispatch(deps.db, originThreadId)
          : null;
      if (
        job &&
        (!parent || !originThreadId || !jobOrigin?.thread.environmentId)
      )
        throw new ControlPlaneThreadError();
      const project = getControlPlaneProject(deps.db, userId, input.projectId);
      if (!project || !["owner", "runner"].includes(project.role))
        throw new ApiError(404, "project_not_found", "Project not found");
      const version = deps.db
        .select()
        .from(controlPlaneProfileVersions)
        .where(eq(controlPlaneProfileVersions.id, input.profileVersionId))
        .get();
      const profile = version
        ? getControlPlaneProfile(deps.db, userId, version.profileId, version.id)
        : null;
      if (!profile)
        throw new ApiError(404, "profile_not_found", "Profile not found");
      const environment = deps.db
        .select()
        .from(environments)
        .where(
          and(
            eq(environments.projectId, project.projectId),
            jobOrigin?.thread.environmentId
              ? eq(environments.id, jobOrigin.thread.environmentId)
              : undefined,
            eq(environments.hostId, project.hostId),
            eq(environments.path, project.cwd),
            eq(environments.status, "ready"),
          ),
        )
        .get();
      const thread = await withControlPlaneUser(userId, () =>
        withControlPlaneEnvironmentRead(
          {
            db: deps.db,
            userId,
            projectId: project.projectId,
            hostId: project.hostId,
            cwd: project.cwd,
          },
          () =>
            createThreadFromRequest(deps, {
              projectId: project.projectId,
              providerId: profile.version.definition.providerId,
              controlPlaneProfileVersionId: profile.version.id,
              ...(manualRun
                ? { controlPlaneRun: manualRun, visibility: "hidden" as const }
                : {}),
              ...(job && worker && parent && originThreadId
                ? {
                    controlPlaneJobBindingId: job.binding.id,
                    originPluginId:
                      job.binding.kind === "workflow-worker"
                        ? CONTROL_PLANE_WORKFLOWS_PLUGIN_ID
                        : "automations",
                    lifecycleOwnerThreadId: originThreadId,
                    parentThreadId: originThreadId,
                    visibility: "hidden" as const,
                    parentNotifications: "off" as const,
                    pluginMetadata: {
                      ...(job.binding.kind === "workflow-worker"
                        ? { workflowWorker: 1 }
                        : { automationWorker: 1 }),
                      runId: parent.binding.objectId,
                      callId: worker.callId,
                      originThreadId,
                    },
                  }
                : {}),
              environment: environment
                ? { type: "reuse", environmentId: environment.id }
                : {
                    type: "host",
                    hostId: project.hostId,
                    workspace: { type: "unmanaged", path: project.cwd },
                  },
              model: profile.version.definition.model,
              reasoningLevel: profile.version.definition.reasoningLevel,
              permissionMode: profile.version.definition.permissionMode,
              title: input.title,
              input: [{ type: "text", text: input.message, mentions: [] }],
              origin: job ? "plugin" : "sdk",
              startedOnBehalfOf: null,
            }),
        ),
      );
      return get(userId, thread.id);
    },
    async send(userId: string, id: string, input: ControlPlaneThreadSend) {
      read(userId, id);
      const binding = deps.db
        .select({ runSource: controlPlaneThreads.runSource })
        .from(controlPlaneThreads)
        .where(eq(controlPlaneThreads.threadId, id))
        .get();
      if (binding?.runSource === "manual")
        throw new ApiError(
          409,
          "run_is_not_chat",
          "Background runs do not accept chat messages",
        );
      const { thread, context } = executable(userId, id);
      const response = await withControlPlaneUser(userId, () =>
        acceptThreadSendRequest(deps, {
          thread,
          payload: {
            input: [{ type: "text", text: input.message, mentions: [] }],
            mode: input.mode,
            model: context.profileVersion.definition.model,
            permissionMode: context.profileVersion.definition.permissionMode,
            reasoningLevel: context.profileVersion.definition.reasoningLevel,
          },
        }),
      );
      return { ok: true as const, delivery: response.delivery };
    },
    async stop(userId: string, id: string) {
      const { thread } = read(userId, id);
      const environment = resolveThreadHostCommandEnvironment({
        db: deps.db,
        thread,
      });
      await withControlPlaneUser(userId, () =>
        stopThreadForCurrentState(deps, thread, environment),
      );
      return { ok: true as const };
    },
    events,
    timeline(userId: string, id: string) {
      return snapshot(userId, id).timeline;
    },
    olderTimeline(
      userId: string,
      id: string,
      beforeCursor: TimelinePaginationCursor,
    ) {
      const { thread } = read(userId, id);
      return windows.read(
        thread,
        {
          deferContent: true,
          includeNestedRows: false,
          page: { kind: "older", beforeCursor, segmentLimit: 20 },
          summaryOnly: false,
        },
        undefined,
      );
    },
    timelineDetails(
      userId: string,
      id: string,
      input: ControlPlaneTimelineDetails,
    ) {
      const { thread } = read(userId, id);
      const settings = getAppSettings(deps.db);
      return buildTimelineTurnSummaryDetails(deps.db, thread, {
        ...input,
        itemId: input.itemId ?? null,
        deferContent: true,
        completedTurnDisplay: resolveThreadCompletedTurnDisplay(
          deps,
          settings,
          thread.providerId,
        ),
        includeDiagnosticOperations: settings.showDiagnosticEvents,
        summarizeShellCommands: settings.summarizeShellCommands,
        providerDisplayName: resolveThreadProviderDisplayName(
          deps,
          thread.providerId,
        ),
      });
    },
    stream(
      userId: string,
      id: string,
      options: {
        after: number;
        signal: AbortSignal;
        authorized: () => boolean;
      },
    ) {
      read(userId, id);
      return streams.open({
        userId,
        threadId: id,
        ...options,
        authorized: () => {
          read(userId, id);
          return options.authorized();
        },
        events: (after) => events(userId, id, { after, limit: 32 }),
        snapshot: () => snapshot(userId, id),
      });
    },
    result(userId: string, id: string) {
      const thread = get(userId, id);
      return { thread, text: getLastThreadOutput(deps.db, id) };
    },
    interactions(userId: string, id: string) {
      read(userId, id);
      return deps.pendingInteractions.listPendingThreadInteractions(id);
    },
    resolve(
      userId: string,
      id: string,
      interactionId: string,
      resolution: Parameters<
        AppDeps["pendingInteractions"]["resolvePendingInteraction"]
      >[0]["resolution"],
    ) {
      executable(userId, id);
      return withControlPlaneUser(userId, () =>
        deps.pendingInteractions.resolvePendingInteraction({
          threadId: id,
          interactionId,
          resolution,
        }),
      );
    },
  };
}
export type ControlPlaneThreadService = ReturnType<
  typeof createControlPlaneThreadService
>;
