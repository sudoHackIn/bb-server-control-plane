import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readPrivateEncryptionKey } from "../src/index.js";

it("serializes first creation and persists a private key without replacing unreadable existing keys", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-key-"));
  const args = { dataDir, fileName: "test-key", createIfMissing: () => true };
  try {
    const keys = await Promise.all(
      Array.from({ length: 8 }, () => readPrivateEncryptionKey(args)),
    );
    expect(keys.every((key) => key.equals(keys[0]!))).toBe(true);
    expect(keys[0]?.length).toBe(32);
    expect((await stat(join(dataDir, args.fileName))).mode & 0o777).toBe(0o600);
    await chmod(join(dataDir, args.fileName), 0o644);
    await expect(readPrivateEncryptionKey(args)).rejects.toThrow();
    await chmod(join(dataDir, args.fileName), 0o600);
    expect(
      (
        await readPrivateEncryptionKey({
          ...args,
          createIfMissing: () => false,
        })
      ).equals(keys[0]!),
    ).toBe(true);
    await rm(join(dataDir, args.fileName));
    await expect(
      readPrivateEncryptionKey({ ...args, createIfMissing: () => false }),
    ).rejects.toThrow();
    await expect(stat(join(dataDir, args.fileName))).rejects.toThrow();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

it("refuses symlinks, malformed keys, public directories and path traversal", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-key-"));
  const args = { dataDir, fileName: "test-key", createIfMissing: () => true };
  try {
    await writeFile(join(dataDir, "target"), "a".repeat(64) + "\n", {
      mode: 0o600,
    });
    await symlink(join(dataDir, "target"), join(dataDir, args.fileName));
    await expect(readPrivateEncryptionKey(args)).rejects.toThrow();
    await rm(join(dataDir, args.fileName));
    await writeFile(join(dataDir, args.fileName), "invalid\n", { mode: 0o600 });
    await expect(readPrivateEncryptionKey(args)).rejects.toThrow();
    await expect(
      readPrivateEncryptionKey({ ...args, fileName: "../outside" }),
    ).rejects.toThrow();
    await chmod(dataDir, 0o755);
    await expect(readPrivateEncryptionKey(args)).rejects.toThrow();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
