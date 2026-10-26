import { createControlPlaneUidMaintenanceCoordinator } from "../../src/control-plane/uid-maintenance.js";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  createConnection,
  migrate,
  ControlPlaneRegistry,
  createControlPlaneProject,
  controlPlaneUsers,
  controlPlaneProjects,
  controlPlaneProjectAccess,
  getControlPlaneProjectAccessPolicy,
  acknowledgeControlPlaneProjectAccessPolicy,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import {
  prepareUserEnvironment,
  prepareUserProject,
  prepareProjectAccess,
  controlPlaneUidMaintenance,
} from "../../src/control-plane/provisioning.js";

const input = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("seed") }).strict(),
    z
      .object({
        mode: z.literal("coordinate"),
        userId: z.string().uuid(),
        request: z.discriminatedUnion("action", [
          z.object({ action: z.literal("status") }).strict(),
          z
            .object({
              action: z.literal("begin"),
              projectId: z.string(),
              operationId: z.string().uuid(),
              restartGeneration: z.number().int().positive().optional(),
            })
            .strict(),
          z
            .object({
              action: z.literal("finish"),
              operationId: z.string().uuid(),
              generation: z.number().int().positive(),
            })
            .strict(),
        ]),
      })
      .strict(),
    z
      .object({
        mode: z.literal("maintenance"),
        userId: z.string().uuid(),
        request: z.discriminatedUnion("action", [
          z.object({ action: z.literal("status") }).strict(),
          z
            .object({
              action: z.enum(["begin", "finish"]),
              generation: z
                .number()
                .int()
                .positive()
                .max(Number.MAX_SAFE_INTEGER),
            })
            .strict(),
        ]),
      })
      .strict(),
    z
      .object({
        mode: z.literal("policy-grant"),
        projectId: z.string(),
        userId: z.string().uuid(),
        role: z.enum(["runner", "viewer"]).nullable(),
      })
      .strict(),
    z
      .object({ mode: z.literal("policy-apply"), projectId: z.string() })
      .strict(),
    z
      .object({
        mode: z.literal("policy-receipt"),
        projectId: z.string(),
        revision: z.number().int().positive(),
      })
      .strict(),
    z
      .object({
        mode: z.literal("sync"),
        projectId: z.string(),
        revision: z.number().int().positive(),
        memberIds: z.array(z.string().uuid()),
      })
      .strict(),
  ])
  .parse(JSON.parse(process.argv[2] ?? "null"));
const db = createConnection("/srv/bb/acl-check.db");
try {
  if (input.mode === "seed") {
    migrate(db);
    const registry = new ControlPlaneRegistry(db, {
      usersRoot: "/srv/agent-users",
      firstUid: 210000,
      lastUid: 219999,
    });
    const host = upsertHost(db, noopNotifier, { name: "Project ACL fixture" });
    const users = [];
    for (const login of ["acl-alice", "acl-bob", "acl-charlie"]) {
      const user = registry.reserve(login, Date.now());
      await prepareUserEnvironment(user);
      const ready = registry.environmentState(user.id, "ready");
      if (!ready) throw new Error("Fixture user unavailable");
      users.push(ready);
    }
    const owner = users[0];
    if (!owner) throw new Error("Missing owner");
    const projects = [];
    for (const slug of ["shared", "private", "secondary", "policy"]) {
      await prepareUserProject(owner, slug);
      const result = createControlPlaneProject(db, noopNotifier, {
        userId: owner.id,
        hostId: host.id,
        name: slug,
        slug,
      });
      const row = db
        .select()
        .from(controlPlaneProjects)
        .where(eq(controlPlaneProjects.projectId, result.project.id))
        .get();
      if (!row) throw new Error("Missing project");
      projects.push(row);
    }
    process.stdout.write(JSON.stringify({ users, projects }));
  } else if (input.mode === "coordinate") {
    const coordinator = createControlPlaneUidMaintenanceCoordinator(db);
    const request = input.request;
    const result =
      request.action === "status"
        ? coordinator.status(input.userId)
        : request.action === "begin"
          ? await coordinator.begin({
              userId: input.userId,
              projectId: request.projectId,
              operationId: request.operationId,
              ...(request.restartGeneration !== undefined
                ? { restartGeneration: request.restartGeneration }
                : {}),
            })
          : await coordinator.finish({
              userId: input.userId,
              operationId: request.operationId,
              generation: request.generation,
            });
    process.stdout.write(JSON.stringify(result ?? null));
  } else if (input.mode === "maintenance") {
    const user = db
      .select()
      .from(controlPlaneUsers)
      .where(eq(controlPlaneUsers.id, input.userId))
      .get();
    if (!user) throw new Error("Unknown maintenance identity");
    process.stdout.write(
      JSON.stringify(await controlPlaneUidMaintenance(user, input.request)),
    );
  } else if (input.mode === "policy-grant") {
    if (input.role === null)
      db.delete(controlPlaneProjectAccess)
        .where(
          and(
            eq(controlPlaneProjectAccess.projectId, input.projectId),
            eq(controlPlaneProjectAccess.userId, input.userId),
          ),
        )
        .run();
    else
      db.insert(controlPlaneProjectAccess)
        .values({
          projectId: input.projectId,
          userId: input.userId,
          role: input.role,
        })
        .onConflictDoUpdate({
          target: [
            controlPlaneProjectAccess.projectId,
            controlPlaneProjectAccess.userId,
          ],
          set: { role: input.role },
        })
        .run();
    const policy = getControlPlaneProjectAccessPolicy(db, input.projectId);
    if (!policy) throw new Error("Missing saved policy");
    process.stdout.write(
      JSON.stringify({
        revision: policy.revision,
        appliedRevision: policy.appliedRevision,
        memberIds: policy.members.map((user) => user.id),
      }),
    );
  } else if (input.mode === "policy-apply") {
    const policy = getControlPlaneProjectAccessPolicy(db, input.projectId);
    if (!policy) throw new Error("Missing saved policy");
    const result = await prepareProjectAccess({
      owner: policy.owner,
      projectId: policy.project.projectId,
      slug: policy.project.slug,
      revision: policy.revision,
      members: policy.members,
    });
    if (
      !acknowledgeControlPlaneProjectAccessPolicy(
        db,
        input.projectId,
        result.revision,
      )
    )
      throw new Error("Policy changed during application");
    process.stdout.write(JSON.stringify(result));
  } else if (input.mode === "policy-receipt") {
    process.stdout.write(
      JSON.stringify({
        accepted: acknowledgeControlPlaneProjectAccessPolicy(
          db,
          input.projectId,
          input.revision,
        ),
      }),
    );
  } else {
    const project = db
      .select()
      .from(controlPlaneProjects)
      .where(eq(controlPlaneProjects.projectId, input.projectId))
      .get();
    if (!project) throw new Error("Unknown project");
    const owner = db
      .select()
      .from(controlPlaneUsers)
      .where(eq(controlPlaneUsers.id, project.ownerUserId))
      .get();
    if (!owner) throw new Error("Unknown owner");
    const members = input.memberIds.map((id) => {
      const user = db
        .select()
        .from(controlPlaneUsers)
        .where(eq(controlPlaneUsers.id, id))
        .get();
      if (!user) throw new Error("Unknown member");
      return user;
    });
    const result = await prepareProjectAccess({
      owner,
      slug: project.slug,
      projectId: project.projectId,
      revision: input.revision,
      members,
    });
    process.stdout.write(JSON.stringify(result));
  }
} finally {
  db.$client.close();
}
