import type { Command } from "commander";
import type { createControlPlaneClient } from "@bb/sdk/node";
import { controlPlaneWorkflowStartSchema } from "@bb/domain";
import { readWorkflowScript } from "./workflow-source.js";
import { registerServerWorkflowDefinitionCommands } from "./server-workflow-definitions.js";
import { z } from "zod";
import { action } from "../action.js";

export function registerServerWorkflowCommands(
  access: Command,
  client: () => ReturnType<typeof createControlPlaneClient>,
) {
  const workflows = access
    .command("workflows")
    .description("Manage your server workflow runs through the limited API");
  registerServerWorkflowDefinitionCommands(workflows, client);
  const output = (value: object) => console.log(JSON.stringify(value, null, 2));
  workflows
    .command("list")
    .option("--json", "Print JSON")
    .option("--project <id>", "Authorized project")
    .option("--cursor <id>", "Continue after the returned cursor")
    .option("--limit <count>", "Maximum runs, 1 to 50", "20")
    .action(
      action(
        async (options: { project?: string; cursor?: string; limit: string }) =>
          output(
            await client().workflows.list({
              projectId: options.project,
              cursor: options.cursor,
              limit: z.coerce
                .number()
                .int()
                .min(1)
                .max(50)
                .parse(options.limit),
            }),
          ),
      ),
    );
  workflows
    .command("start [origin-thread-id]")
    .option(
      "--project <id>",
      "Run directly in an authorized project without a conversation",
    )
    .option(
      "--profile-version <id>",
      "Pinned approved profile for project execution",
    )
    .option("--json", "Print JSON")
    .option("--script <source>", "Inline workflow script")
    .option("--script-stdin", "Read the script from stdin")
    .option("--file <path>", "Read the script from a local client file")
    .option("--args <json>", "Workflow JSON arguments")
    .option(
      "--resume <run-id>",
      "Replay a terminal owned run's unchanged prefix",
    )
    .action(
      action(
        async (
          originThreadId: string | undefined,
          options: {
            project?: string;
            profileVersion?: string;
            script?: string;
            scriptStdin?: boolean;
            file?: string;
            args?: string;
            resume?: string;
          },
        ) => {
          const script = await readWorkflowScript(options);
          const input = controlPlaneWorkflowStartSchema.parse({
            originThreadId: originThreadId ?? null,
            ...(options.project ? { projectId: options.project } : {}),
            ...(options.profileVersion
              ? { profileVersionId: options.profileVersion }
              : {}),
            script,
            args: options.args === undefined ? null : JSON.parse(options.args),
            resumeRunId: options.resume ?? null,
          });
          output(await client().workflows.start(input));
        },
      ),
    );
  for (const operation of ["get", "result", "stop"] as const)
    workflows
      .command(`${operation} <run-id>`)
      .option("--json", "Print JSON")
      .action(
        action(async (id: string) =>
          output(await client().workflows[operation](id)),
        ),
      );
  workflows
    .command("history <run-id>")
    .option("--json", "Print JSON")
    .option("--after <index>", "Continue after a call index", "-1")
    .option("--limit <count>", "Maximum calls, 1 to 100", "20")
    .action(
      action(async (id: string, options: { after: string; limit: string }) =>
        output(
          await client().workflows.history(id, {
            after: z.coerce.number().int().min(-1).parse(options.after),
            limit: z.coerce.number().int().min(1).max(100).parse(options.limit),
          }),
        ),
      ),
    );
}
