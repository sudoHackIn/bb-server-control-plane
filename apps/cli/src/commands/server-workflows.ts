import type { Command } from "commander";
import type { createControlPlaneClient } from "@bb/sdk/node";
import { controlPlaneWorkflowStartSchema } from "@bb/domain";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { action } from "../action.js";

export function registerServerWorkflowCommands(
  access: Command,
  client: () => ReturnType<typeof createControlPlaneClient>,
) {
  const workflows = access
    .command("workflows")
    .description("Manage your server workflow runs through the limited API");
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
    .command("start <origin-thread-id>")
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
          originThreadId: string,
          options: {
            script?: string;
            scriptStdin?: boolean;
            file?: string;
            args?: string;
            resume?: string;
          },
        ) => {
          if (
            [
              options.script !== undefined,
              Boolean(options.scriptStdin),
              options.file !== undefined,
            ].filter(Boolean).length !== 1
          )
            throw new Error(
              "Choose exactly one of --script, --script-stdin or --file",
            );
          let script = options.script ?? "";
          if (options.file) {
            const buffer = await readFile(options.file);
            if (buffer.byteLength > 524288)
              throw new Error("Workflow script is too large");
            script = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
          }
          if (options.scriptStdin) {
            if (process.stdin.isTTY)
              throw new Error("Pipe the script into stdin");
            process.stdin.setEncoding("utf8");
            for await (const part of process.stdin) {
              script += part;
              if (Buffer.byteLength(script) > 524288)
                throw new Error("Workflow script is too large");
            }
          }
          const input = controlPlaneWorkflowStartSchema.parse({
            originThreadId,
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
