import type {
  InternalDoNotUseBackgroundJobs,
  InternalDoNotUseBackgroundJobBinding,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  controlPlaneJobBindingSchema,
  controlPlaneJobListSchema,
} from "@bb/domain";
import {
  controlPlaneThreads,
  createControlPlaneJobBinding,
  getControlPlaneJobBinding,
  getControlPlaneProjectOwner,
  getControlPlaneProject,
  requireControlPlaneThreadDispatch,
  requireControlPlaneThreadOwner,
  listControlPlaneJobBindings,
  setControlPlaneJobEnabled,
  deleteControlPlaneJobBinding,
  type DbConnection,
} from "@bb/db";
import { ApiError } from "../errors.js";
import {
  currentControlPlanePrincipal,
  hasActiveControlPlaneAdministrativeRequest,
} from "./access.js";
import {
  BUILTIN_WORKFLOWS_PLUGIN_ID,
  BUILTIN_AUTOMATIONS_PLUGIN_ID,
} from "../services/plugins/builtin-registry.js";
import { evaluateControlPlaneWorkflow } from "./workflow-evaluator.js";
import { withControlPlaneJobAuthority } from "./job-authority.js";

function denied(): never {
  throw new ApiError(
    403,
    "job_not_authorized",
    "Background execution is not authorized",
  );
}
export function createControlPlaneBackgroundJobs(
  db: DbConnection,
  pluginId: string,
  builtin: boolean,
  workers: Pick<
    InternalDoNotUseBackgroundJobs,
    | "startWorker"
    | "getWorker"
    | "sendWorker"
    | "notifyOrigin"
    | "stopWorker"
    | "archiveWorker"
    | "releaseWorker"
    | "listWorkers"
  > | null = null,
): InternalDoNotUseBackgroundJobs {
  const kinds: InternalDoNotUseBackgroundJobBinding["kind"][] =
    pluginId === BUILTIN_WORKFLOWS_PLUGIN_ID
      ? ["workflow-definition", "workflow-run", "workflow-worker"]
      : pluginId === BUILTIN_AUTOMATIONS_PLUGIN_ID
        ? ["automation", "automation-run", "automation-worker", "schedule"]
        : [];
  if (!builtin || kinds.length === 0) return denied();
  function read(id: string) {
    const principal = currentControlPlanePrincipal();
    const job = getControlPlaneJobBinding(
      db,
      principal?.kind === "user" ? principal.userId : null,
      id,
    );
    return job && kinds.includes(job.kind) ? job : null;
  }
  function required(id: string) {
    const job = read(id);
    if (!job) return denied();
    return job;
  }
  return {
    get userId() {
      const principal = currentControlPlanePrincipal();
      return principal?.kind === "user" ? principal.userId : null;
    },
    canReadProject(projectId) {
      const principal = currentControlPlanePrincipal();
      return (
        principal?.kind !== "user" ||
        getControlPlaneProject(db, principal.userId, projectId) !== undefined
      );
    },
    readOrigin(threadId) {
      const principal = currentControlPlanePrincipal();
      if (
        principal?.kind !== "user" &&
        !hasActiveControlPlaneAdministrativeRequest()
      )
        return denied();
      const context = requireControlPlaneThreadDispatch(db, threadId);
      if (
        !context ||
        (principal?.kind === "user" && principal.userId !== context.user.id) ||
        context.thread.environmentId === null
      )
        return denied();
      return {
        projectId: context.project.projectId,
        environmentId: context.thread.environmentId,
        providerId: context.profileVersion.definition.providerId,
        model: context.profileVersion.definition.model,
        reasoningLevel: context.profileVersion.definition.reasoningLevel,
        permissionMode: context.profileVersion.definition.permissionMode,
      };
    },
    async bind(input) {
      const parsed = controlPlaneJobBindingSchema
        .omit({ userId: true })
        .extend({ profileVersionId: z.string().uuid().nullable() })
        .parse(input);
      const principal = currentControlPlanePrincipal();
      const userId =
        principal?.kind === "user"
          ? principal.userId
          : principal?.kind === "admin" &&
              hasActiveControlPlaneAdministrativeRequest()
            ? getControlPlaneProjectOwner(db, parsed.projectId)?.ownerUserId
            : undefined;
      if (!userId || !kinds.includes(parsed.kind)) return denied();
      const profileVersionId =
        parsed.profileVersionId ??
        (parsed.originThreadId
          ? db
              .select()
              .from(controlPlaneThreads)
              .where(eq(controlPlaneThreads.threadId, parsed.originThreadId))
              .get()?.profileVersionId
          : null);
      if (!profileVersionId) return denied();
      return createControlPlaneJobBinding(db, {
        ...parsed,
        profileVersionId,
        userId,
      });
    },
    get(id) {
      return read(id);
    },
    list(input) {
      const options = controlPlaneJobListSchema.parse(input);
      if (!options.kind || !kinds.includes(options.kind)) return denied();
      const principal = currentControlPlanePrincipal();
      return listControlPlaneJobBindings(
        db,
        principal?.kind === "user" ? principal.userId : null,
        options,
      );
    },
    async setEnabled(id, enabled) {
      const job = required(id);
      if (typeof enabled !== "boolean") return denied();
      const principal = currentControlPlanePrincipal();
      if (
        enabled &&
        principal?.kind !== "user" &&
        !hasActiveControlPlaneAdministrativeRequest()
      )
        return denied();
      const updated = setControlPlaneJobEnabled(
        db,
        principal?.kind === "user" ? job.ownerUserId : null,
        id,
        enabled,
      );
      if (!updated) return denied();
      return updated;
    },
    async remove(id) {
      const job = required(id);
      deleteControlPlaneJobBinding(
        db,
        currentControlPlanePrincipal()?.kind === "user"
          ? job.ownerUserId
          : null,
        id,
      );
    },
    listWorkers(input) {
      if (!workers) return denied();
      return workers.listWorkers(input);
    },
    resolveWorkerProfile(id, profileVersionId) {
      if (
        required(id).kind !==
        (pluginId === BUILTIN_WORKFLOWS_PLUGIN_ID
          ? "workflow-run"
          : "automation-run")
      )
        return denied();
      const versionId = z.string().uuid().nullable().parse(profileVersionId);
      return withControlPlaneJobAuthority(db, id, (parent) => {
        const context = requireControlPlaneThreadOwner(db, {
          projectId: parent.binding.projectId,
          ownerUserId: parent.user.id,
          profileVersionId: versionId ?? parent.binding.profileVersionId,
          providerId: "qwen-server",
          relatedThreadIds: [parent.binding.originThreadId],
        });
        if (!context) return denied();
        const definition = context.profileVersion.definition;
        return {
          profileVersionId: context.profileVersion.id,
          providerId: definition.providerId,
          model: definition.model,
          reasoningLevel: definition.reasoningLevel,
          permissionMode: definition.permissionMode,
        };
      });
    },
    startWorker(id, input, signal) {
      if (
        required(id).kind !==
          (pluginId === BUILTIN_WORKFLOWS_PLUGIN_ID
            ? "workflow-run"
            : "automation-run") ||
        !workers
      )
        return denied();
      return workers.startWorker(id, input, signal);
    },
    getWorker(id, threadId) {
      if (
        required(id).kind !==
          (pluginId === BUILTIN_WORKFLOWS_PLUGIN_ID
            ? "workflow-run"
            : "automation-run") ||
        !workers
      )
        return denied();
      return workers.getWorker(id, threadId);
    },
    notifyOrigin(id, message) {
      if (
        pluginId !== BUILTIN_WORKFLOWS_PLUGIN_ID ||
        required(id).kind !==
          (pluginId === BUILTIN_WORKFLOWS_PLUGIN_ID
            ? "workflow-run"
            : "automation-run") ||
        !workers
      )
        return denied();
      return workers.notifyOrigin(id, message);
    },
    sendWorker(id, threadId, message) {
      if (
        required(id).kind !==
          (pluginId === BUILTIN_WORKFLOWS_PLUGIN_ID
            ? "workflow-run"
            : "automation-run") ||
        !workers
      )
        return denied();
      return workers.sendWorker(id, threadId, message);
    },
    stopWorker(id, threadId) {
      if (
        required(id).kind !==
          (pluginId === BUILTIN_WORKFLOWS_PLUGIN_ID
            ? "workflow-run"
            : "automation-run") ||
        !workers
      )
        return denied();
      return workers.stopWorker(id, threadId);
    },
    releaseWorker(id, threadId, completedSequence) {
      if (
        required(id).kind !==
          (pluginId === BUILTIN_WORKFLOWS_PLUGIN_ID
            ? "workflow-run"
            : "automation-run") ||
        !workers
      )
        return denied();
      return workers.releaseWorker(
        id,
        threadId,
        z.number().int().nonnegative().parse(completedSequence),
      );
    },
    archiveWorker(id, threadId) {
      if (
        required(id).kind !==
          (pluginId === BUILTIN_WORKFLOWS_PLUGIN_ID
            ? "workflow-run"
            : "automation-run") ||
        !workers
      )
        return denied();
      return workers.archiveWorker(id, threadId);
    },
    async evaluateWorkflow(id, input, signal, onEvent, onAgent) {
      const binding = required(id);
      if (binding.kind !== "workflow-run") return denied();
      return withControlPlaneJobAuthority(db, id, (context) =>
        evaluateControlPlaneWorkflow(
          context,
          input,
          signal,
          (event) => {
            withControlPlaneJobAuthority(db, id, () => onEvent(event));
          },
          () => {
            withControlPlaneJobAuthority(db, id, () => undefined);
          },
          onAgent
            ? (prompt, options, callSignal) =>
                withControlPlaneJobAuthority(db, id, () =>
                  onAgent(prompt, options, callSignal),
                )
            : undefined,
        ),
      );
    },
    withAuthority(id, run) {
      required(id);
      return withControlPlaneJobAuthority(db, id, (context) =>
        run(context.binding),
      );
    },
  };
}
