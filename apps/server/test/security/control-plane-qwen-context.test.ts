import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ControlPlaneRegistry,
  createControlPlaneProject,
  createEnvironment,
  createThread,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { expect, it } from "vitest";
import { startControlPlaneQwenContextService } from "../../src/control-plane/qwen-context.js";

function send(socketPath: string, body: object, path = "/resolve") {
  return new Promise<{ status: number | undefined; body: unknown }>(
    (resolve, reject) => {
      const req = request({ socketPath, path, method: "POST" }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (part: string) => {
          text += part;
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const body: unknown = JSON.parse(text);
            resolve({ status: res.statusCode, body });
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    },
  );
}

it("serves only validated owned thread/session bindings on a private Unix socket and cleans up on close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bb-cp-context-"));
  const db = createMigratedConnection();
  const registry = new ControlPlaneRegistry(db, {
    usersRoot: "/srv/users",
    firstUid: 200000,
    lastUid: 299999,
  });
  const user = registry.reserve("alice", 1);
  registry.environmentState(user.id, "ready");
  const host = upsertHost(db, noopNotifier, { name: "Host" });
  const { project } = createControlPlaneProject(db, noopNotifier, {
    userId: user.id,
    hostId: host.id,
    name: "App",
    slug: "app",
  });
  const cwd = `${user.projectsRoot}/app`;
  const environment = createEnvironment(db, noopNotifier, {
    projectId: project.id,
    hostId: host.id,
    path: cwd,
    status: "ready",
    providerOwnsPath: false,
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "qwen-server",
    controlPlaneOwnerUserId: user.id,
  });
  const service = await startControlPlaneQwenContextService(db, directory);
  try {
    expect((await lstat(service.socketPath)).mode & 0o777).toBe(0o600);
    const body = { threadId: thread.id, cwd, sessionId: randomUUID() };
    expect(await send(service.socketPath, body)).toEqual({
      status: 200,
      body: {
        ...body,
        id: user.id,
        user: user.login,
        uid: user.uid,
        gid: user.gid,
        home: user.home,
      },
    });
    expect((await send(service.socketPath, { ...body, uid: 0 })).status).toBe(
      400,
    );
    expect(
      (await send(service.socketPath, { ...body, sessionId: "../session" }))
        .status,
    ).toBe(400);
    expect(
      (await send(service.socketPath, { ...body, threadId: "thr_other" }))
        .status,
    ).toBe(404);
    expect(
      (await send(service.socketPath, { ...body, cwd: "/etc" })).status,
    ).toBe(404);
    expect((await send(service.socketPath, body, "/other")).status).toBe(404);
  } finally {
    await service.close();
    await service.close();
    await expect(lstat(service.socketPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    db.$client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
