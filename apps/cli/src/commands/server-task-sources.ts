import type { Command } from "commander";
import type { createControlPlaneClient } from "@bb/sdk/node";
import { action } from "../action.js";
export function registerServerTaskSourceCommands(
  access: Command,
  client: () => ReturnType<typeof createControlPlaneClient>,
) {
  const commands = access
    .command("task-sources")
    .description("Poll project task sources and inspect admitted tasks");
  const output = (value: object) => console.log(JSON.stringify(value, null, 2));
  commands
    .command("create <project-id>")
    .requiredOption("--profile-version <id>")
    .requiredOption("--name <name>")
    .option(
      "--interval <seconds>",
      "Polling interval, at least 60 seconds",
      "300",
    )
    .option("--json")
    .action(
      action(
        async (
          projectId: string,
          o: { profileVersion: string; name: string; interval: string },
        ) =>
          output(
            await client().taskSources.create({
              projectId,
              profileVersionId: o.profileVersion,
              name: o.name,
              intervalSeconds: Number(o.interval),
              kind: "beads",
            }),
          ),
      ),
    );
  commands
    .command("list <project-id>")
    .option("--cursor <id>")
    .option("--json")
    .action(
      action(async (projectId: string, o: { cursor?: string }) =>
        output(
          await client().taskSources.list({ projectId, cursor: o.cursor }),
        ),
      ),
    );
  commands
    .command("history <id>")
    .option("--cursor <id>")
    .option("--json")
    .action(
      action(async (id: string, o: { cursor?: string }) =>
        output(await client().taskSources.history(id, o)),
      ),
    );
  for (const method of ["get", "poll"] as const)
    commands
      .command(`${method} <id>`)
      .option("--json")
      .action(
        action(async (id: string) =>
          output(await client().taskSources[method](id)),
        ),
      );
  for (const mode of ["enable", "disable"] as const)
    commands
      .command(`${mode} <id>`)
      .option("--json")
      .action(
        action(async (id: string) =>
          output(await client().taskSources.setEnabled(id, mode === "enable")),
        ),
      );
}
