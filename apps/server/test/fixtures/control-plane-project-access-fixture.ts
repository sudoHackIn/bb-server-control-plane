import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  createConnection,
  migrate,
  ControlPlaneRegistry,
  createControlPlaneProject,
  controlPlaneUsers,
  controlPlaneProjects,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import {
  prepareUserEnvironment,
  prepareUserProject,
  prepareProjectAccess,
} from "../../src/control-plane/provisioning.js";

const input = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("seed") }).strict(),
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
    for (const slug of ["shared", "private", "secondary"]) {
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
