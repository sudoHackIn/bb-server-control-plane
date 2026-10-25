import { provisionWorkspace } from "@bb/host-workspace";
import { workspaceWorkerRequestSchema } from "@bb/host-daemon-contract";
import {
  inspectHostGitSource,
  listHostBranchOptions,
} from "./command-handlers/host-branches.js";
import { inspectProjectPath } from "./command-handlers/project.js";
import { readWorkspaceAgentContext } from "./command-handlers/workspace-agent-context.js";

async function main() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of process.stdin) {
    const part: unknown = value;
    if (!Buffer.isBuffer(part))
      throw new Error("Invalid workspace request bytes");
    size += part.length;
    if (size > 131072) throw new Error("Workspace request exceeds limit");
    chunks.push(part);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const request = workspaceWorkerRequestSchema.parse(JSON.parse(text));
  if (request.op === "command") {
    const command = request.command;
    const cwd = "rootPath" in command ? command.rootPath : command.path;
    if (cwd !== process.cwd())
      throw new Error("Workspace command target mismatch");
    switch (command.type) {
      case "project.inspect":
        return inspectProjectPath(command.path);
      case "host.inspect_git_source":
        return inspectHostGitSource(command);
      case "host.list_branch_options":
        return listHostBranchOptions(command);
      case "host.read_workspace_agent_context":
        return readWorkspaceAgentContext(command);
    }
  }
  const workspace = await provisionWorkspace({ path: process.cwd() });
  switch (request.op) {
    case "inspect":
      return {
        isGitRepo: workspace.isGitRepo,
        isWorktree: workspace.isWorktree,
      };
    case "branch":
      return workspace.getCurrentBranch();
    case "defaultBranch":
      return workspace.getDefaultBranch();
    case "head":
      return workspace.getHeadSha();
    case "localState":
      return workspace.getLocalStateSnapshot();
    case "sharedRefs":
      return workspace.getSharedGitRefsSnapshot();
    case "writeRoots":
      return workspace.getAdditionalWorkspaceWriteRoots();
    case "status":
      return workspace.getStatus(request.options);
    case "diff":
      return workspace.getDiff(request.options);
    case "diffFiles":
      return workspace.diffFiles(request.options);
    case "diffPatch":
      return workspace.diffPatch(request.options);
    case "commit":
      return workspace.commit(request.options);
  }
}
void main()
  .then((result) => process.stdout.write(JSON.stringify({ ok: true, result })))
  .catch((error: unknown) => {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        code:
          error instanceof Error &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "workspace_failed",
        message:
          error instanceof Error
            ? error.message.slice(0, 4096)
            : "Workspace operation failed",
      }),
    );
    process.exitCode = 1;
  });
