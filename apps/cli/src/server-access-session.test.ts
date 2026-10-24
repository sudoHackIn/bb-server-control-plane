import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  createServerAccessStore,
  withServerAccessHeaders,
} from "./server-access-session.js";

it.each(["", "agt_"])(
  "keeps credentials with prefix %s private and bound to one origin, preserves explicit auth and rejects unsafe files",
  (prefix) => {
    const directory = mkdtempSync(join(tmpdir(), "bb-cli-session-"));
    const store = createServerAccessStore(directory);
    const origin = "https://bb.example",
      token = prefix + "a".repeat(43);
    try {
      expect(store.read(origin)).toBeNull();
      store.save({ origin, token, expiresAt: Date.now() + 60000 });
      expect(
        withServerAccessHeaders(
          `${origin}/api/v1/projects`,
          undefined,
          store,
        ).get("authorization"),
      ).toBe(`Bearer ${token}`);
      expect(
        withServerAccessHeaders(
          "https://other.example/api/v1/projects",
          undefined,
          store,
        ).has("authorization"),
      ).toBe(false);
      expect(
        withServerAccessHeaders(
          `${origin}/api/v1/projects`,
          { headers: { authorization: "Bearer explicit" } },
          store,
        ).get("authorization"),
      ).toBe("Bearer explicit");
      if (process.platform !== "win32") {
        const path = join(
          directory,
          createHash("sha256").update(origin).digest("hex") + ".json",
        );
        chmodSync(path, 0o644);
        expect(() => store.read(origin)).toThrow("private file");
        chmodSync(path, 0o600);
      }
      store.save({ origin, token, expiresAt: Date.now() - 1 });
      expect(store.read(origin)).toBeNull();
      store.remove(origin);
      expect(store.read(origin)).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
