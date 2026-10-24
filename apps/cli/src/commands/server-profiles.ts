import type { Command } from "commander";
import { z } from "zod";
import { controlPlaneProfileDefinitionSchema } from "@bb/domain";
import type { createControlPlaneClient } from "@bb/sdk/node";
import { action } from "../action.js";

export function registerServerProfileCommands(
  access: Command,
  client: () => ReturnType<typeof createControlPlaneClient>,
) {
  const profiles = access
    .command("profiles")
    .description(
      "Inspect authorized agent profiles or manage their immutable versions as an administrator",
    );
  const output = (value: object) => console.log(JSON.stringify(value, null, 2));
  const page = (options: { cursor?: string; limit: string }) => ({
    cursor: options.cursor,
    limit: z.coerce.number().int().min(1).max(100).parse(options.limit),
  });
  const definition = async (enabled: boolean | undefined) => {
    if (!enabled || process.stdin.isTTY)
      throw new Error(
        "Supply a profile definition JSON on stdin with --definition-stdin",
      );
    let text = "";
    for await (const chunk of process.stdin) {
      text += chunk;
      if (Buffer.byteLength(text) > 1048576)
        throw new Error("Profile definition is too large");
    }
    const value: unknown = JSON.parse(text);
    return controlPlaneProfileDefinitionSchema.parse(value);
  };
  profiles
    .command("versions <profile-id>")
    .option("--admin", "Include disabled versions as an administrator")
    .option("--cursor <number>", "Continue before this version number")
    .option("--limit <count>", "Maximum versions, 1 to 100", "50")
    .action(
      action(
        async (
          id: string,
          options: { admin?: boolean; cursor?: string; limit: string },
        ) => {
          const api = client();
          output(
            await (options.admin ? api.admin.profiles : api.profiles).versions(
              id,
              {
                limit: page({ limit: options.limit }).limit,
                ...(options.cursor === undefined
                  ? {}
                  : {
                      cursor: z.coerce
                        .number()
                        .int()
                        .positive()
                        .parse(options.cursor),
                    }),
              },
            ),
          );
        },
      ),
    );
  profiles
    .command("list")
    .option("--admin", "List all profiles as an administrator")
    .option("--cursor <id>", "Pagination cursor")
    .option("--limit <count>", "Maximum profiles, 1 to 100", "50")
    .action(
      action(
        async (options: {
          admin?: boolean;
          cursor?: string;
          limit: string;
        }) => {
          const api = client();
          output(
            await (options.admin ? api.admin.profiles : api.profiles).list(
              page(options),
            ),
          );
        },
      ),
    );
  profiles
    .command("get <profile-id>")
    .option("--admin", "Read a profile as an administrator")
    .option("--version <id>", "Read a specific immutable version")
    .action(
      action(
        async (id: string, options: { admin?: boolean; version?: string }) => {
          const api = client();
          output(
            await (options.admin ? api.admin.profiles : api.profiles).get(id, {
              versionId: options.version,
            }),
          );
        },
      ),
    );
  profiles
    .command("create <slug>")
    .requiredOption("--name <name>", "Profile display name")
    .requiredOption(
      "--definition-stdin",
      "Read the initial definition JSON from stdin",
    )
    .action(
      action(
        async (
          slug: string,
          options: { name: string; definitionStdin?: boolean },
        ) => {
          output(
            await client().admin.profiles.create({
              slug,
              name: options.name,
              definition: await definition(options.definitionStdin),
            }),
          );
        },
      ),
    );
  profiles
    .command("publish <profile-id>")
    .requiredOption(
      "--definition-stdin",
      "Read the new definition JSON from stdin",
    )
    .action(
      action(async (id: string, options: { definitionStdin?: boolean }) => {
        output(
          await client().admin.profiles.publish(
            id,
            await definition(options.definitionStdin),
          ),
        );
      }),
    );
  for (const [name, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    profiles
      .command(`${name} <profile-id>`)
      .option("--version <id>", "Change only this version's availability")
      .action(
        action(async (id: string, options: { version?: string }) => {
          output(
            await client().admin.profiles.setEnabled(id, enabled, {
              versionId: options.version,
            }),
          );
        }),
      );
  }
  for (const [name, allowed] of [
    ["grant", true],
    ["revoke", false],
  ] as const) {
    profiles.command(`${name} <profile-id> <user-id>`).action(
      action(async (id: string, userId: string) => {
        output(await client().admin.profiles.setAccess(id, userId, allowed));
      }),
    );
  }
  profiles
    .command("access <profile-id>")
    .option("--cursor <id>", "Pagination cursor")
    .option("--limit <count>", "Maximum users, 1 to 100", "50")
    .action(
      action(
        async (id: string, options: { cursor?: string; limit: string }) => {
          output(await client().admin.profiles.access(id, page(options)));
        },
      ),
    );
}
