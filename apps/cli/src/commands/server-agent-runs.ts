import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import type { createControlPlaneClient } from "@bb/sdk/node";
import { z } from "zod";
import { action } from "../action.js";

export function registerServerAgentRunCommands(
  access: Command,
  client: () => ReturnType<typeof createControlPlaneClient>,
) {
  const runs = access
    .command("agent-runs")
    .description("Start and inspect background agent tasks");
  const output = (value: object) => console.log(JSON.stringify(value, null, 2));
  runs
    .command("start <project-id>")
    .requiredOption("--profile-version <id>", "Approved agent version")
    .requiredOption("--input <text>", "Task text")
    .option("--idempotency-key <key>", "Retry key, generated when omitted")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          projectId: string,
          options: {
            profileVersion: string;
            input: string;
            idempotencyKey?: string;
          },
        ) =>
          output(
            await client().agentRuns.start({
              projectId,
              profileVersionId: options.profileVersion,
              input: options.input,
              source: "manual",
              idempotencyKey: options.idempotencyKey ?? randomUUID(),
            }),
          ),
      ),
    );
  runs
    .command("list")
    .option("--project <id>", "Limit to a project")
    .option("--cursor <id>", "Continue after the returned cursor")
    .option("--limit <count>", "Maximum runs, 1 to 100", "50")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (options: { project?: string; cursor?: string; limit: string }) =>
          output(
            await client().agentRuns.list({
              projectId: options.project,
              cursor: options.cursor,
              limit: z.coerce
                .number()
                .int()
                .min(1)
                .max(100)
                .parse(options.limit),
            }),
          ),
      ),
    );
  for (const method of ["get", "status", "result", "cancel"] as const)
    runs
      .command(`${method} <run-id>`)
      .option("--json", "Print machine-readable JSON output")
      .action(
        action(async (id: string) =>
          output(await client().agentRuns[method](id)),
        ),
      );
  runs
    .command("events <run-id>")
    .option("--after <sequence>", "Resume after this sequence", "0")
    .option("--limit <count>", "Maximum events, 1 to 200", "100")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, options: { after: string; limit: string }) =>
        output(
          await client().agentRuns.events(id, {
            after: z.coerce.number().int().nonnegative().parse(options.after),
            limit: z.coerce.number().int().min(1).max(200).parse(options.limit),
          }),
        ),
      ),
    );
}
