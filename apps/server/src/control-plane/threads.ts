import { createControlPlaneThreadStreams } from "./thread-stream.js";
import { createThreadTimelineWindows } from "../services/threads/thread-timeline-windows.js";
import {
  ControlPlaneThreadError,
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
} from "@bb/domain";
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
  return {
    close: () => streams.close(),
    get,
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
    async start(userId: string, input: ControlPlaneThreadStart) {
      const project = getControlPlaneProject(deps.db, userId, input.projectId);
      if (
        !project ||
        project.ownerUserId !== userId ||
        !["owner", "runner"].includes(project.role)
      )
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
              origin: "sdk",
              startedOnBehalfOf: null,
            }),
        ),
      );
      return get(userId, thread.id);
    },
    async send(userId: string, id: string, input: ControlPlaneThreadSend) {
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
