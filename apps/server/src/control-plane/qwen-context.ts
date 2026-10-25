import { workspaceExecutionRequestSchema } from "@bb/host-daemon-contract";
import { resolveControlPlaneWorkspaceExecution } from "./workspace-execution.js";
import { ApiError } from "../errors.js";
import { createServer } from "node:http";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  rmdir,
  unlink,
  rm,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import {
  ControlPlaneThreadError,
  resolveControlPlaneQwenContext,
  type DbConnection,
} from "@bb/db";
import { z } from "zod";

const requestSchema = z
  .object({
    threadId: z.string().min(1).max(200),
    sessionId: z.string().uuid(),
    cwd: z.string().startsWith("/").max(4096),
  })
  .strict();

function refusedSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const done = (stale: boolean) => {
      socket.destroy();
      resolve(stale);
    };
    socket.once("connect", () => done(false));
    socket.once("error", (error) =>
      done("code" in error && error.code === "ECONNREFUSED"),
    );
    socket.setTimeout(250, () => done(false));
  });
}

async function reclaimStaleContexts(dataDir: string) {
  for (const entry of await readdir(dataDir, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !/^qwen-execution-[A-Za-z0-9]+$/u.test(entry.name)
    )
      continue;
    const directory = join(dataDir, entry.name);
    const socketPath = join(directory, "context.sock");
    try {
      const dir = await lstat(directory);
      if (
        !dir.isDirectory() ||
        dir.uid !== process.getuid?.() ||
        (dir.mode & 0o077) !== 0
      )
        continue;
      const entries = await readdir(directory);
      if (entries.length !== 1 || entries[0] !== "context.sock") continue;
      const socket = await lstat(socketPath);
      if (
        !socket.isSocket() ||
        socket.uid !== process.getuid?.() ||
        (socket.mode & 0o077) !== 0
      )
        continue;
      if (!(await refusedSocket(socketPath))) continue;
      const current = await lstat(socketPath);
      if (current.dev !== socket.dev || current.ino !== socket.ino) continue;
      await unlink(socketPath);
      await rmdir(directory);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        !["ENOENT", "ENOTEMPTY"].includes(String(error.code))
      )
        throw error;
    }
  }
}

export async function startControlPlaneQwenContextService(
  db: DbConnection,
  dataDir: string,
) {
  const stat = await lstat(dataDir);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("Qwen context service requires a private server directory");
  await reclaimStaleContexts(dataDir);
  const directory = await mkdtemp(join(dataDir, "qwen-execution-"));
  const socketPath = join(directory, "context.sock");
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json");
    if (
      request.method !== "POST" ||
      !["/resolve", "/workspace/resolve"].includes(request.url ?? "")
    ) {
      response.writeHead(404).end('{"error":"not_found"}');
      return;
    }
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 8192) {
          response.writeHead(413).end('{"error":"request_too_large"}');
          return;
        }
        chunks.push(bytes);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = null;
      }
      if (request.url === "/workspace/resolve") {
        const parsed = workspaceExecutionRequestSchema.safeParse(body);
        if (!parsed.success) {
          response.writeHead(400).end('{"error":"invalid_request"}');
          return;
        }
        const workspace = resolveControlPlaneWorkspaceExecution(
          db,
          parsed.data.cwd,
        );
        response.writeHead(200).end(JSON.stringify(workspace));
        return;
      }
      const parsed = requestSchema.safeParse(body);
      if (!parsed.success) {
        response.writeHead(400).end('{"error":"invalid_request"}');
        return;
      }
      const context = resolveControlPlaneQwenContext(db, parsed.data);
      response.writeHead(200).end(JSON.stringify(context));
    } catch (error) {
      if (!response.headersSent && !response.destroyed)
        response
          .writeHead(
            error instanceof ApiError
              ? error.status
              : error instanceof ControlPlaneThreadError
                ? 404
                : 500,
          )
          .end('{"error":"execution_unavailable"}');
    }
  });
  server.maxConnections = 32;
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let closing: Promise<void> | null = null;
  return {
    socketPath,
    close() {
      closing ??= (async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(directory, { recursive: true, force: true });
      })();
      return closing;
    },
  };
}
