import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { serverQuery } from "./qwen-server-query.mjs";
import { createRuntimeFixture } from "./qwen-runtime-fixture.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
const runtime = await createRuntimeFixture(config);
const sessionId = config.sessionId ?? randomUUID();
process.env.QWEN_SERVER_CONTEXT_SOCKET = runtime.socketPath;
const abort = new AbortController();
const stopRequested = new Promise((resolve) =>
  process.once("SIGUSR2", resolve),
);
const prompt = (async function* () {
  yield {
    type: "user",
    session_id: sessionId,
    uuid: randomUUID(),
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: `BB_JOB_TEST ${config.marker} ${config.mode}`,
    },
  };
  if (!abort.signal.aborted)
    await new Promise((resolve) =>
      abort.signal.addEventListener("abort", resolve, { once: true }),
    );
})();
const query = serverQuery({
  prompt,
  threadId: runtime.threadId,
  options: {
    cwd: config.cwd,
    model: "qwen-job-test",
    permissionMode: "yolo",
    safeMode: true,
    includePartialMessages: true,
    abortController: abort,
    ...(config.sessionId ? { resume: sessionId } : { sessionId }),
    timeout: { controlRequest: 30000 },
    systemPrompt: {
      type: "preset",
      preset: "qwen_code",
      append: `BB_ARGV_PRIVATE_${config.marker}`,
    },
  },
});
const deadline = setTimeout(() => abort.abort(), 45000);
let result = false;
try {
  await query.initialized;
  if (config.mode === "hang") {
    let last = "";
    const draining = (async () => {
      for await (const message of query) {
        last = JSON.stringify(message).slice(-2000);
      }
    })();
    void draining.catch(() => {});
    await Promise.race([
      stopRequested,
      new Promise((resolve) =>
        abort.signal.addEventListener("abort", resolve, { once: true }),
      ),
    ]);
    assert.equal(
      abort.signal.aborted,
      false,
      `Native tool did not start: ${last}`,
    );
    abort.abort();
    await query.close();
    await draining.catch(() => {});
    result = true;
  } else {
    for await (const message of query) {
      if (message.type === "result") {
        assert.equal(message.is_error, false);
        result = true;
        break;
      }
    }
  }
  assert.ok(result, "Qwen did not complete");
  process.stdout.write(
    JSON.stringify({
      sessionId,
      threadId: runtime.threadId,
      marker: config.marker,
      completed: true,
    }) + "\n",
  );
} finally {
  clearTimeout(deadline);
  abort.abort();
  await query.close();
  await runtime.close();
}
