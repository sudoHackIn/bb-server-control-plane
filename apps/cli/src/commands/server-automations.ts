import type { Command } from "commander";
import type { createControlPlaneClient } from "@bb/sdk/node";
import { z } from "zod";
import { action } from "../action.js";

export function registerServerAutomationCommands(
  access: Command,
  client: () => ReturnType<typeof createControlPlaneClient>,
) {
  const automations = access
    .command("automations")
    .description("Read your server automations through the limited API");
  const output = (value: object) => console.log(JSON.stringify(value, null, 2));
  automations
    .command("list")
    .option("--json", "Print JSON")
    .option("--project <id>", "Authorized project")
    .option("--cursor <id>", "Continue after the returned cursor")
    .option("--limit <count>", "Maximum automations, 1 to 50", "20")
    .action(
      action(
        async (options: { project?: string; cursor?: string; limit: string }) =>
          output(
            await client().automations.list({
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
  automations
    .command("get <automation-id>")
    .option("--json", "Print JSON")
    .action(
      action(async (id: string) => output(await client().automations.get(id))),
    );
  automations
    .command("history <automation-id>")
    .option("--json", "Print JSON")
    .option("--cursor <cursor>", "Continue after the returned run cursor")
    .option("--limit <count>", "Maximum runs, 1 to 100", "20")
    .action(
      action(async (id: string, options: { cursor?: string; limit: string }) =>
        output(
          await client().automations.history(id, {
            cursor: options.cursor,
            limit: z.coerce.number().int().min(1).max(100).parse(options.limit),
          }),
        ),
      ),
    );
}
