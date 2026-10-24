// @vitest-environment jsdom

import "fake-indexeddb/auto";
import { createStore, get, set } from "idb-keyval";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let stop: (() => void) | undefined;
const realWindow = window;
const reload = vi.fn();
const replace = vi.fn();
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
  reload.mockClear();
  replace.mockClear();
  vi.stubGlobal("window", {
    localStorage,
    sessionStorage,
    location: { origin: "https://bb.example", reload, replace },
    addEventListener: realWindow.addEventListener.bind(realWindow),
    removeEventListener: realWindow.removeEventListener.bind(realWindow),
  });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("verifies identity and clears old sidebar/draft/recording data before importing the native application", async () => {
  const storage = await import("./account-storage");
  localStorage.setItem(storage.browserIdentityMarker, "user:alice");
  localStorage.setItem(
    storage.accountStoragePrefix("user:alice") + "bb.sidebar-bootstrap.1",
    "private-alice",
  );
  localStorage.setItem("bb.promptbox.contents", "legacy-private");
  sessionStorage.setItem("old-session-draft", "private-alice");
  const voice = createStore("bb-voice-recordings.user%3Aalice", "recordings");
  await set("old-audio", { text: "private-alice" }, voice);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        mode: "admin",
        identity: "operator",
        cacheEpoch: "a".repeat(64),
      }),
    ),
  );
  const { startBrowserApplication } = await import("./browser-bootstrap");
  const dispose = vi.fn();
  stop = await startBrowserApplication(async () => {
    expect(
      localStorage.getItem(
        storage.accountStoragePrefix("user:alice") + "bb.sidebar-bootstrap.1",
      ),
    ).toBeNull();
    expect(localStorage.getItem("bb.promptbox.contents")).toBeNull();
    expect(sessionStorage.getItem("old-session-draft")).toBeNull();
    expect(await get("old-audio", voice)).toBeUndefined();
    expect(storage.activeBrowserIdentity()).toBe("admin:operator");
    return () => dispose;
  });
  realWindow.dispatchEvent(
    new StorageEvent("storage", {
      key: storage.browserIdentityMarker,
      newValue: "user:bob",
      storageArea: localStorage,
    }),
  );
  expect(dispose).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
});
it("preserves existing standalone drafts and delays mounting until the second identity check", async () => {
  localStorage.setItem("bb.promptbox.contents", "standalone-draft");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ mode: "standalone" })),
  );
  const { startBrowserApplication } = await import("./browser-bootstrap");
  const mount = vi.fn(() => vi.fn());
  stop = await startBrowserApplication(async () => {
    expect(mount).not.toHaveBeenCalled();
    expect(localStorage.getItem("bb.promptbox.contents")).toBe(
      "standalone-draft",
    );
    return mount;
  });
  expect(mount).toHaveBeenCalledOnce();
});
it("does not import the full administrative app for a personal or anonymous identity", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        mode: "user",
        identity: "11111111-1111-4111-8111-111111111111",
        login: "alice",
        cacheEpoch: "a".repeat(64),
      }),
    ),
  );
  const { startBrowserApplication } = await import("./browser-bootstrap");
  const load = vi.fn();
  stop = await startBrowserApplication(load);
  expect(load).not.toHaveBeenCalled();
  expect(replace).toHaveBeenCalledWith("/control-plane/user");
});
it("drops an administrative load if the session changes while its module is loading", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        calls++ === 0
          ? { mode: "admin", identity: "operator", cacheEpoch: "a".repeat(64) }
          : { mode: "anonymous" },
      ),
    ),
  );
  const { startBrowserApplication } = await import("./browser-bootstrap");
  const mount = vi.fn(() => vi.fn());
  stop = await startBrowserApplication(async () => mount);
  expect(mount).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
});
it("fails closed before loading data for a malformed or unavailable identity response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ mode: "admin", identity: null })),
  );
  const { startBrowserApplication } = await import("./browser-bootstrap");
  const load = vi.fn();
  await expect(startBrowserApplication(load)).rejects.toThrow();
  expect(load).not.toHaveBeenCalled();
});

it("retires a previous view when the same account receives a different browser credential", async () => {
  let epoch = "a".repeat(64);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ mode: "admin", identity: "operator", cacheEpoch: epoch }),
    ),
  );
  const { startBrowserApplication } = await import("./browser-bootstrap");
  const dispose = vi.fn();
  stop = await startBrowserApplication(async () => () => dispose);
  epoch = "b".repeat(64);
  realWindow.dispatchEvent(new Event("pageshow"));
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expect(dispose).toHaveBeenCalledOnce();
});

it("hides portal content and the previous title while a restored page awaits identity verification", async () => {
  const context = {
    mode: "admin",
    identity: "operator",
    cacheEpoch: "a".repeat(64),
  };
  let delayed = false;
  let resolveContext: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      delayed
        ? new Promise<Response>((resolve) => {
            resolveContext = resolve;
          })
        : Response.json(context),
    ),
  );
  const { startBrowserApplication } = await import("./browser-bootstrap");
  const portal = document.createElement("div");
  stop = await startBrowserApplication(async () => () => {
    document.title = "Private project";
    portal.textContent = "Private approval details";
    document.body.appendChild(portal);
    return () => portal.remove();
  });
  delayed = true;
  realWindow.dispatchEvent(new Event("pageshow"));
  expect(document.body.style.getPropertyValue("display")).toBe("none");
  expect(document.body.style.getPropertyPriority("display")).toBe("important");
  expect(document.title).toBe("BB");
  if (!resolveContext) throw new Error("Missing restored-page check");
  resolveContext(Response.json({ mode: "anonymous" }));
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expect(portal.isConnected).toBe(false);
  expect(document.title).toBe("BB");
});
