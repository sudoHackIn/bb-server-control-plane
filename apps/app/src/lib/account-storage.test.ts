// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});
it("keeps drafts, enumeration and clearing inside a document's immutable account scope", async () => {
  const module = await import("./account-storage");
  localStorage.setItem("bb.promptbox.contents", "legacy-private");
  localStorage.setItem(
    module.accountStoragePrefix("user:bob") + "bb.promptbox.contents",
    "bob-private",
  );
  module.configureAccountStorage("user:alice");
  const storage = module.accountLocalStorage();
  expect(storage.getItem("bb.promptbox.contents")).toBeNull();
  storage.setItem("bb.promptbox.contents", "alice-private");
  expect(storage.length).toBe(1);
  expect(storage.key(0)).toBe("bb.promptbox.contents");
  expect(storage.key(1)).toBeNull();
  expect(module.accountSessionStorage().getItem("draft")).toBeNull();
  module.accountSessionStorage().setItem("draft", "alice-session");
  expect(sessionStorage.getItem("draft")).toBeNull();
  expect(() => module.configureAccountStorage("user:bob")).toThrow(
    "fresh application context",
  );
  storage.setItem("late-write", "still-alice");
  expect(
    localStorage.getItem(
      module.accountStoragePrefix("user:bob") + "late-write",
    ),
  ).toBeNull();
  storage.clear();
  expect(storage.length).toBe(0);
  expect(
    localStorage.getItem(
      module.accountStoragePrefix("user:bob") + "bb.promptbox.contents",
    ),
  ).toBe("bob-private");
  expect(localStorage.getItem("bb.promptbox.contents")).toBe("legacy-private");
  expect(module.accountDatabaseName("bb-voice-recordings")).toBe(
    "bb-voice-recordings.user%3Aalice",
  );
});
it("maps only this account's real local-storage events to native draft keys", async () => {
  const module = await import("./account-storage");
  module.configureAccountStorage("admin:operator");
  expect(
    module.accountStorageEventKey({
      storageArea: localStorage,
      key: module.accountStoragePrefix("admin:operator") + "draft",
    }),
  ).toBe("draft");
  expect(
    module.accountStorageEventKey({
      storageArea: localStorage,
      key: module.accountStoragePrefix("user:alice") + "draft",
    }),
  ).toBeNull();
  expect(
    module.accountStorageEventKey({
      storageArea: sessionStorage,
      key: module.accountStoragePrefix("admin:operator") + "draft",
    }),
  ).toBeNull();
  expect(
    module.accountStorageEventKey({ storageArea: localStorage, key: "draft" }),
  ).toBeNull();
});
it("preserves standalone storage and refuses late identity changes after data has been read", async () => {
  const module = await import("./account-storage");
  localStorage.setItem("draft", "standalone");
  expect(module.accountLocalStorage().getItem("draft")).toBe("standalone");
  expect(() => module.configureAccountStorage("user:alice")).toThrow();
  module.configureAccountStorage(null);
  expect(module.accountDatabaseName("bb-voice-recordings")).toBe(
    "bb-voice-recordings",
  );
});
