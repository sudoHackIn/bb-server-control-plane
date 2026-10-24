import type { Command } from "commander";
import type { createControlPlaneClient } from "@bb/sdk/node";
import { z } from "zod";
import { controlPlaneThreadResolutionSchema } from "@bb/domain";
import { action } from "../action.js";

const count = (value: string, max: number) =>
  z.coerce.number().int().min(1).max(max).parse(value);
async function inputText(options: {
  message?: string;
  messageStdin?: boolean;
}) {
  if (options.messageStdin && options.message !== undefined)
    throw new Error("Choose --message or --message-stdin");
  if (!options.messageStdin) {
    if (!options.message)
      throw new Error("Supply --message or --message-stdin");
    return options.message;
  }
  if (process.stdin.isTTY) throw new Error("Pipe a message into stdin");
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 1048576)
      throw new Error("Message is too large");
  }
  return text;
}
export function registerServerThreadCommands(
  access: Command,
  client: () => ReturnType<typeof createControlPlaneClient>,
) {
  const threads = access
    .command("threads")
    .description("Run and inspect your authorized server conversations");
  const output = (value: object) => console.log(JSON.stringify(value, null, 2));
  threads
    .command("list")
    .option("--json", "Print machine-readable JSON output")
    .option("--project <id>", "Limit to an authorized project")
    .option("--cursor <id>", "Continue after the returned cursor")
    .option("--limit <count>", "Maximum threads, 1 to 100", "50")
    .action(
      action(
        async (options: { project?: string; cursor?: string; limit: string }) =>
          output(
            await client().threads.list({
              projectId: options.project,
              cursor: options.cursor,
              limit: count(options.limit, 100),
            }),
          ),
      ),
    );
  threads
    .command("start <project-id>")
    .option("--json", "Print machine-readable JSON output")
    .requiredOption(
      "--profile-version <id>",
      "Approved immutable profile version",
    )
    .option("--title <text>", "Conversation title")
    .option("--message <text>", "First message")
    .option("--message-stdin", "Read the first message from stdin")
    .action(
      action(
        async (
          projectId: string,
          options: {
            profileVersion: string;
            title?: string;
            message?: string;
            messageStdin?: boolean;
          },
        ) =>
          output(
            await client().threads.start({
              projectId,
              profileVersionId: options.profileVersion,
              title: options.title,
              message: await inputText(options),
            }),
          ),
      ),
    );
  for (const method of ["get", "result", "stop"] as const)
    threads
      .command(`${method} <thread-id>`)
      .option("--json", "Print machine-readable JSON output")
      .action(
        action(async (id: string) =>
          output(await client().threads[method](id)),
        ),
      );
  threads
    .command("send <thread-id>")
    .option("--json", "Print machine-readable JSON output")
    .option("--message <text>", "Message to send or queue")
    .option("--message-stdin", "Read a message from stdin")
    .action(
      action(
        async (
          id: string,
          options: { message?: string; messageStdin?: boolean },
        ) =>
          output(
            await client().threads.send(id, {
              message: await inputText(options),
            }),
          ),
      ),
    );
  threads
    .command("events <thread-id>")
    .option("--json", "Print machine-readable JSON output")
    .option("--after <sequence>", "Read events after this sequence", "0")
    .option("--limit <count>", "Maximum events, 1 to 200", "100")
    .action(
      action(async (id: string, options: { after: string; limit: string }) =>
        output(
          await client().threads.events(id, {
            after: z.coerce.number().int().nonnegative().parse(options.after),
            limit: count(options.limit, 200),
          }),
        ),
      ),
    );
  const interactions = threads
    .command("interactions")
    .description("Inspect and resolve your own native questions and approvals");
  interactions
    .command("list <thread-id>")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string) =>
        output(await client().threads.interactions.list(id)),
      ),
    );
  interactions
    .command("resolve <thread-id> <interaction-id>")
    .option("--json", "Print machine-readable JSON output")
    .requiredOption(
      "--response-stdin",
      "Read a native approval or user-answer JSON response from stdin",
    )
    .action(
      action(async (id: string, interactionId: string) => {
        const text = await inputText({ messageStdin: true });
        const value: unknown = JSON.parse(text);
        output(
          await client().threads.interactions.resolve(
            id,
            interactionId,
            controlPlaneThreadResolutionSchema.parse(value),
          ),
        );
      }),
    );
  for (const decision of ["approve", "deny"] as const)
    interactions
      .command(`${decision} <thread-id> <interaction-id>`)
      .option("--json", "Print machine-readable JSON output")
      .action(
        action(async (id: string, interactionId: string) =>
          output(
            await client().threads.interactions.resolve(
              id,
              interactionId,
              decision === "approve"
                ? { decision: "allow_once", grantedPermissions: null }
                : { decision: "deny" },
            ),
          ),
        ),
      );
}
