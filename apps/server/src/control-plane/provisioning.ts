import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { ControlPlaneRegistry, ControlPlaneUser } from "@bb/db";
import { z } from "zod";

const exec = promisify(execFile);
const helper = "/opt/bb-control-plane/launcher/helper.py";
const preparedSchema = z
  .object({
    userId: z.string().uuid(),
    uid: z.number().int(),
    gid: z.number().int(),
    home: z.string(),
    projectsRoot: z.string(),
    cwd: z.string(),
  })
  .strict();
type Prepared = z.infer<typeof preparedSchema>;

export async function prepareUserEnvironment(
  user: ControlPlaneUser,
): Promise<Prepared> {
  const { stdout } = await exec(
    "/usr/bin/sudo",
    ["-n", "--", helper, "provision", user.id, String(user.uid)],
    {
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      timeout: 30000,
      maxBuffer: 16384,
    },
  );
  return preparedSchema.parse(JSON.parse(stdout));
}

export async function prepareUserProject(
  user: ControlPlaneUser,
  slug: string,
): Promise<string> {
  const { stdout } = await exec(
    "/usr/bin/sudo",
    ["-n", "--", helper, "project", user.id, String(user.uid), slug],
    {
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      timeout: 30000,
      maxBuffer: 16384,
    },
  );
  return z.object({ cwd: z.string() }).strict().parse(JSON.parse(stdout)).cwd;
}

export function createControlPlaneProvisioner(
  registry: ControlPlaneRegistry,
  prepare = prepareUserEnvironment,
) {
  const pending = new Map<string, Promise<ControlPlaneUser>>();
  return (user: ControlPlaneUser): Promise<ControlPlaneUser> => {
    const active = pending.get(user.id);
    if (active) return active;
    const operation = (async () => {
      const current = registry.environmentState(user.id, "provisioning");
      if (!current) throw new Error("User is disabled");
      try {
        const result = await prepare(current);
        if (
          result.userId !== current.id ||
          result.uid !== current.uid ||
          result.gid !== current.gid ||
          result.home !== current.home ||
          result.projectsRoot !== current.projectsRoot ||
          result.cwd !== join(current.projectsRoot, "default")
        )
          throw new Error("Provisioner returned another environment");
        const ready = registry.environmentState(current.id, "ready");
        if (!ready) throw new Error("User was disabled during provisioning");
        return ready;
      } catch {
        registry.environmentState(current.id, "failed");
        throw new Error("Environment provisioning failed");
      }
    })();
    pending.set(user.id, operation);
    void operation.finally(() => pending.delete(user.id)).catch(() => {});
    return operation;
  };
}

export async function prepareProjectAccess(input: {
  owner: ControlPlaneUser;
  projectId: string;
  slug: string;
  revision: number;
  members: readonly ControlPlaneUser[];
}) {
  const request = z
    .object({
      projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u),
      slug: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/u),
      revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      members: z
        .array(
          z
            .object({
              userId: z.string().uuid(),
              uid: z.number().int().min(200000).max(299999),
            })
            .strict(),
        )
        .max(128),
    })
    .strict()
    .parse({
      projectId: input.projectId,
      slug: input.slug,
      revision: input.revision,
      members: input.members.map((user) => {
        if (
          !user.enabled ||
          user.environmentStatus !== "ready" ||
          user.gid !== user.uid
        )
          throw new Error("Project member environment is not ready");
        return { userId: user.id, uid: user.uid };
      }),
    });
  const ownerId = z.string().uuid().parse(input.owner.id);
  const uid = z.number().int().min(200000).max(299999).parse(input.owner.uid);
  if (input.owner.gid !== uid)
    throw new Error("Unexpected project owner identity");
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "/usr/bin/sudo",
      [
        "-n",
        "--",
        helper,
        "project-access",
        ownerId,
        String(uid),
        request.slug,
        request.projectId,
        String(request.revision),
      ],
      {
        cwd: "/",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        stdio: "pipe",
      },
    );
    let stdout = "";
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Project access synchronization timed out"));
    }, 30000);
    child.stdout.setEncoding("utf8").on("data", (part: string) => {
      if (settled) return;
      stdout += part;
      if (Buffer.byteLength(stdout) > 16384) {
        child.kill("SIGTERM");
        finish(new Error("Invalid project access response"));
      }
    });
    child.stderr.resume();
    child.once("error", () =>
      finish(new Error("Project access helper unavailable")),
    );
    child.stdin.on("error", () =>
      finish(new Error("Project access helper input failed")),
    );
    child.once("close", (code) =>
      finish(
        code === 0 ? null : new Error("Project access synchronization failed"),
      ),
    );
    child.stdin.end(JSON.stringify({ members: request.members }));
  });
  const reply = z
    .object({
      projectId: z.string(),
      revision: z.number().int(),
      cwd: z.string(),
      memberCount: z.number().int(),
      state: z.literal("ready"),
    })
    .strict()
    .parse(JSON.parse(result));
  if (
    reply.projectId !== request.projectId ||
    reply.revision !== request.revision ||
    reply.memberCount !== request.members.length ||
    reply.cwd !== join(input.owner.projectsRoot, request.slug)
  )
    throw new Error("Project access helper returned another binding");
  return reply;
}

