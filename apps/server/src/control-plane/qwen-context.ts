import { createServer } from "node:http";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
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
  const directory = await mkdtemp(join(dataDir, "qwen-execution-"));
  const socketPath = join(directory, "context.sock");
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json");
    if (request.method !== "POST" || request.url !== "/resolve") {
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
          .writeHead(error instanceof ControlPlaneThreadError ? 404 : 500)
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
