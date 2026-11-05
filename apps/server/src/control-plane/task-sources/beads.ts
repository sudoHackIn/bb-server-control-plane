import { createHash } from "node:crypto";
import { z } from "zod";
import { taskSourceBatchSchema, type TaskSourceAdapter } from "./adapter.js";
const issuesSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(200),
      title: z.string().min(1).max(500),
      description: z.string().default(""),
      acceptance_criteria: z.string().default(""),
    }),
  )
  .max(1000);
export const beadsTaskSourceAdapter: TaskSourceAdapter = {
  kind: "beads",
  async poll(context) {
    const raw =
      await context.run(`import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
const dir = join(process.cwd(), ".beads");
const stat = lstatSync(dir);
if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Project-local Beads required");
const output = execFileSync("/usr/local/bin/bd", ["--readonly", "--sandbox", "ready", "--json", "--limit", "0"], {
  cwd: process.cwd(), env: { ...process.env, BEADS_DIR: dir }, timeout: 20000, maxBuffer: 1048576,
});
process.stdout.write(output);`);
    const issues = issuesSchema.parse(JSON.parse(raw));
    const tasks = issues
      .map((issue) => ({
        id: issue.id,
        title: issue.title,
        input: `Beads task ${issue.id}\n${issue.title}\n\n${issue.description}\n\nAcceptance criteria:\n${issue.acceptance_criteria}`,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(tasks.map((task) => task.id)).size !== tasks.length)
      throw new Error("Duplicate Beads task ID");
    return taskSourceBatchSchema.parse({
      checkpoint: createHash("sha256")
        .update(JSON.stringify(tasks))
        .digest("hex"),
      tasks,
    });
  },
};
