import { z } from "zod";
import {
  controlPlaneDiagnosticGrantSchema,
  controlPlaneDiagnosticGrantInputSchema,
  controlPlaneInspectionPageSchema,
} from "@bb/domain";
import { createControlPlaneWorkflowClient } from "./control-plane-workflows.js";
import { createControlPlaneThreadClient } from "./control-plane-threads.js";

type Request = (
  path: string,
  method: string,
  body?: object,
  signal?: AbortSignal,
) => Promise<unknown>;
type RequestResponse = (
  path: string,
  method: string,
  body?: object,
  signal?: AbortSignal,
) => Promise<Response>;
export function createControlPlaneInspectionClient(
  request: Request,
  response: RequestResponse,
  mode: "user" | "admin",
) {
  const base = `/control-plane/${mode}/inspections`;
  const readonly: Request = (path, method, body, signal) => {
    if (method !== "GET") throw new Error("Inspection is read-only");
    return request(path, method, body, signal);
  };
  const workflow = createControlPlaneWorkflowClient(
    readonly,
    `${base}/workflows`,
  );
  const workflows = {
    inspect: workflow.inspect,
    inspectCall: workflow.inspectCall,
    trace: workflow.trace,
    result: workflow.result,
  };
  function threads(base: string) {
    const native = createControlPlaneThreadClient(readonly, response, base);
    return {
      get: native.get,
      events: native.events,
      timeline: native.timeline,
      olderTimeline: native.olderTimeline,
      timelineDetails: native.timelineDetails,
      stream: native.stream,
      result: native.result,
    };
  }
  return {
    async list(
      projectId: string,
      options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
    ) {
      const query = new URLSearchParams({ projectId });
      if (options.cursor !== undefined) query.set("cursor", options.cursor);
      if (options.limit !== undefined)
        query.set("limit", String(options.limit));
      return controlPlaneInspectionPageSchema.parse(
        await request(`${base}?${query}`, "GET", undefined, options.signal),
      );
    },
    workflows,
    forWorkflow: (id: string) => ({
      workflows,
      threads: threads(`${base}/workflows/${encodeURIComponent(id)}/threads`),
    }),
    threads: threads(`${base}/threads`),
  };
}
export function createControlPlaneDiagnosticGrantClient(request: Request) {
  const path = (project: string, user?: string) =>
    `/control-plane/admin/projects/${encodeURIComponent(project)}/diagnostics${user === undefined ? "" : `/${encodeURIComponent(user)}`}`;
  return {
    async list(
      project: string,
      options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
    ) {
      const query = new URLSearchParams();
      if (options.cursor !== undefined) query.set("cursor", options.cursor);
      if (options.limit !== undefined)
        query.set("limit", String(options.limit));
      return z
        .object({
          grants: controlPlaneDiagnosticGrantSchema.array(),
          nextCursor: z.string().nullable(),
        })
        .strict()
        .parse(
          await request(
            `${path(project)}${query.size ? `?${query}` : ""}`,
            "GET",
            undefined,
            options.signal,
          ),
        );
    },
    async get(project: string, user: string, signal?: AbortSignal) {
      return z
        .object({ grant: controlPlaneDiagnosticGrantSchema.nullable() })
        .strict()
        .parse(await request(path(project, user), "GET", undefined, signal));
    },
    async set(
      project: string,
      user: string,
      input: z.infer<typeof controlPlaneDiagnosticGrantInputSchema>,
      signal?: AbortSignal,
    ) {
      return z
        .object({ ok: z.literal(true) })
        .strict()
        .parse(
          await request(
            path(project, user),
            "PUT",
            controlPlaneDiagnosticGrantInputSchema.parse(input),
            signal,
          ),
        );
    },
  };
}
