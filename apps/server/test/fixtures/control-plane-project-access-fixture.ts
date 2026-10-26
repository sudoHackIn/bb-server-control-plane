import { randomUUID } from "node:crypto";
import { createControlPlaneProjectMaintenanceCoordinator } from "../../src/control-plane/project-maintenance.js";
import { createControlPlaneUidMaintenanceCoordinator } from "../../src/control-plane/uid-maintenance.js";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  createConnection,
  threads,
  createQueuedThreadMessage,
  requireControlPlaneThreadDispatch,
  reserveControlPlaneUidMaintenance,
  controlPlaneThreads,
  getControlPlaneProjectMaintenance,
  reserveControlPlaneProjectMaintenance,
  checkpointControlPlaneProjectMaintenance,
  checkpointControlPlaneUidMaintenance,
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
  inspectProjectAccess,
  listUidMaintenanceJobs,
  stopUidMaintenanceJob,
} from "../../src/control-plane/provisioning.js";

const input = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("seed") }).strict(),
    z
      .object({
        mode: z.literal("native-group"),
        threadIds: z.array(z.string()).min(1).max(2),
        operationId: z.string().uuid(),
        queue: z.boolean(),
        workerPid: z.number().int().positive().optional(),
      })
      .strict(),
    z
      .object({
        mode: z.literal("native-maintenance"),
        action: z.enum(["begin", "finish"]),
        threadId: z.string(),
        operationId: z.string().uuid(),
      })
      .strict(),
    z
      .object({
        mode: z.enum(["group", "group-cut-release"]),
        projectId: z.string(),
        operationId: z.string().uuid(),
        expectedAttempt: z.number().int().positive().optional(),
      })
      .strict(),
    z
      .object({
        mode: z.literal("group-status"),
        operationId: z.string().uuid(),
      })
      .strict(),
    z
      .object({
        mode: z.literal("role-group"),
        projectId: z.string(),
        userId: z.string().uuid(),
        role: z.enum(["runner", "viewer"]).nullable(),
        expectedRevision: z.number().int().positive(),
        operationId: z.string().uuid(),
      })
      .strict(),
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
const db = createConnection(
  input.mode === "native-maintenance" || input.mode === "native-group"
    ? "/srv/bb/bb.db"
    : "/srv/bb/acl-check.db",
);
try {
  if (input.mode === "native-group") {
    const contexts = input.threadIds.map((threadId) =>
      requireControlPlaneThreadDispatch(db, threadId),
    );
    const first = contexts[0];
    if (!first) throw new Error("Missing native group context");
    if (
      contexts.some(
        (context) =>
          !context ||
          context.user.id !== first.user.id ||
          context.project.projectId !== first.project.projectId,
      )
    )
      throw new Error("Native group ownership changed");
    const policy = getControlPlaneProjectAccessPolicy(
      db,
      first.project.projectId,
    );
    if (!policy) throw new Error("Missing native policy");
    const root = await inspectProjectAccess(
      policy.owner,
      policy.project.projectId,
      policy.project.slug,
    );
    const identities = new Map(
      [policy.owner, ...policy.members].map((user) => [user.id, user]),
    );
    for (const writer of root.writers) {
      const user = db
        .select()
        .from(controlPlaneUsers)
        .where(eq(controlPlaneUsers.id, writer.userId))
        .get();
      if (!user || user.uid !== writer.uid)
        throw new Error("Native writer changed");
      identities.set(user.id, user);
    }
    const participants: {
      userId: string;
      uid: number;
      rootGeneration: number;
    }[] = [];
    for (const user of identities.values())
      participants.push({
        userId: user.id,
        uid: user.uid,
        rootGeneration: (
          await controlPlaneUidMaintenance(user, { action: "status" })
        ).generation,
      });
    const result = db.transaction(
      () => {
        const group = reserveControlPlaneProjectMaintenance(db, {
          id: input.operationId,
          projectId: policy.project.projectId,
          projectRevision: policy.revision,
          workerId: randomUUID(),
          workerPid: input.workerPid ?? process.pid,
          participants,
        });
        const queueIds = input.queue
          ? input.threadIds.map(
              (threadId, index) =>
                createQueuedThreadMessage(db, noopNotifier, {
                  threadId,
                  content: [
                    {
                      type: "text",
                      text:
                        index === 0
                          ? "BB_ACCESS_MAINTENANCE_CONTINUE_ACTIVE"
                          : "BB_ACCESS_MAINTENANCE_CONTINUE_PAUSED",
                      mentions: [],
                    },
                  ],
                  model: first.profileVersion.definition.model,
                  reasoningLevel:
                    first.profileVersion.definition.reasoningLevel,
                  permissionMode: "full",
                  serviceTier: "default",
                  senderThreadId: threadId,
                  waitingOn: { kind: "thread-busy" },
                  sendAt: null,
                  payload: { kind: "inline" },
                  systemNotice: null,
                }).id,
            )
          : [];
        return { group, queueIds };
      },
      { behavior: "immediate" },
    );
    process.stdout.write(JSON.stringify(result));
  } else if (input.mode === "native-maintenance") {
    const binding = db
      .select({ thread: threads, owner: controlPlaneUsers })
      .from(controlPlaneThreads)
      .innerJoin(threads, eq(threads.id, controlPlaneThreads.threadId))
      .innerJoin(
        controlPlaneUsers,
        eq(controlPlaneUsers.id, controlPlaneThreads.ownerUserId),
      )
      .where(eq(threads.id, input.threadId))
      .get();
    if (!binding) throw new Error("Missing native thread");
    const projectId = binding.thread.projectId;
    const coordinator = createControlPlaneUidMaintenanceCoordinator(db);
    if (input.action === "begin") {
      const context = requireControlPlaneThreadDispatch(db, input.threadId);
      if (!context) throw new Error("Missing native context");
      const root = await controlPlaneUidMaintenance(binding.owner, {
        action: "status",
      });
      const queued = db.transaction(
        () => {
          const intent = reserveControlPlaneUidMaintenance(db, {
            userId: binding.owner.id,
            projectId,
            operationId: input.operationId,
            rootGeneration: root.generation,
          });
          const row = createQueuedThreadMessage(db, noopNotifier, {
            threadId: input.threadId,
            content: [
              {
                type: "text",
                text: "BB_MANAGED_ALICE maintenance preserved queue",
                mentions: [],
              },
            ],
            model: context.profileVersion.definition.model,
            reasoningLevel: context.profileVersion.definition.reasoningLevel,
            permissionMode: "full",
            serviceTier: "default",
            senderThreadId: input.threadId,
            waitingOn: { kind: "thread-busy" },
            sendAt: null,
            payload: { kind: "inline" },
            systemNotice: null,
          });
          return { intent, row };
        },
        { behavior: "immediate" },
      );
      const intent = await coordinator.begin({
        userId: binding.owner.id,
        projectId,
        operationId: input.operationId,
      });
      process.stdout.write(JSON.stringify({ intent, queuedId: queued.row.id }));
    } else {
      const intent = coordinator.status(binding.owner.id);
      const policy = getControlPlaneProjectAccessPolicy(db, projectId);
      if (!intent || intent.operationId !== input.operationId || !policy)
        throw new Error("Missing native intent");
      const pendingJobs = await listUidMaintenanceJobs(
        binding.owner,
        intent.generation,
      );
      if (pendingJobs.length)
        throw new Error(
          `Native UID still has ${pendingJobs.length} launcher jobs`,
        );
      await prepareProjectAccess({
        owner: policy.owner,
        projectId,
        slug: policy.project.slug,
        revision: policy.revision,
        members: policy.members,
      });
      if (
        !acknowledgeControlPlaneProjectAccessPolicy(
          db,
          projectId,
          policy.revision,
        )
      )
        throw new Error("Policy changed");
      process.stdout.write(
        JSON.stringify(
          await coordinator.finish({
            userId: binding.owner.id,
            operationId: intent.operationId,
            generation: intent.generation,
          }),
        ),
      );
    }
  } else if (input.mode === "seed") {
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
    for (const slug of ["shared", "private", "secondary", "policy", "cohort"]) {
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
  } else if (input.mode === "group-status") {
    process.stdout.write(
      JSON.stringify(
        getControlPlaneProjectMaintenance(db, input.operationId) ?? null,
      ),
    );
  } else if (
    input.mode === "group" ||
    input.mode === "group-cut-release" ||
    input.mode === "role-group"
  ) {
    const stopThreads = async (userId: string) => {
      if (
        db
          .select()
          .from(controlPlaneThreads)
          .where(eq(controlPlaneThreads.ownerUserId, userId))
          .get()
      )
        throw new Error("Fixture cannot stop native threads");
    };
    if (input.mode === "group" || input.mode === "role-group") {
      const coordinator = createControlPlaneProjectMaintenanceCoordinator({
        db,
        stopThreads,
      });
      process.stdout.write(
        JSON.stringify(
          input.mode === "role-group"
            ? await coordinator.changeRole({
                projectId: input.projectId,
                userId: input.userId,
                role: input.role,
                expectedRevision: input.expectedRevision,
                operationId: input.operationId,
              })
            : await coordinator.reconcile({
                projectId: input.projectId,
                operationId: input.operationId,
                ...(input.expectedAttempt === undefined
                  ? {}
                  : { expectedAttempt: input.expectedAttempt }),
              }),
        ),
      );
    } else {
      const policy = getControlPlaneProjectAccessPolicy(db, input.projectId);
      if (!policy) throw new Error("Missing policy");
      const root = await inspectProjectAccess(
        policy.owner,
        input.projectId,
        policy.project.slug,
      );
      const identities = new Map(
        [policy.owner, ...policy.members].map((row) => [row.id, row]),
      );
      for (const writer of root.writers) {
        const identity = db
          .select()
          .from(controlPlaneUsers)
          .where(eq(controlPlaneUsers.id, writer.userId))
          .get();
        if (!identity || identity.uid !== writer.uid)
          throw new Error("Writer changed");
        identities.set(identity.id, identity);
      }
      const participants = [];
      for (const identity of identities.values())
        participants.push({
          userId: identity.id,
          uid: identity.uid,
          rootGeneration: (
            await controlPlaneUidMaintenance(identity, { action: "status" })
          ).generation,
        });
      const workerId = randomUUID();
      let group = reserveControlPlaneProjectMaintenance(db, {
        id: input.operationId,
        projectId: input.projectId,
        projectRevision: policy.revision,
        workerId,
        workerPid: process.pid,
        participants,
      });
      for (const participant of group.participants) {
        const identity = identities.get(participant.userId);
        if (!identity) throw new Error("Missing participant");
        await controlPlaneUidMaintenance(identity, {
          action: "begin",
          generation: participant.generation,
        });
        if (
          !checkpointControlPlaneUidMaintenance(
            db,
            identity.id,
            group.id,
            participant.generation,
            "blocked",
          )
        )
          throw new Error("Activation failed");
      }
      group = checkpointControlPlaneProjectMaintenance(
        db,
        group.id,
        group.attempt,
        workerId,
        "draining",
      );
      for (const participant of group.participants) {
        const identity = identities.get(participant.userId);
        if (!identity) throw new Error("Missing participant");
        await stopThreads(identity.id);
        for (const job of await listUidMaintenanceJobs(
          identity,
          participant.generation,
        ))
          await stopUidMaintenanceJob(identity, job);
        if (
          (await listUidMaintenanceJobs(identity, participant.generation))
            .length
        )
          throw new Error("Jobs remain");
      }
      group = checkpointControlPlaneProjectMaintenance(
        db,
        group.id,
        group.attempt,
        workerId,
        "applying",
      );
      await prepareProjectAccess({
        owner: policy.owner,
        projectId: input.projectId,
        slug: policy.project.slug,
        revision: policy.revision,
        members: policy.members,
      });
      if (
        !acknowledgeControlPlaneProjectAccessPolicy(
          db,
          input.projectId,
          policy.revision,
        )
      )
        throw new Error("Acknowledgement failed");
      group = checkpointControlPlaneProjectMaintenance(
        db,
        group.id,
        group.attempt,
        workerId,
        "releasing",
      );
      const owner = group.participants.find(
        (row) => row.userId === policy.owner.id,
      );
      if (!owner) throw new Error("Missing owner");
      await controlPlaneUidMaintenance(policy.owner, {
        action: "finish",
        generation: owner.generation,
      });
      process.stdout.write(JSON.stringify(group));
    }
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
  } else if (input.mode === "sync") {
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
