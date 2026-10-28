import {
  automationInput,
  type AutomationInputOptions,
} from "./automation-input.js";
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
    .description("Manage your server automations through the limited API");
  const output = (value: object) => console.log(JSON.stringify(value, null, 2));
  automations
    .command("schedule <project-id>")
    .requiredOption("--profile-version <id>", "Pinned published agent version")
    .requiredOption("--input <text>", "Task input for the agent")
    .requiredOption("--name <name>", "Schedule name")
    .option("--at <time>", "Once trigger: ISO time or Unix milliseconds")
    .option("--cron <expression>", "Five-field cron trigger")
    .option("--timezone <zone>", "Cron timezone, defaults to UTC")
    .option("--disabled", "Create paused")
    .option("--json", "Print JSON")
    .action(
      action(
        async (
          projectId: string,
          options: {
            profileVersion: string;
            input: string;
            name: string;
            at?: string;
            cron?: string;
            timezone?: string;
            disabled?: boolean;
          },
        ) => {
          const parsed = await automationInput({
            name: options.name,
            at: options.at,
            cron: options.cron,
            timezone: options.timezone,
          });
          if (!parsed.trigger) throw new Error("Provide --at or --cron");
          output(
            await client().automations.create({
              projectId,
              name: options.name,
              target: {
                profileVersionId: options.profileVersion,
                input: options.input,
              },
              trigger: parsed.trigger,
              enabled: !options.disabled,
            }),
          );
        },
      ),
    );
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
  automations
    .command("definition <automation-id>")
    .option("--json", "Print JSON")
    .action(
      action(async (id: string) =>
        output(await client().automations.definition(id)),
      ),
    );
  function definitionOptions(command: Command) {
    return command
      .option("--name <name>", "Definition name")
      .option("--prompt <text>", "Agent prompt")
      .option("--prompt-stdin", "Read the agent prompt from stdin")
      .option("--script <source>", "Inline Node ESM script")
      .option("--script-stdin", "Read Node ESM source from stdin")
      .option("--timeout-ms <number>", "Script deadline, 1 to 900000 ms")
      .option("--at <time>", "Once trigger: ISO time or Unix milliseconds")
      .option("--cron <expression>", "Five-field cron trigger")
      .option("--timezone <zone>", "Cron timezone, defaults to UTC")
      .option("--json", "Print JSON");
  }
  definitionOptions(automations.command("create <origin-thread-id>"))
    .option("--disabled", "Create paused")
    .action(
      action(
        async (
          originThreadId: string,
          options: AutomationInputOptions & { disabled?: boolean },
        ) => {
          const input = await automationInput(options);
          if (
            !input.name ||
            (input.prompt === undefined && input.script === undefined) ||
            !input.trigger
          )
            throw new Error(
              "Provide --name, prompt or script input and one trigger",
            );
          output(
            await client().automations.create({
              originThreadId,
              name: input.name,
              ...(input.script
                ? { script: input.script }
                : { prompt: input.prompt ?? "" }),
              trigger: input.trigger,
              enabled: !options.disabled,
            }),
          );
        },
      ),
    );
  definitionOptions(automations.command("update <automation-id>"))
    .requiredOption("--revision <number>", "Expected saved definition revision")
    .action(
      action(
        async (
          id: string,
          options: AutomationInputOptions & { revision: string },
        ) => {
          output(
            await client().automations.update(id, {
              ...(await automationInput(options)),
              expectedRevision: z.coerce
                .number()
                .int()
                .min(1)
                .parse(options.revision),
            }),
          );
        },
      ),
    );
  for (const operation of ["pause", "resume", "delete"] as const)
    automations
      .command(`${operation} <automation-id>`)
      .option("--json", "Print JSON")
      .action(
        action(async (id: string) =>
          output(
            await client().automations[
              operation === "delete" ? "remove" : operation
            ](id),
          ),
        ),
      );
  automations
    .command("run <automation-id>")
    .option("--idempotency-key <key>", "Deduplicate a repeated manual request")
    .option("--json", "Print JSON")
    .action(
      action(async (id: string, options: { idempotencyKey?: string }) =>
        output(
          await client().automations.run(id, {
            idempotencyKey: options.idempotencyKey,
          }),
        ),
      ),
    );
  automations
    .command("output <automation-id> <run-id>")
    .option("--json", "Print JSON")
    .action(
      action(async (id: string, runId: string) =>
        output(await client().automations.output(id, runId)),
      ),
    );
  automations
    .command("stop <automation-id> <run-id>")
    .option("--json", "Print JSON")
    .action(
      action(async (id: string, runId: string) =>
        output(await client().automations.stop(id, runId)),
      ),
    );
}
