import {
  controlPlaneBrowserContextSchema,
  type ControlPlaneBrowserContext,
} from "@bb/domain";
import {
  browserIdentityMarker,
  clearAccountStorage,
  clearInactiveAccountStorage,
  configureAccountStorage,
} from "./account-storage";

function scopeFor(context: ControlPlaneBrowserContext): string | null {
  return context.mode === "admin" || context.mode === "user"
    ? `${context.mode}:${context.identity}`
    : null;
}
function markerFor(context: ControlPlaneBrowserContext): string {
  return context.mode === "admin" || context.mode === "user"
    ? `${scopeFor(context)}@${context.cacheEpoch}`
    : context.mode;
}
function storedIdentity(): string | null {
  try {
    return window.localStorage.getItem(browserIdentityMarker);
  } catch {
    return null;
  }
}
function rememberIdentity(scope: string) {
  try {
    window.localStorage.setItem(browserIdentityMarker, scope);
  } catch {}
}
function clearStorage(scope: string | null) {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      clearAccountStorage(window[name], scope);
    } catch {}
  }
}
function resetVoiceDatabase(scope: string | null) {
  const name =
    scope === null
      ? "bb-voice-recordings"
      : `bb-voice-recordings.${encodeURIComponent(scope)}`;
  return clearVoiceDatabase(name);
}
function clearVoiceDatabase(name: string) {
  if (typeof indexedDB === "undefined") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name);
    let database: IDBDatabase | undefined;
    const timeout = setTimeout(() => {
      database?.close();
      reject(new Error("Unable to clear browser recordings"));
    }, 5000);
    const failed = () => {
      clearTimeout(timeout);
      database?.close();
      reject(new Error("Unable to clear browser recordings"));
    };
    request.onupgradeneeded = () =>
      request.result.createObjectStore("recordings");
    request.onerror = failed;
    request.onsuccess = () => {
      database = request.result;
      const names = Array.from(database.objectStoreNames);
      if (names.length === 0) {
        clearTimeout(timeout);
        database.close();
        resolve();
        return;
      }
      const transaction = database.transaction(names, "readwrite");
      for (const name of names) transaction.objectStore(name).clear();
      transaction.oncomplete = () => {
        clearTimeout(timeout);
        database?.close();
        resolve();
      };
      transaction.onerror = failed;
      transaction.onabort = failed;
    };
  });
}
async function pruneInactiveData(scope: string | null) {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      clearInactiveAccountStorage(window[name], scope);
    } catch {}
  }
  if (
    typeof indexedDB === "undefined" ||
    typeof indexedDB.databases !== "function"
  )
    return;
  const active =
    scope === null
      ? "bb-voice-recordings"
      : `bb-voice-recordings.${encodeURIComponent(scope)}`;
  for (const database of await indexedDB.databases()) {
    const name = database.name;
    if (
      name &&
      name !== active &&
      (name === "bb-voice-recordings" ||
        name.startsWith("bb-voice-recordings."))
    )
      await clearVoiceDatabase(name);
  }
}
async function readContext(): Promise<ControlPlaneBrowserContext> {
  const response = await fetch("/control-plane/browser-context", {
    cache: "no-store",
    credentials: "same-origin",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Unable to verify browser identity");
  const raw: unknown = await response.json();
  return controlPlaneBrowserContextSchema.parse(raw);
}
export async function startBrowserApplication(
  loadNative: () => Promise<() => () => void>,
): Promise<() => void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing application root");
  const context = await readContext();
  const scope = scopeFor(context);
  const marker = markerFor(context);
  const storageScope = scope === null ? null : marker;
  const previous = storedIdentity();
  if (
    previous !== marker &&
    !(context.mode === "standalone" && previous === null)
  ) {
    rememberIdentity("transition");
    const old =
      previous?.startsWith("admin:") || previous?.startsWith("user:")
        ? previous
        : null;
    clearStorage(old);
    clearStorage(storageScope);
    clearStorage(null);
    await Promise.all(
      [...new Set([old, storageScope, null])].map(resetVoiceDatabase),
    );
  }
  await pruneInactiveData(storageScope);
  configureAccountStorage(
    scope,
    "cacheEpoch" in context ? context.cacheEpoch : null,
  );
  rememberIdentity(marker);
  if (context.mode === "anonymous" || context.mode === "user") {
    window.location.replace(
      context.mode === "user"
        ? "/control-plane/user"
        : previous?.startsWith("user:")
          ? "/control-plane/user/login"
          : "/control-plane/login",
    );
    return () => {};
  }
  let dispose: (() => void) | undefined;
  let stopped = false;
  let checking = false;
  let generation = 0;
  let interval: ReturnType<typeof setInterval> | undefined;
  let paused = false;
  let savedTitle = "";
  let savedDisplay = "";
  let savedDisplayPriority = "";
  const hide = () => {
    if (!paused) {
      savedTitle = document.title;
      savedDisplay = document.body.style.getPropertyValue("display");
      savedDisplayPriority = document.body.style.getPropertyPriority("display");
      paused = true;
    }
    document.body.style.setProperty("display", "none", "important");
    document.title = "BB";
  };
  const show = (restoreTitle = true) => {
    if (paused) {
      if (savedDisplay)
        document.body.style.setProperty(
          "display",
          savedDisplay,
          savedDisplayPriority,
        );
      else document.body.style.removeProperty("display");
      if (restoreTitle && document.title === "BB") document.title = savedTitle;
      paused = false;
    }
    if (!restoreTitle) document.title = "BB";
  };
  function stop() {
    if (stopped) return;
    stopped = true;
    if (interval) clearInterval(interval);
    window.removeEventListener("storage", storageChanged);
    window.removeEventListener("focus", focused);
    window.removeEventListener("pageshow", focused);
    window.removeEventListener("pagehide", pageHidden);
    document.removeEventListener("visibilitychange", visibilityChanged);
    dispose?.();
    show(false);
  }
  const changed = () => {
    hide();
    stop();
    if (storedIdentity() === marker) rememberIdentity("transition");
    clearStorage(storageScope);
    document.getElementById("bb-app-theme")?.remove();
    void resetVoiceDatabase(storageScope).then(
      () => window.location.reload(),
      () => {
        show(false);
        root.textContent =
          "Unable to clear browser recordings. Reload to reconnect.";
      },
    );
  };
  const check = async (force = false) => {
    if (stopped || (checking && !force)) return;
    const current = ++generation;
    checking = true;
    try {
      const value = await readContext();
      if (stopped || current !== generation) return;
      if (markerFor(value) !== marker) return changed();
      if (document.visibilityState !== "hidden") show();
    } catch {
      if (stopped || current !== generation) return;
      hide();
      stop();
      show(false);
      root.textContent =
        "Unable to verify your BB session. Reload to reconnect.";
    } finally {
      if (current === generation) checking = false;
    }
  };
  function storageChanged(event: StorageEvent) {
    if (
      (event.key === browserIdentityMarker && event.newValue !== marker) ||
      event.key === null
    )
      changed();
  }
  function focused() {
    hide();
    void check(true);
  }
  function pageHidden() {
    hide();
    generation++;
    checking = false;
  }
  function visibilityChanged() {
    if (document.visibilityState === "hidden") hide();
    else focused();
  }
  window.addEventListener("storage", storageChanged);
  window.addEventListener("focus", focused);
  window.addEventListener("pageshow", focused);
  window.addEventListener("pagehide", pageHidden);
  document.addEventListener("visibilitychange", visibilityChanged);
  interval = setInterval(() => {
    void check();
  }, 5000);
  try {
    const mount = await loadNative();
    const latest = await readContext();
    if (stopped) return stop;
    if (markerFor(latest) !== marker) {
      changed();
      return stop;
    }
    dispose = mount();
    if (document.visibilityState === "hidden") hide();
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}
