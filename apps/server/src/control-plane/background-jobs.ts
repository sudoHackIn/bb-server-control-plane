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
): InternalDoNotUseBackgroundJobs {
  const kinds: InternalDoNotUseBackgroundJobBinding["kind"][] =
    pluginId === BUILTIN_WORKFLOWS_PLUGIN_ID
      ? ["workflow-definition", "workflow-run"]
      : pluginId === BUILTIN_AUTOMATIONS_PLUGIN_ID
        ? ["automation", "automation-run", "schedule"]
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
    withAuthority(id, run) {
      required(id);
      return withControlPlaneJobAuthority(db, id, (context) =>
        run(context.binding),
      );
    },
  };
}
