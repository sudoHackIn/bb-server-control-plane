import {
  runIsolatedWorkflow,
  readIsolatedWorkflowInput,
} from "./isolated-evaluator.js";

function write(value: unknown) {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 1048576)
    throw new Error("Workflow response exceeds 1 MiB");
  process.stdout.write(`${encoded}\n`);
}

const controller = new AbortController();
const keepAlive = setInterval(() => {}, 1000);
try {
  const input = await readIsolatedWorkflowInput(process.stdin);
  write({
    type: "ready",
    uid: process.getuid?.(),
    home: process.env.HOME,
    cwd: process.cwd(),
    backendCredential: Boolean(
      process.env.OPENAI_API_KEY || process.env.NEURALDEAP_KEY,
    ),
  });
  const value = await runIsolatedWorkflow(input, write, controller.signal);
  write({ type: "result", value });
} catch (error) {
  write({
    type: "error",
    message:
      error instanceof Error
        ? error.message.slice(0, 4096)
        : "Workflow evaluator failed",
  });
  process.exitCode = 1;
} finally {
  clearInterval(keepAlive);
}
