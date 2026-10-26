import type { Command } from "commander";
import { z } from "zod";
import type { createControlPlaneClient } from "@bb/sdk/node";
import {
  controlPlaneMcpConnectorCreateSchema,
  controlPlaneMcpConnectorUpdateSchema,
  controlPlaneMcpCredentialInputSchema,
  controlPlaneMcpConnectionCreateSchema,
} from "@bb/domain";
import { action } from "../action.js";

async function input<T extends z.ZodType>(
  enabled: boolean | undefined,
  schema: T,
) {
  if (!enabled || process.stdin.isTTY)
    throw new Error("Supply JSON on stdin with the required stdin flag");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of process.stdin) {
    const part: unknown = value;
    if (!Buffer.isBuffer(part)) throw new Error("Invalid stdin bytes");
    size += part.length;
    if (size > 65536) throw new Error("MCP input exceeds limit");
    chunks.push(part);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid MCP JSON input");
  }
  return schema.parse(value);
}
export function registerServerMcpCommands(
  access: Command,
  client: () => ReturnType<typeof createControlPlaneClient>,
) {
  const mcp = access
    .command("mcp")
    .description(
      "Configure approved project MCP connectors and personal credentials; activation is not available yet",
    );
  const output = (value: object) => console.log(JSON.stringify(value, null, 2));
  const revision = (value: string) =>
    z.coerce.number().int().positive().parse(value);
  mcp
    .command("list")
    .option("--admin", "Include disabled connectors as an administrator")
    .option("--cursor <id>", "Exclusive cursor")
    .option("--limit <count>", "Maximum connectors", "50")
    .action(
      action(
        async (options: {
          admin?: boolean;
          cursor?: string;
          limit: string;
        }) => {
          const api = client();
          output(
            await (options.admin ? api.admin.mcp : api.mcp).list({
              cursor: options.cursor,
              limit: revision(options.limit),
            }),
          );
        },
      ),
    );
  mcp
    .command("get <connector-id>")
    .option("--admin", "Read a connector as an administrator")
    .action(
      action(async (id: string, options: { admin?: boolean }) => {
        const api = client();
        output(await (options.admin ? api.admin.mcp : api.mcp).get(id));
      }),
    );
  mcp
    .command("create")
    .requiredOption(
      "--definition-stdin",
      "Read connector definition JSON from stdin",
    )
    .action(
      action(async (options: { definitionStdin?: boolean }) =>
        output(
          await client().admin.mcp.create(
            await input(
              options.definitionStdin,
              controlPlaneMcpConnectorCreateSchema,
            ),
          ),
        ),
      ),
    );
  mcp
    .command("update <connector-id>")
    .requiredOption(
      "--definition-stdin",
      "Read definition, enabled and expectedRevision JSON from stdin",
    )
    .action(
      action(async (id: string, options: { definitionStdin?: boolean }) =>
        output(
          await client().admin.mcp.update(
            id,
            await input(
              options.definitionStdin,
              controlPlaneMcpConnectorUpdateSchema,
            ),
          ),
        ),
      ),
    );
  mcp
    .command("grant <connector-id> <user-id>")
    .option("--revoke", "Revoke connector access")
    .action(
      action(
        async (id: string, userId: string, options: { revoke?: boolean }) =>
          output(await client().admin.mcp.grant(id, userId, !options.revoke)),
      ),
    );
  mcp
    .command("credential <connector-id>")
    .action(
      action(async (id: string) => output(await client().mcp.credential(id))),
    );
  mcp
    .command("credential-set <connector-id>")
    .requiredOption(
      "--credential-stdin",
      "Read token, connectorRevision and expectedRevision JSON from stdin",
    )
    .action(
      action(async (id: string, options: { credentialStdin?: boolean }) =>
        output(
          await client().mcp.setCredential(
            id,
            await input(
              options.credentialStdin,
              controlPlaneMcpCredentialInputSchema,
            ),
          ),
        ),
      ),
    );
  mcp
    .command("credential-revoke <connector-id>")
    .requiredOption("--revision <number>", "Expected credential revision")
    .action(
      action(async (id: string, options: { revision: string }) =>
        output(
          await client().mcp.revokeCredential(id, revision(options.revision)),
        ),
      ),
    );
  mcp
    .command("connections <project-id>")
    .action(
      action(async (projectId: string) =>
        output(await client().mcp.connections(projectId)),
      ),
    );
  mcp
    .command("configure <project-id>")
    .requiredOption(
      "--connection-stdin",
      "Read connectorId, connectorRevision and expectedRevision JSON from stdin",
    )
    .action(
      action(
        async (projectId: string, options: { connectionStdin?: boolean }) =>
          output(
            await client().mcp.configure(
              projectId,
              await input(
                options.connectionStdin,
                controlPlaneMcpConnectionCreateSchema
                  .extend({ expectedRevision: z.number().int().nonnegative() })
                  .strict(),
              ),
            ),
          ),
      ),
    );
  mcp
    .command("remove <project-id> <connection-id>")
    .requiredOption("--revision <number>", "Expected connection revision")
    .action(
      action(
        async (projectId: string, id: string, options: { revision: string }) =>
          output(
            await client().mcp.remove(
              projectId,
              id,
              revision(options.revision),
            ),
          ),
      ),
    );
}
