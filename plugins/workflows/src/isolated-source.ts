import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import {
  resolveConfinedWorkflowPath,
  workflowNamePath,
} from "./source-resolution.js";
import { MAX_WORKFLOW_SOURCE_BYTES } from "./validation.js";
import type { WorkflowReference } from "./types.js";

export async function loadIsolatedWorkflowSource(
  reference: WorkflowReference,
  workspace?: string,
): Promise<string> {
  if (typeof reference !== "string" && "script" in reference)
    return reference.script;
  const root = workspace ?? process.cwd();
  const absolute =
    typeof reference === "string"
      ? workflowNamePath(root, reference)
      : "name" in reference
        ? workflowNamePath(root, reference.name)
        : resolveConfinedWorkflowPath(root, reference.scriptPath);
  const segments = path.relative(root, absolute).split(path.sep);
  const flags =
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let directory = await open(workspace ?? ".", flags | constants.O_DIRECTORY);
  try {
    for (const segment of segments.slice(0, -1)) {
      const next = await open(
        `/proc/self/fd/${directory.fd}/${segment}`,
        flags | constants.O_DIRECTORY,
      );
      await directory.close();
      directory = next;
    }
    const file = await open(
      `/proc/self/fd/${directory.fd}/${segments.at(-1)}`,
      flags,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile())
        throw new Error("Workflow source must be a regular file");
      if (stat.size > MAX_WORKFLOW_SOURCE_BYTES)
        throw new Error("Workflow source exceeds byte limit");
      const buffer = Buffer.alloc(MAX_WORKFLOW_SOURCE_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          size,
          buffer.length - size,
          size,
        );
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > MAX_WORKFLOW_SOURCE_BYTES)
        throw new Error("Workflow source exceeds byte limit");
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, size),
      );
    } finally {
      await file.close();
    }
  } finally {
    await directory.close();
  }
}
