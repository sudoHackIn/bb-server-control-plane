export interface AutomationInputOptions {
  name?: string;
  prompt?: string;
  promptStdin?: boolean;
  script?: string;
  scriptStdin?: boolean;
  timeoutMs?: string;
  at?: string;
  cron?: string;
  timezone?: string;
}
export async function automationInput(options: AutomationInputOptions) {
  const choices = [
    options.prompt !== undefined,
    !!options.promptStdin,
    options.script !== undefined,
    !!options.scriptStdin,
  ].filter(Boolean).length;
  if (choices > 1) throw new Error("Choose one prompt or script input");
  if (
    options.timeoutMs !== undefined &&
    options.script === undefined &&
    !options.scriptStdin
  )
    throw new Error("--timeout-ms requires script input");
  let source = options.script ?? options.prompt;
  if (options.promptStdin || options.scriptStdin) {
    if (process.stdin.isTTY) throw new Error("Pipe the source into stdin");
    source = "";
    process.stdin.setEncoding("utf8");
    const chunks: AsyncIterable<unknown> = process.stdin;
    for await (const part of chunks) {
      if (typeof part !== "string")
        throw new Error("Expected UTF-8 source input");
      source += part;
      if (Buffer.byteLength(source) > (options.scriptStdin ? 262144 : 131072))
        throw new Error("Automation source is too large");
    }
  }
  const script =
    options.script !== undefined || options.scriptStdin
      ? {
          source: source ?? "",
          timeoutMs:
            options.timeoutMs === undefined
              ? 120000
              : Number(options.timeoutMs),
        }
      : undefined;
  const prompt = script ? undefined : source;
  if (
    (options.at !== undefined && options.cron !== undefined) ||
    (options.timezone !== undefined && options.cron === undefined)
  )
    throw new Error("Choose --at or --cron; --timezone requires --cron");
  const trigger =
    options.at !== undefined
      ? {
          triggerType: "once" as const,
          runAt: /^[0-9]+$/u.test(options.at)
            ? Number(options.at)
            : Date.parse(options.at),
        }
      : options.cron !== undefined
        ? {
            triggerType: "schedule" as const,
            cron: options.cron,
            timezone: options.timezone ?? "UTC",
          }
        : undefined;
  return { name: options.name, prompt, script, trigger };
}
