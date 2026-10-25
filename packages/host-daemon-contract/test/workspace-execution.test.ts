import { expect, it } from "vitest";
import {
  workspaceWorkerRequestSchema,
  workspaceExecutionResponseSchema,
} from "../src/workspace-execution.js";

it("rejects arbitrary interpreters, unsupported operations and silently ignored workspace restrictions", () => {
  for (const input of [
    { op: "shell", command: "id" },
    { op: "status", options: {}, uid: 0 },
    {
      op: "commit",
      options: { message: "Commit", noVerify: false, executable: "/bin/sh" },
    },
    {
      op: "command",
      command: {
        type: "host.read_file",
        path: "/srv/bb/bb.db",
        maxBytes: 1024,
      },
    },
    {
      op: "diffPatch",
      options: {
        target: { type: "uncommitted" },
        paths: Array(4097).fill("file"),
        maxBytesPerFile: 1024,
        ignoreWhitespace: false,
      },
    },
  ])
    expect(workspaceWorkerRequestSchema.safeParse(input).success).toBe(false);
  expect(
    workspaceWorkerRequestSchema.safeParse({
      op: "commit",
      options: { message: "Commit", noVerify: false },
    }).success,
  ).toBe(true);
  expect(
    workspaceExecutionResponseSchema.safeParse({
      kind: "managed",
      identity: {
        userId: "37ea4c25-514c-4eae-84d7-d090bef3540b",
        uid: 0,
        projectId: "project",
        cwd: "/srv/users/app",
      },
    }).success,
  ).toBe(false);
});
