import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { query } from "@qwen-code/sdk";
import { fileURLToPath } from "node:url";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_assembleCapturedThreadEvents } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { authNotice, initializationWait } from "../src/auth.js";
import { harness, options, until } from "./helpers.js";
test("optional auth event accepts only safe URLs and leaves other events alone", () => {
  assert.equal(authNotice({ type: "system", subtype: "init" }), undefined);
  assert.equal(
    authNotice({ type: "assistant", subtype: "auth_required" }),
    undefined,
  );
  for (const url of [
    undefined,
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:pass@example.com",
    "https://example.com/\n",
  ]) {
    const notice = authNotice({
      type: "system",
      subtype: "auth_required",
      url,
    });
    assert(notice?.text.includes("Ссылка для входа не получена"));
    assert(!notice?.text.includes("]("));
  }
  assert(
    authNotice({
      type: "system",
      subtype: "auth_required",
      url: "https://example.com/auth?state=123",
    })?.text.includes("https://example.com/auth?state=123"),
  );
});
test("auth extends startup deadline once; normal timeout and cancellation still work", async () => {
  vi.useFakeTimers();
  try {
    const abort = new AbortController();
    const never = new Promise<void>(() => {});
    const normal = initializationWait(never, abort.signal, 60, 600);
    const normalFailure = assert.rejects(
      normal.wait,
      /initialization timed out/,
    );
    vi.advanceTimersByTime(60);
    await normalFailure;
    const login = initializationWait(never, abort.signal, 60, 600);
    login.authRequired();
    vi.advanceTimersByTime(100);
    login.authRequired();
    const loginFailure = assert.rejects(login.wait, /authorization timed out/);
    vi.advanceTimersByTime(500);
    await loginFailure;
    const cancelled = initializationWait(never, abort.signal, 60, 600);
    const cancelledFailure = assert.rejects(cancelled.wait, /cancelled/);
    abort.abort();
    await cancelledFailure;
  } finally {
    vi.useRealTimers();
  }
});
const executable = fileURLToPath(
  new URL("./fixtures/qwen-cli.mjs", import.meta.url),
);
const authHarness = () =>
  harness((config) =>
    query({
      ...config,
      options: {
        ...config.options,
        env: { ...config.options.env, QWEN_FIXTURE_AUTH_REQUIRED: "1" },
      },
    }),
  );
test("real SDK delivers pre-initialization auth URL, then resumes the same turn", async () => {
  const h = authHarness();
  try {
    await h.initialize();
    const {
      result: { providerThreadId },
    } = await h.start();
    await h.turn(providerThreadId, "hello", {
      options: { ...options, providerOptions: { executable } },
    });
    await until(() => h.deltas().find((d) => d.kind === "turn.boundary"));
    for (const delta of h.deltas()) threadDeltaSchema.parse(delta);
    const events = experimental_assembleCapturedThreadEvents(
      h.notifications(),
      "qwen",
    );
    const messages = events.flatMap((e) =>
      e.type === "item/completed" && e.item.type === "agentMessage"
        ? [e.item]
        : [],
    );
    const notices = messages.filter((e) =>
      e.text.includes("Требуется авторизация"),
    );
    assert.equal(notices.length, 1);
    assert(
      notices[0].text.includes(
        "[Открыть страницу входа](<https://login.example.invalid/signin?state=fixture>)",
      ),
    );
    assert(messages.some((e) => e.text === "real SDK transport answer"));
    assert(
      h
        .deltas()
        .some((d) => d.kind === "turn.boundary" && d.status === "completed"),
    );
  } finally {
    await h.bridge.onClose?.();
  }
});
test("model discovery reports auth recovery without a user prompt or invented thread", async () => {
  const h = authHarness();
  try {
    await h.initialize();
    const response = await h.rpc("model/list", {
      cwd: "/tmp",
      providerOptions: { executable },
    });
    assert.equal(response.error?.data?.recovery?.kind, "authRequired");
    assert(response.error?.message.includes("https://login.example.invalid/"));
    assert.deepEqual(h.deltas(), []);
  } finally {
    await h.bridge.onClose?.();
  }
});
test("stop while waiting for login cancels startup and does not submit the prompt", async () => {
  const h = authHarness();
  try {
    await h.initialize();
    const {
      result: { providerThreadId },
    } = await h.start();
    await h.turn(providerThreadId, "hello", {
      options: { ...options, providerOptions: { executable } },
    });
    await until(() =>
      h
        .deltas()
        .find(
          (d) =>
            d.kind === "item.open" &&
            d.item.type === "agentMessage" &&
            d.item.text.includes("Требуется авторизация"),
        ),
    );
    await h.rpc("thread/stop", {
      threadId: "bb-test",
      providerThreadId,
      intent: "release",
      activeTurnId: null,
    });
    const boundaries = h.deltas().filter((d) => d.kind === "turn.boundary");
    assert.equal(boundaries.length, 1);
    assert.equal(boundaries[0].status, "interrupted");
    assert(
      !h
        .deltas()
        .some(
          (d) =>
            d.kind === "item.close" &&
            d.item.type === "agentMessage" &&
            d.item.text === "real SDK transport answer",
        ),
    );
  } finally {
    await h.bridge.onClose?.();
  }
});
