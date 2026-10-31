import { assertExecutionAdmission } from "../services/system/execution-admission.js";
import type {
  InternalDoNotUseBackgroundJobs,
  InternalDoNotUseBackgroundJobBinding,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  controlPlaneJobBindingSchema,
  controlPlaneJobListSchema,
} from "@bb/domain";
import {
  environments,
  createEnvironment,
  noopNotifier,
  type DbNotifier,
  controlPlaneThreads,
  controlPlaneUidMaintenance,
  controlPlaneJobBindings,
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
import {
  runControlPlaneAutomationScript,
  stopControlPlaneAutomationScript,
} from "./automation-script-runner.js";
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
  notifier: DbNotifier = noopNotifier,
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
    internal_DO_NOT_USE_executionPausedUserIds() {
      const principal = currentControlPlanePrincipal();
      return db
        .selectDistinct({ userId: controlPlaneUidMaintenance.userId })
        .from(controlPlaneUidMaintenance)
        .innerJoin(
          controlPlaneJobBindings,
          eq(
            controlPlaneJobBindings.ownerUserId,
            controlPlaneUidMaintenance.userId,
          ),
        )
        .where(
          and(
            ne(controlPlaneUidMaintenance.phase, "idle"),
            inArray(controlPlaneJobBindings.kind, kinds),
            isNull(controlPlaneJobBindings.deletedAt),
            principal?.kind === "user"
              ? eq(controlPlaneUidMaintenance.userId, principal.userId)
              : undefined,
          ),
        )
        .all()
        .map((row) => row.userId);
    },
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
    internal_DO_NOT_USE_workflowEnvironment(id) {
      assertExecutionAdmission(db);
      if (
        pluginId !== BUILTIN_WORKFLOWS_PLUGIN_ID ||
        required(id).kind !== "workflow-run"
      )
        return denied();
      return withControlPlaneJobAuthority(db, id, (context) => {
        const selected = db.transaction(
          (tx) => {
            const existing = tx
              .select({ id: environments.id })
              .from(environments)
              .where(
                and(
                  eq(environments.projectId, context.project.projectId),
                  eq(environments.hostId, context.project.hostId),
                  eq(environments.path, context.project.cwd),
                  eq(environments.status, "ready"),
                ),
              )
              .get();
            if (existing) return { environment: existing, created: false };
            const environment = createEnvironment(tx, noopNotifier, {
              projectId: context.project.projectId,
              hostId: context.project.hostId,
              path: context.project.cwd,
              providerOwnsPath: false,
              status: "ready",
            });
            return { environment, created: true };
          },
          { behavior: "immediate" },
        );
        const environment = selected.environment;
        if (selected.created)
          notifier.notifyEnvironment(environment.id, ["environment-created"]);
        const definition = context.profileVersion.definition;
        return {
          environmentId: environment.id,
          providerId: definition.providerId,
          model: definition.model,
          reasoningLevel: definition.reasoningLevel,
          permissionMode: definition.permissionMode,
        };
      });
    },
    async bind(input) {
      assertExecutionAdmission(db);
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
      if (parsed.originThreadId && parsed.sourceBindingId === null) {
        const origin = requireControlPlaneThreadDispatch(
          db,
          parsed.originThreadId,
        );
        if (
          !origin ||
          origin.user.id !== userId ||
          origin.project.projectId !== parsed.projectId
        )
          return denied();
      }
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
      if (enabled) assertExecutionAdmission(db);
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
    runAutomationScript(id, input, signal) {
      assertExecutionAdmission(db);
      if (
        pluginId !== BUILTIN_AUTOMATIONS_PLUGIN_ID ||
        required(id).kind !== "automation-run"
      )
        return denied();
      const parsed = z
        .object({ source: z.string(), timeoutMs: z.number() })
        .strict()
        .parse(input);
      return runControlPlaneAutomationScript(
        db,
        id,
        { ...parsed, jobId: id },
        signal,
      );
    },
    stopAutomationScript(id) {
      if (pluginId !== BUILTIN_AUTOMATIONS_PLUGIN_ID) return denied();
      return stopControlPlaneAutomationScript(db, id);
    },
    listWorkers(input) {
      if (!workers) return denied();
      return workers.listWorkers(input);
    },
    resolveWorkerProfile(id, profileVersionId) {
      const job = required(id);
      if (
        !(
          pluginId === BUILTIN_WORKFLOWS_PLUGIN_ID
            ? ["workflow-run"]
            : ["automation", "automation-run"]
        ).includes(job.kind)
      )
        return denied();
      const versionId = z.string().uuid().nullable().parse(profileVersionId);
      if (
        pluginId === BUILTIN_AUTOMATIONS_PLUGIN_ID &&
        versionId !== null &&
        versionId !== job.profileVersionId
      )
        return denied();
      const resolve = () => {
        const context = requireControlPlaneThreadOwner(db, {
          projectId: job.projectId,
          ownerUserId: job.ownerUserId,
          profileVersionId: versionId ?? job.profileVersionId,
          providerId: "qwen-server",
          relatedThreadIds:
            pluginId === BUILTIN_AUTOMATIONS_PLUGIN_ID
              ? []
              : [job.originThreadId],
        });
        if (!context || job.deletedAt !== null) return denied();
        const definition = context.profileVersion.definition;
        return {
          profileVersionId: context.profileVersion.id,
          providerId: definition.providerId,
          model: definition.model,
          reasoningLevel: definition.reasoningLevel,
          permissionMode: definition.permissionMode,
        };
      };
      return job.kind === "automation"
        ? resolve()
        : withControlPlaneJobAuthority(db, id, resolve);
    },
    startWorker(id, input, signal) {
      assertExecutionAdmission(db);
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
      assertExecutionAdmission(db);
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
      assertExecutionAdmission(db);
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
      assertExecutionAdmission(db);
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
            ? (prompt, options, callSignal, scopeId) =>
                withControlPlaneJobAuthority(db, id, () =>
                  onAgent(prompt, options, callSignal, scopeId),
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
