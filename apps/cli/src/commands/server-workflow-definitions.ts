import type { Command } from "commander";
import type { createControlPlaneClient } from "@bb/sdk/node";
import { z } from "zod";
import { action } from "../action.js";
import {
  readWorkflowScript,
  type WorkflowSourceOptions,
} from "./workflow-source.js";
const revision = (value: string) =>
  z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).parse(value);
export function registerServerWorkflowDefinitionCommands(
  workflows: Command,
  client: () => ReturnType<typeof createControlPlaneClient>,
) {
  const definitions = workflows
    .command("definitions")
    .description(
      "Manage your saved workflow definitions and immutable revisions",
    );
  const output = (value: object) => console.log(JSON.stringify(value, null, 2));
  function source(command: Command) {
    return command
      .option("--json", "Print JSON")
      .option("--script <source>", "Inline workflow script")
      .option("--script-stdin", "Read workflow source from stdin")
      .option("--file <path>", "Read a local client source file")
      .option("--args <json>", "Saved default JSON arguments");
  }
  source(definitions.command("create <origin-thread-id>")).action(
    action(
      async (
        originThreadId: string,
        options: WorkflowSourceOptions & { args?: string },
      ) =>
        output(
          await client().workflows.definitions.create({
            originThreadId,
            script: await readWorkflowScript(options),
            args: options.args === undefined ? null : JSON.parse(options.args),
          }),
        ),
    ),
  );
  source(definitions.command("update <definition-id>"))
    .requiredOption(
      "--revision <number>",
      "Expected current revision, rejecting stale edits",
    )
    .action(
      action(
        async (
          id: string,
          options: WorkflowSourceOptions & { args?: string; revision: string },
        ) =>
          output(
            await client().workflows.definitions.update(id, {
              expectedRevision: revision(options.revision),
              script: await readWorkflowScript(options),
              args:
                options.args === undefined ? null : JSON.parse(options.args),
            }),
          ),
      ),
    );
  definitions
    .command("list")
    .option("--json", "Print JSON")
    .option("--project <id>", "Authorized project")
    .option("--cursor <id>", "Continue after the returned cursor")
    .option("--limit <count>", "Maximum definitions, 1 to 50", "20")
    .action(
      action(
        async (options: { project?: string; cursor?: string; limit: string }) =>
          output(
            await client().workflows.definitions.list({
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
  definitions
    .command("get <definition-id>")
    .option("--json", "Print JSON")
    .option("--revision <number>", "Immutable version; defaults to latest")
    .action(
      action(async (id: string, options: { revision?: string }) =>
        output(
          await client().workflows.definitions.get(id, {
            revision:
              options.revision === undefined
                ? undefined
                : revision(options.revision),
          }),
        ),
      ),
    );
  for (const operation of ["enable", "disable", "delete"] as const)
    definitions
      .command(`${operation} <definition-id>`)
      .option("--json", "Print JSON")
      .action(
        action(async (id: string) =>
          output(
            operation === "delete"
              ? await client().workflows.definitions.remove(id)
              : await client().workflows.definitions.setEnabled(
                  id,
                  operation === "enable",
                ),
          ),
        ),
      );
  definitions
    .command("run <definition-id>")
    .option("--json", "Print JSON")
    .requiredOption(
      "--revision <number>",
      "Exact immutable source/default-argument revision",
    )
    .option("--args <json>", "Override saved default arguments")
    .action(
      action(async (id: string, options: { revision: string; args?: string }) =>
        output(
          await client().workflows.definitions.run(id, {
            revision: revision(options.revision),
            ...(options.args === undefined
              ? {}
              : { args: JSON.parse(options.args) }),
          }),
        ),
      ),
    );
}
