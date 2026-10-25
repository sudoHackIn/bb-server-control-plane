export interface AutomationInputOptions {
  name?: string;
  prompt?: string;
  promptStdin?: boolean;
  at?: string;
  cron?: string;
  timezone?: string;
}
export async function automationInput(options: AutomationInputOptions) {
  if (options.prompt !== undefined && options.promptStdin)
    throw new Error("Choose --prompt or --prompt-stdin");
  let prompt = options.prompt;
  if (options.promptStdin) {
    if (process.stdin.isTTY) throw new Error("Pipe the prompt into stdin");
    prompt = "";
    process.stdin.setEncoding("utf8");
    const chunks: AsyncIterable<unknown> = process.stdin;
    for await (const part of chunks) {
      if (typeof part !== "string")
        throw new Error("Expected UTF-8 prompt input");
      prompt += part;
      if (Buffer.byteLength(prompt) > 131072)
        throw new Error("Automation prompt is too large");
    }
  }
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
  return { name: options.name, prompt, trigger };
}
