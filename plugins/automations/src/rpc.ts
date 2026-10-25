import {
  automationDetailReadResultSchema,
  managedAutomationReadResultSchema,
  automationDetailResponseSchema,
  automationListResponseSchema,
  automationResponseSchema,
  automationRunListResponseSchema,
  automationRunRpcResponseSchema,
  automationRunResponseSchema,
  automationRunsInputSchema,
  automationsOverviewResponseSchema,
  createAutomationInputSchema,
  listAutomationsInputSchema,
  projectAutomationInputSchema,
  runAutomationInputSchema,
  updateAutomationInputSchema,
} from "./rpc-types.js";
import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { AutomationService } from "./service.js";

export const automationRpcContract = defineRpcContract({
  controlPlaneAutomationResult: {
    input: projectAutomationInputSchema.extend({
      runId: z.string().min(1).max(200),
    }),
    output: z
      .object({
        run: automationRunResponseSchema,
        cleanupError: z.string().max(8192).nullable(),
      })
      .strict(),
  },
  controlPlaneAutomationReads: {
    input: z
      .object({ ids: z.array(z.string().min(1).max(200)).max(50) })
      .strict(),
    output: z.array(managedAutomationReadResultSchema).max(50),
  },
  controlPlaneAutomationUpdate: {
    input: updateAutomationInputSchema.safeExtend({
      expectedRevision: z.number().int().min(1),
    }),
    output: automationDetailResponseSchema,
  },
  controlPlaneAutomationStop: {
    input: projectAutomationInputSchema.extend({
      runId: z.string().min(1).max(200),
    }),
    output: z.object({ stopped: z.boolean() }).strict(),
  },
  automations_overview: {
    input: z.null(),
    output: automationsOverviewResponseSchema,
  },
  automations_list: {
    input: listAutomationsInputSchema,
    output: automationListResponseSchema,
  },
  automations_get: {
    input: projectAutomationInputSchema,
    output: automationDetailReadResultSchema,
  },
  automations_create: {
    input: createAutomationInputSchema,
    output: automationDetailResponseSchema,
  },
  automations_update: {
    input: updateAutomationInputSchema,
    output: automationDetailResponseSchema,
  },
  automations_delete: {
    input: projectAutomationInputSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  automations_pause: {
    input: projectAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_resume: {
    input: projectAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_run: {
    input: runAutomationInputSchema,
    output: automationRunRpcResponseSchema,
  },
  automations_runs: {
    input: automationRunsInputSchema,
    output: automationRunListResponseSchema,
  },
});

export function createRpcHandlers(service: AutomationService) {
  return {
    controlPlaneAutomationResult(input: {
      projectId: string;
      automationId: string;
      runId: string;
    }) {
      if (!service.managedResult)
        throw new Error("Managed script result unavailable");
      return service.managedResult(input);
    },
    controlPlaneAutomationReads(input: { ids: string[] }) {
      if (!service.managedRead)
        throw new Error("Managed automation reads are unavailable");
      return service.managedRead(input.ids);
    },
    controlPlaneAutomationUpdate(
      input: z.output<
        typeof automationRpcContract.controlPlaneAutomationUpdate.input
      >,
    ) {
      if (!service.managedRead)
        throw new Error("Managed automation updates are unavailable");
      return service.update(input);
    },
    controlPlaneAutomationStop(input: {
      projectId: string;
      automationId: string;
      runId: string;
    }) {
      if (!service.managedStop)
        throw new Error("Managed automation stop is unavailable");
      return service.managedStop(input);
    },
    automations_overview() {
      return service.overview();
    },
    automations_list(input: z.output<typeof listAutomationsInputSchema>) {
      return service.list(input);
    },
    automations_get(input: z.output<typeof projectAutomationInputSchema>) {
      return service.get(input);
    },
    automations_create(input: z.output<typeof createAutomationInputSchema>) {
      return service.create(input);
    },
    automations_update(input: z.output<typeof updateAutomationInputSchema>) {
      return service.update(input);
    },
    automations_delete(input: z.output<typeof projectAutomationInputSchema>) {
      return service.delete(input);
    },
    automations_pause(input: z.output<typeof projectAutomationInputSchema>) {
      return service.pause(input);
    },
    automations_resume(input: z.output<typeof projectAutomationInputSchema>) {
      return service.resume(input);
    },
    automations_run(input: z.output<typeof runAutomationInputSchema>) {
      return service.run(input);
    },
    automations_runs(input: z.output<typeof automationRunsInputSchema>) {
      return service.runs(input);
    },
  };
}
