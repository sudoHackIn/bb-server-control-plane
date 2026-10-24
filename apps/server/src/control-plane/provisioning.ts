import { execFile } from "node:child_process";
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
