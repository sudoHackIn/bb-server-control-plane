import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveWorkspaceExecution } from "./control-plane-workspace.js";

it("fails closed on revoked, malformed and unavailable authority responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ws-"));
  const socket = join(directory, "s");
  let mode = "revoked";
  const server = createServer((request, response) => {
    request.resume();
    expect(request.url).toBe("/workspace/resolve");
    if (mode === "stalled") return;
    response.writeHead(mode === "revoked" ? 403 : 200);
    response.end(
      mode === "revoked"
        ? '{"error":"denied"}'
        : mode === "bad"
          ? '{"kind":"managed","identity":{"uid":0}}'
          : '{"kind":"unmanaged"}',
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });

  try {
    await expect(
      resolveWorkspaceExecution(socket, "/registered/project"),
    ).rejects.toThrow("not authorized");

    mode = "bad";
    await expect(
      resolveWorkspaceExecution(socket, "/registered/project"),
    ).rejects.toThrow();

    mode = "operator";
    await expect(
      resolveWorkspaceExecution(socket, "/operator/project"),
    ).resolves.toEqual({ kind: "unmanaged" });

    mode = "stalled";
    await expect(
      resolveWorkspaceExecution(socket, "/registered/project"),
    ).rejects.toThrow("Workspace authority unavailable");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }

  await expect(
    resolveWorkspaceExecution(socket, "/registered/project"),
  ).rejects.toThrow();
});
