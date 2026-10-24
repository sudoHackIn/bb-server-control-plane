export const INITIALIZE_TIMEOUT_MS = 60000;
export const AUTH_TIMEOUT_MS = 10 * 60000;
export function authNotice(message: unknown):
  | {
      key: string;
      text: string;
    }
  | undefined {
  if (!message || typeof message !== "object") return;
  const event = message as Record<string, unknown>;
  if (event.type !== "system" || event.subtype !== "auth_required") return;
  let url: string | undefined;
  if (
    typeof event.url === "string" &&
    event.url.length <= 8192 &&
    !/[\x00-\x20\x7f]/.test(event.url)
  ) {
    try {
      const parsed = new URL(event.url);
      if (
        ["https:", "http:"].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password
      )
        url = parsed.href;
    } catch {}
  }
  return {
    key: url ?? "no-url",
    text: url
      ? `Требуется авторизация Qwen. [Открыть страницу входа](<${url}>). После входа Qwen продолжит работу автоматически.`
      : "Требуется авторизация Qwen. Ссылка для входа не получена; выполните вход через Qwen на хосте запуска.",
  };
}
export function initializationWait(
  initialized: Promise<unknown>,
  signal: AbortSignal,
  normalMs = INITIALIZE_TIMEOUT_MS,
  authMs = AUTH_TIMEOUT_MS,
) {
  let authSeen = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  let rejectWait: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    rejectWait = reject;
    timer = setTimeout(
      () => reject(new Error("Qwen initialization timed out")),
      normalMs,
    );
    initialized.then(() => resolve(), reject);
  });
  const aborted = () => rejectWait(new Error("Qwen initialization cancelled"));
  if (signal.aborted) aborted();
  else signal.addEventListener("abort", aborted, { once: true });
  const wait = promise.finally(() => {
    settled = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", aborted);
  });
  return {
    wait,
    authRequired() {
      if (authSeen || settled) return;
      authSeen = true;
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          rejectWait(
            new Error(
              "Qwen authorization timed out; open the sign-in link and retry",
            ),
          ),
        authMs,
      );
    },
  };
}
