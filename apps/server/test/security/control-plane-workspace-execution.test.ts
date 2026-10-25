import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { controlPlaneProjectAccess, controlPlaneUsers, projects } from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";
import { resolveControlPlaneWorkspaceExecution } from "../../src/control-plane/workspace-execution.js";

it("resolves only exact registered project roots to their saved numeric owners", () => {
  const db = createMigratedConnection();
  try {
    const { alice, bob } = seedControlPlaneJobSubjects(db);
    for (const subject of [alice, bob]) {
      const cwd = subject.environment.path!;
      expect(resolveControlPlaneWorkspaceExecution(db, cwd)).toEqual({
        kind: "managed",
        identity: {
          userId: subject.user.id,
          uid: subject.user.uid,
          cwd,
          projectId: subject.project.id,
        },
      });
      for (const path of [
        subject.user.home,
        subject.user.projectsRoot,
        `${cwd}/nested`,
        `${cwd}/../app`,
        `${cwd}\0`,
      ])
        expect(() => resolveControlPlaneWorkspaceExecution(db, path)).toThrow(
          "Workspace execution is not authorized",
        );
    }
    expect(
      resolveControlPlaneWorkspaceExecution(db, "/tmp/operator-project"),
    ).toEqual({ kind: "unmanaged" });
  } finally {
    db.$client.close();
  }
});

it("does not downgrade a revoked, disabled or deleted project to operator execution", () => {
  const db = createMigratedConnection();
  try {
    const { alice, bob } = seedControlPlaneJobSubjects(db);
    db.delete(controlPlaneProjectAccess)
      .where(eq(controlPlaneProjectAccess.projectId, alice.project.id))
      .run();
    expect(() =>
      resolveControlPlaneWorkspaceExecution(db, alice.environment.path!),
    ).toThrow();
    expect(
      resolveControlPlaneWorkspaceExecution(db, bob.environment.path!).kind,
    ).toBe("managed");
    db.update(controlPlaneUsers)
      .set({ enabled: false })
      .where(eq(controlPlaneUsers.id, bob.user.id))
      .run();
    expect(() =>
      resolveControlPlaneWorkspaceExecution(db, bob.environment.path!),
    ).toThrow();
    db.update(controlPlaneUsers)
      .set({ enabled: true })
      .where(eq(controlPlaneUsers.id, bob.user.id))
      .run();
    db.update(projects)
      .set({ deletedAt: Date.now() })
      .where(eq(projects.id, bob.project.id))
      .run();
    expect(() =>
      resolveControlPlaneWorkspaceExecution(db, bob.environment.path!),
    ).toThrow();
  } finally {
    db.$client.close();
  }
});

it("serves managed workspace authority only through the private validated socket and refuses injected identities", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { request } = await import("node:http");
  const { startControlPlaneQwenContextService } =
    await import("../../src/control-plane/qwen-context.js");
  const directory = await mkdtemp(join(tmpdir(), "bb-workspace-socket-"));
  const db = createMigratedConnection();
  const { alice } = seedControlPlaneJobSubjects(db);
  const service = await startControlPlaneQwenContextService(db, directory);
  const send = (body: object) =>
    new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const req = request(
          {
            socketPath: service.socketPath,
            path: "/workspace/resolve",
            method: "POST",
          },
          (response) => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (part: string) => {
              text += part;
            });
            response.once("error", reject);
            response.once("end", () =>
              resolve({ status: response.statusCode, body: text }),
            );
          },
        );
        req.once("error", reject);
        req.end(JSON.stringify(body));
      },
    );
  try {
    const valid = await send({ cwd: alice.environment.path });
    expect(valid.status).toBe(200);
    expect(JSON.parse(valid.body)).toMatchObject({
      kind: "managed",
      identity: { uid: alice.user.uid, userId: alice.user.id },
    });
    expect((await send({ cwd: alice.environment.path, uid: 0 })).status).toBe(
      400,
    );
    db.delete(controlPlaneProjectAccess)
      .where(eq(controlPlaneProjectAccess.projectId, alice.project.id))
      .run();
    expect((await send({ cwd: alice.environment.path })).status).toBe(403);
  } finally {
    await service.close();
    db.$client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
