import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function plugin(bb: BbPluginApi) {
  bb.agents.registerTool({
    name: "approved_server_probe",
    description: "Verify delegated server context in the disposable Docker lab",
    parameters: { type: "object", properties: {} },
    async execute(_input, context) {
      let unscopedSdkDenied = false;
      try {
        await bb.sdk.projects.list();
      } catch (error) {
        unscopedSdkDenied =
          error instanceof Error &&
          error.message.includes("scoped authorization");
      }
      let backgroundApiDenied = false;
      try {
        void bb.server.internal_DO_NOT_USE_backgroundJobs;
      } catch (error) {
        backgroundApiDenied =
          error instanceof Error && error.message.includes("not authorized");
      }
      return JSON.stringify({
        delegatedProbe: true,
        backgroundApiDenied,
        threadId: context.threadId,
        projectId: context.projectId,
        unscopedSdkDenied,
      });
    },
  });
  bb.agents.registerTool({
    name: "forbidden_server_probe",
    description: "Must never be available in the approved profile",
    parameters: { type: "object", properties: {} },
    execute: () => {
      throw new Error("Unapproved fixture tool executed");
    },
  });
}
