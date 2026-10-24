import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const sessionSchema = z
  .object({
    origin: z.string().url(),
    token: z.string().regex(/^(?:agt_)?[A-Za-z0-9_-]{43}$/u),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type ServerAccessSession = z.infer<typeof sessionSchema>;

export function createServerAccessStore(
  directory = join(homedir(), ".bb", "server-access"),
) {
  const pathFor = (origin: string) =>
    join(
      directory,
      createHash("sha256").update(origin).digest("hex") + ".json",
    );
  return {
    read(origin: string): ServerAccessSession | null {
      const path = pathFor(origin);
      let stat;
      try {
        stat = lstatSync(path);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw new Error("Could not read server access session");
      }
      if (
        !stat.isFile() ||
        (process.platform !== "win32" &&
          ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
      )
        throw new Error(
          "Server access session must be a private file owned by the client user",
        );
      try {
        const value = sessionSchema.parse(
          JSON.parse(readFileSync(path, "utf8")),
        );
        if (value.origin !== origin) throw new Error("Origin mismatch");
        return value.expiresAt > Date.now() ? value : null;
      } catch {
        throw new Error("Invalid server access session");
      }
    },
    save(session: ServerAccessSession) {
      const value = sessionSchema.parse(session);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = pathFor(value.origin),
        temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(value) + "\n", {
          mode: 0o600,
          flag: "wx",
        });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    remove(origin: string) {
      rmSync(pathFor(origin), { force: true });
    },
  };
}

export function withServerAccessHeaders(
  input: RequestInfo | URL,
  init?: RequestInit,
  store = createServerAccessStore(),
): Headers {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  if (!headers.has("authorization")) {
    const session = store.read(url.origin);
    if (session) headers.set("authorization", `Bearer ${session.token}`);
  }
  return headers;
}
