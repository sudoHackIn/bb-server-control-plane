import type { Command } from "commander";
import type { createControlPlaneClient } from "@bb/sdk/node";
import { z } from "zod";
import { action } from "../action.js";

export function registerServerProjectRoleCommands(
  projects: Command,
  client: () => ReturnType<typeof createControlPlaneClient>,
) {
  const output = (value: object) => console.log(JSON.stringify(value, null, 2));
  const revision = (value: string) =>
    z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(value);
  projects
    .command("roles <project-id>")
    .description("List project roles and policy revisions as an administrator")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (projectId: string) => {
        output(await client().admin.projectRoles.list(projectId));
      }),
    );
  projects
    .command("set-role <project-id> <user-id>")
    .description("Grant runner or viewer access as an administrator")
    .requiredOption("--role <role>", "runner or viewer")
    .requiredOption("--revision <number>", "Expected project policy revision")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          projectId: string,
          userId: string,
          options: { role: string; revision: string },
        ) => {
          const role = z.enum(["runner", "viewer"]).parse(options.role);
          output(
            await client().admin.projectRoles.set(projectId, userId, {
              role,
              expectedRevision: revision(options.revision),
            }),
          );
        },
      ),
    );
  projects
    .command("remove-role <project-id> <user-id>")
    .description("Remove a project role as an administrator")
    .requiredOption("--revision <number>", "Expected project policy revision")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          projectId: string,
          userId: string,
          options: { revision: string },
        ) => {
          output(
            await client().admin.projectRoles.set(projectId, userId, {
              role: null,
              expectedRevision: revision(options.revision),
            }),
          );
        },
      ),
    );
  projects
    .command("role-operation <project-id> <operation-id>")
    .description("Inspect a saved project role maintenance operation")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (projectId: string, operationId: string) => {
        output(
          await client().admin.projectRoles.operation(projectId, operationId),
        );
      }),
    );
}
