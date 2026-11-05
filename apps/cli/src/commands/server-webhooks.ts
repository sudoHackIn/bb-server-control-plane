import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import type { createControlPlaneClient } from "@bb/sdk/node";
import { z } from "zod";
import { action } from "../action.js";
export function registerServerWebhookCommands(
  access: Command,
  client: () => ReturnType<typeof createControlPlaneClient>,
) {
  const commands = access
    .command("webhooks")
    .description("Manage project webhook triggers and delivery history");
  const output = (value: object) => console.log(JSON.stringify(value, null, 2));
  commands
    .command("create <project-id>")
    .requiredOption("--profile-version <id>", "Published agent version")
    .requiredOption("--name <name>", "Trigger name")
    .option("--input-field <field>", "Top-level JSON text field", "input")
    .option("--json", "JSON output, includes one-time secret")
    .action(
      action(
        async (
          projectId: string,
          o: { profileVersion: string; name: string; inputField: string },
        ) =>
          output(
            await client().webhooks.create({
              projectId,
              profileVersionId: o.profileVersion,
              name: o.name,
              inputField: o.inputField,
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
        output(await client().webhooks.list({ projectId, cursor: o.cursor })),
      ),
    );
  commands
    .command("history <id>")
    .option("--cursor <id>")
    .option("--json")
    .action(
      action(async (id: string, o: { cursor?: string }) =>
        output(await client().webhooks.history(id, { cursor: o.cursor })),
      ),
    );
  for (const method of ["get", "rotate"] as const)
    commands
      .command(`${method} <id>`)
      .option("--json")
      .action(
        action(async (id: string) =>
          output(await client().webhooks[method](id)),
        ),
      );
  for (const mode of ["enable", "disable"] as const)
    commands
      .command(`${mode} <id>`)
      .option("--json")
      .action(
        action(async (id: string) =>
          output(await client().webhooks.setEnabled(id, mode === "enable")),
        ),
      );
  commands
    .command("deliver <id>")
    .requiredOption("--delivery-id <id>", "Stable source event ID")
    .requiredOption("--payload-file <path>", "JSON object file")
    .requiredOption("--secret-stdin", "Read webhook secret from stdin")
    .option("--json")
    .action(
      action(
        async (
          id: string,
          o: { deliveryId: string; payloadFile: string; secretStdin: boolean },
        ) => {
          if (!o.secretStdin || process.stdin.isTTY)
            throw new Error("Supply webhook secret on stdin");
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of process.stdin) {
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += value.length;
            if (size > 4096) throw new Error("Secret input too large");
            chunks.push(value);
          }
          const raw = await readFile(o.payloadFile, "utf8");
          if (Buffer.byteLength(raw) > 262144)
            throw new Error("Payload too large");
          output(
            await client().webhooks.deliver(id, {
              secret: Buffer.concat(chunks).toString("utf8").trim(),
              deliveryId: o.deliveryId,
              payload: z.record(z.string(), z.unknown()).parse(JSON.parse(raw)),
            }),
          );
        },
      ),
    );
}
