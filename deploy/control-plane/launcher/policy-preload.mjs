import { readFileSync } from "node:fs";

const path = process.env.BB_AGENT_POLICY_PATH;
if (!path) throw new Error("Agent policy is unavailable");
const policy = JSON.parse(readFileSync(path, "utf8"));
if (
  !Array.isArray(policy.arguments) ||
  policy.arguments.some((value) => typeof value !== "string") ||
  typeof policy.appendPrompt !== "string"
)
  throw new Error("Invalid agent policy");
if (process.env.BB_AGENT_POLICY_APPLIED !== path) {
  process.argv.push(...policy.arguments);
  if (policy.appendPrompt)
    process.argv.push(`--append-system-prompt=${policy.appendPrompt}`);
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL)
    process.argv.push(
      "--openai-api-key",
      process.env.OPENAI_API_KEY,
      "--openai-base-url",
      process.env.OPENAI_BASE_URL,
    );
  process.env.BB_AGENT_POLICY_APPLIED = path;
}
