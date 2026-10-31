import type { Command } from "commander";
import type { createControlPlaneClient } from "@bb/sdk/node";
import { z } from "zod";
import { controlPlaneDiagnosticRoleSchema } from "@bb/domain";
import { controlPlaneTimelineDetailsSchema } from "@bb/server-contract";
import { action } from "../action.js";
export function registerServerInspectionCommands(
  access: Command,
  client: () => ReturnType<typeof createControlPlaneClient>,
) {
  const group = access
    .command("inspections")
    .description("Read project runs under explicit diagnostic authority");
  const output = (value: object) => console.log(JSON.stringify(value, null, 2));
  const reader = (admin: boolean | undefined) =>
    admin ? client().admin.inspections : client().inspections;
  group
    .command("list <project-id>")
    .option("--admin", "Use administrative inspection")
    .option("--cursor <cursor>")
    .option("--limit <count>", "Runs, 1 to 50", "20")
    .option("--json")
    .action(
      action(
        async (
          project: string,
          o: { admin?: boolean; cursor?: string; limit: string },
        ) =>
          output(
            await reader(o.admin).list(project, {
              cursor: o.cursor,
              limit: z.coerce.number().int().min(1).max(50).parse(o.limit),
            }),
          ),
      ),
    );
  group
    .command("workflow <run-id>")
    .option("--admin")
    .option("--call <id>", "Inspect a recorded call")
    .option("--trace", "Inspect execution structure")
    .option("--result", "Read the run result")
    .option("--after <cursor>", "Numeric continuation cursor", "-1")
    .option("--limit <count>", "Entries, 1 to 100", "20")
    .option("--attempt <uuid>", "Pinned trace attempt")
    .option("--json")
    .action(
      action(
        async (
          id: string,
          o: {
            admin?: boolean;
            call?: string;
            trace?: boolean;
            result?: boolean;
            after: string;
            limit: string;
            attempt?: string;
          },
        ) => {
          if (
            [o.call !== undefined, o.trace === true, o.result === true].filter(
              Boolean,
            ).length > 1
          )
            throw new Error("Select only one inspection output");
          if (o.attempt !== undefined && !o.trace)
            throw new Error("--attempt requires --trace");
          const api = reader(o.admin).workflows;
          const after = z.coerce.number().int().min(-1).parse(o.after),
            limit = z.coerce.number().int().min(1).max(100).parse(o.limit);
          output(
            o.call
              ? await api.inspectCall(id, o.call)
              : o.trace
                ? await api.trace(id, { attemptId: o.attempt, after, limit })
                : o.result
                  ? await api.result(id)
                  : await api.inspect(id, { after, limit }),
          );
        },
      ),
    );
  group
    .command("thread <thread-id>")
    .option("--workflow <id>", "Exact workflow root for a worker")
    .option("--admin")
    .option("--events")
    .option("--timeline")
    .option("--result")
    .option("--details <json>", "Native timeline item identity")
    .option("--stream")
    .option("--after <sequence>", "Event cursor", "0")
    .option("--json")
    .action(
      action(
        async (
          id: string,
          o: {
            workflow?: string;
            admin?: boolean;
            events?: boolean;
            timeline?: boolean;
            result?: boolean;
            details?: string;
            stream?: boolean;
            after: string;
          },
        ) => {
          if (
            [
              o.events,
              o.timeline,
              o.result,
              o.details !== undefined,
              o.stream,
            ].filter(Boolean).length > 1
          )
            throw new Error("Select only one thread inspection output");
          const api = o.workflow
            ? reader(o.admin).forWorkflow(o.workflow).threads
            : reader(o.admin).threads;
          const after = z.coerce.number().int().nonnegative().parse(o.after);
          if (o.stream) {
            const abort = new AbortController();
            const stop = () => abort.abort();
            process.once("SIGINT", stop);
            try {
              for await (const value of api.stream(id, {
                after,
                signal: abort.signal,
              }))
                console.log(JSON.stringify(value));
            } finally {
              process.removeListener("SIGINT", stop);
            }
            return;
          }
          if (o.details !== undefined) {
            const input: unknown = JSON.parse(o.details);
            output(
              await api.timelineDetails(
                id,
                controlPlaneTimelineDetailsSchema.parse(input),
              ),
            );
            return;
          }
          output(
            o.events
              ? await api.events(id, { after })
              : o.timeline
                ? await api.timeline(id)
                : o.result
                  ? await api.result(id)
                  : await api.get(id),
          );
        },
      ),
    );
  const grants = group
    .command("grants")
    .description("Manage diagnostic grants as an administrator");
  grants
    .command("list <project-id>")
    .option("--cursor <id>")
    .option("--json")
    .action(
      action(async (id: string, o: { cursor?: string }) =>
        output(
          await client().admin.diagnosticGrants.list(id, { cursor: o.cursor }),
        ),
      ),
    );
  grants
    .command("get <project-id> <user-id>")
    .option("--json")
    .action(
      action(async (project: string, user: string) =>
        output(await client().admin.diagnosticGrants.get(project, user)),
      ),
    );
  grants
    .command("set <project-id> <user-id>")
    .requiredOption("--role <role>", "developer, reviewer, or none")
    .requiredOption(
      "--revision <number>",
      "Expected grant revision; 0 if absent",
    )
    .option("--json")
    .action(
      action(
        async (
          project: string,
          user: string,
          o: { role: string; revision: string },
        ) =>
          output(
            await client().admin.diagnosticGrants.set(project, user, {
              role:
                o.role === "none"
                  ? null
                  : controlPlaneDiagnosticRoleSchema.parse(o.role),
              expectedRevision: z.coerce
                .number()
                .int()
                .min(0)
                .max(Number.MAX_SAFE_INTEGER - 1)
                .parse(o.revision),
            }),
          ),
      ),
    );
}