export async function controlPlaneUidMaintenance(
  user: ControlPlaneUser,
  request:
    | { action: "status" }
    | { action: "begin" | "finish"; generation: number },
) {
  const userId = z.string().uuid().parse(user.id);
  const uid = z.number().int().min(200000).max(299999).parse(user.uid);
  if (user.gid !== uid) throw new Error("Unexpected maintenance identity");
  const operation = z
    .discriminatedUnion("action", [
      z.object({ action: z.literal("status") }).strict(),
      z
        .object({
          action: z.enum(["begin", "finish"]),
          generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
    ])
    .parse(request);
  let stdout: string;
  try {
    ({ stdout } = await exec(
      "/usr/bin/sudo",
      [
        "-n",
        "--",
        helper,
        "uid-maintenance",
        userId,
        String(uid),
        operation.action,
        ...(operation.action === "status"
          ? []
          : [String(operation.generation)]),
      ],
      {
        cwd: "/",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        timeout: 30000,
        maxBuffer: 16384,
      },
    ));
  } catch {
    throw new Error("UID maintenance operation failed");
  }
  const reply = z
    .object({
      userId: z.string().uuid(),
      uid: z.number().int(),
      generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      blocked: z.boolean(),
    })
    .strict()
    .parse(JSON.parse(stdout));
  if (
    reply.userId !== userId ||
    reply.uid !== uid ||
    (operation.action !== "status" &&
      (reply.generation !== operation.generation ||
        reply.blocked !== (operation.action === "begin")))
  )
    throw new Error("UID maintenance helper returned another binding");
  return reply;
}

async function maintenanceHelper(
  user: ControlPlaneUser,
  operation: string,
  args: string[],
) {
  const id = z.string().uuid().parse(user.id),
    uid = z.number().int().min(200000).max(299999).parse(user.uid);
  if (user.gid !== uid) throw new Error("Unexpected maintenance identity");
  try {
    const result = await exec(
      "/usr/bin/sudo",
      ["-n", "--", helper, operation, id, String(uid), ...args],
      {
        cwd: "/",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        timeout: 30000,
        maxBuffer: 65536,
      },
    );
    return result.stdout;
  } catch {
    throw new Error("Privileged maintenance operation failed");
  }
}
export async function inspectProjectAccess(
  owner: ControlPlaneUser,
  projectId: string,
  slug: string,
) {
  const reply = z
    .object({
      projectId: z.string(),
      cwd: z.string(),
      revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      phase: z.enum(["absent", "pending", "ready"]),
      writers: z
        .array(
          z
            .object({
              userId: z.string().uuid(),
              uid: z.number().int().min(200000).max(299999),
            })
            .strict(),
        )
        .max(1024),
      requiresGlobalIdle: z.boolean(),
    })
    .strict()
    .parse(
      JSON.parse(
        await maintenanceHelper(owner, "project-access-status", [
          slug,
          projectId,
        ]),
      ),
    );
  if (
    reply.projectId !== projectId ||
    reply.cwd !== join(owner.projectsRoot, slug)
  )
    throw new Error("Project inspection returned another binding");
  return reply;
}
export async function listUidMaintenanceJobs(
  user: ControlPlaneUser,
  generation: number,
) {
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(generation);
  const reply = z
    .object({
      userId: z.string().uuid(),
      uid: z.number().int(),
      generation: z.number().int(),
      jobs: z.array(z.string().uuid()).max(256),
    })
    .strict()
    .parse(
      JSON.parse(
        await maintenanceHelper(user, "uid-maintenance", [
          "jobs",
          String(generation),
        ]),
      ),
    );
  if (
    reply.userId !== user.id ||
    reply.uid !== user.uid ||
    reply.generation !== generation
  )
    throw new Error("Job inspection returned another binding");
  return reply.jobs;
}
export async function stopUidMaintenanceJob(
  user: ControlPlaneUser,
  jobId: string,
) {
  await maintenanceHelper(user, "stop", [z.string().uuid().parse(jobId)]);
}
