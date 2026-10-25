import { readFile } from "node:fs/promises";
export interface WorkflowSourceOptions {
  script?: string;
  scriptStdin?: boolean;
  file?: string;
}
export async function readWorkflowScript(
  options: WorkflowSourceOptions,
): Promise<string> {
  if (
    [
      options.script !== undefined,
      Boolean(options.scriptStdin),
      options.file !== undefined,
    ].filter(Boolean).length !== 1
  )
    throw new Error("Choose exactly one of --script, --script-stdin or --file");
  let script = options.script ?? "";
  if (options.file) {
    const buffer = await readFile(options.file);
    if (buffer.byteLength > 524288)
      throw new Error("Workflow script is too large");
    script = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  }
  if (options.scriptStdin) {
    if (process.stdin.isTTY) throw new Error("Pipe the script into stdin");
    process.stdin.setEncoding("utf8");
    for await (const part of process.stdin) {
      script += part;
      if (Buffer.byteLength(script) > 524288)
        throw new Error("Workflow script is too large");
    }
  }
  return script;
}
