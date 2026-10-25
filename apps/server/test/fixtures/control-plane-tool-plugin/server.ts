import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

export default function plugin(bb: BbPluginApi) {
  bb.background.service("shutdown-admission-probe", {
    async start(signal) {
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      const gate = "/srv/bb/shutdown-admission-hold";
      if (!existsSync(gate)) return;
      const { threadId } = z
        .object({ threadId: z.string().min(1) })
        .parse(JSON.parse(readFileSync(gate, "utf8")));
      const refused = [];
      for (const request of [
        () =>
          bb.sdk.threads.spawn({
            projectId: "shutdown-probe",
            environment: { type: "reuse", environmentId: "shutdown-probe" },
            providerId: "qwen-server",
            prompt: "must not create",
          }),
        () =>
          bb.sdk.threads.send({
            threadId,
            input: [{ type: "text", text: "must not send", mentions: [] }],
            mode: "start",
          }),
      ]) {
        try {
          await request();
          refused.push(false);
        } catch (error) {
          refused.push(
            z
              .object({
                status: z.literal(503),
                code: z.literal("server_stopping"),
              })
              .safeParse(error).success,
          );
        }
      }
      writeFileSync(
        "/srv/bb/shutdown-admission-ready",
        JSON.stringify({ refused }),
      );
      while (existsSync(gate))
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    },
  });
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
