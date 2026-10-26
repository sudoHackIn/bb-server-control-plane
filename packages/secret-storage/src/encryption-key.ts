import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";

const pending = new Map<string, Promise<Buffer>>();
export async function readPrivateEncryptionKey(args: {
  dataDir: string;
  fileName: string;
  createIfMissing: () => boolean;
}): Promise<Buffer> {
  if (
    !isAbsolute(args.dataDir) ||
    !/^[A-Za-z0-9_-]{1,100}$/u.test(args.fileName)
  )
    throw new Error("Invalid encryption key location");
  const path = join(args.dataDir, args.fileName);
  const previous = pending.get(path) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const directory = await lstat(args.dataDir);
      if (
        !directory.isDirectory() ||
        directory.uid !== process.getuid?.() ||
        (directory.mode & 0o077) !== 0
      )
        throw new Error("Encryption keys require a private directory");
      let file: FileHandle;
      try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT" ||
          !args.createIfMissing()
        )
          throw error;
        try {
          const created = await open(path, "wx", 0o600);
          try {
            await created.writeFile(randomBytes(32).toString("hex") + "\n");
            await created.sync();
          } finally {
            await created.close();
          }
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "EEXIST"
          )
            throw error;
        }
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      }
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o077) !== 0 ||
          stat.size !== 65
        )
          throw new Error("Invalid private encryption key");
        const value = (await file.readFile("utf8")).trim();
        if (!/^[a-f0-9]{64}$/u.test(value))
          throw new Error("Invalid private encryption key");
        return Buffer.from(value, "hex");
      } finally {
        await file.close();
      }
    });
  pending.set(path, operation);
  try {
    return await operation;
  } finally {
    if (pending.get(path) === operation) pending.delete(path);
  }
}
