import { verifyProjectUidLeases } from "./check-control-plane-uid-leases.mjs";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
const exec = promisify(execFile);
const helper = "/opt/bb-control-plane/launcher/helper.py";
export async function verifyProjectDirectoryAccess() {
  const service = async (input) => {
    const reply = await exec(
      "/usr/bin/setpriv",
      [
        "--reuid=1000",
        "--regid=1000",
        "--clear-groups",
        process.execPath,
        "apps/server/dist/project-access-check.mjs",
        JSON.stringify(input),
      ],
      { cwd: "/opt/bb", timeout: 35000, maxBuffer: 65536 },
    );
    return JSON.parse(reply.stdout);
  };
  const seed = await service({ mode: "seed" });
  const [alice, bob, charlie] = seed.users;
  const shared = seed.projects.find((row) => row.slug === "shared"),
    privateProject = seed.projects.find((row) => row.slug === "private"),
    secondary = seed.projects.find((row) => row.slug === "secondary");
  const as = async (user, code) =>
    exec(
      "/usr/bin/setpriv",
      [
        "--reuid=" + user.uid,
        "--regid=" + user.gid,
        "--clear-groups",
        "--no-new-privs",
        process.execPath,
        "-e",
        code,
      ],
      {
        cwd: user.home,
        env: { HOME: user.home, PATH: "/usr/local/bin:/usr/bin:/bin" },
        timeout: 15000,
        maxBuffer: 65536,
      },
    );
  const denied = async (user, path) =>
    assert.rejects(
      as(user, `require("node:fs").readFileSync(${JSON.stringify(path)})`),
      (error) => error.stderr?.includes("EACCES"),
    );
  const sync = (revision, members) =>
    service({
      mode: "sync",
      projectId: shared.projectId,
      revision,
      memberIds: members.map((user) => user.id),
    });
  const raw = async ({
    owner = alice,
    slug = shared.slug,
    projectId = shared.projectId,
    revision = 1,
    members = [],
  } = {}) => {
    const child = spawn(
      "/usr/bin/setpriv",
      [
        "--reuid=1000",
        "--regid=1000",
        "--clear-groups",
        "/usr/bin/sudo",
        "-n",
        "--",
        helper,
        "project-access",
        owner.id,
        String(owner.uid),
        slug,
        projectId,
        String(revision),
      ],
      { stdio: "pipe" },
    );
    let text = "";
    child.stdout.on("data", (part) => (text += part));
    child.stderr.resume();
    const done = once(child, "exit");
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ members }));
    const [code] = await done;
    return { code, text };
  };
  await as(
    alice,
    `const fs=require("node:fs"),root=${JSON.stringify(shared.cwd)};fs.mkdirSync(root+"/tree",{recursive:true});for(let i=0;i<2048;i++)fs.writeFileSync(root+"/tree/item-"+i,"shared");fs.writeFileSync(root+"/existing.txt","owner");fs.writeFileSync(process.env.HOME+"/credential.txt","private-home");fs.writeFileSync(${JSON.stringify(privateProject.cwd + "/private.txt")},"private-project");fs.symlinkSync(process.env.HOME+"/credential.txt",root+"/home-link");fs.symlinkSync(${JSON.stringify(privateProject.cwd + "/private.txt")},root+"/private-link");`,
  );
  const protectedPaths = [
    alice.home,
    alice.home + "/credential.txt",
    privateProject.cwd,
    privateProject.cwd + "/private.txt",
  ];
  const aclDigest = async () => {
    const reply = await exec("/usr/bin/getfacl", [
      "--absolute-names",
      "--numeric",
      ...protectedPaths,
    ]);
    return createHash("sha256").update(reply.stdout).digest("hex");
  };
  const before = await aclDigest();
  await denied(bob, shared.cwd + "/existing.txt");
  assert.equal((await sync(1, [bob, charlie])).state, "ready");
  const proof = await as(
    bob,
    `const fs=require("node:fs"),root=${JSON.stringify(shared.cwd)};if(fs.readFileSync(root+"/existing.txt","utf8")!=="owner")process.exit(1);fs.mkdirSync(root+"/bob-directory");fs.writeFileSync(root+"/bob-directory/new.txt","bob");console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),home:process.env.HOME}));`,
  );
  assert.deepEqual(JSON.parse(proof.stdout), {
    uid: bob.uid,
    gid: bob.gid,
    groups: [bob.gid],
    home: bob.home,
  });
  for (const user of [alice, charlie])
    assert.equal(
      (
        await as(
          user,
          `console.log(require("node:fs").readFileSync(${JSON.stringify(shared.cwd + "/bob-directory/new.txt")},"utf8"))`,
        )
      ).stdout.trim(),
      "bob",
    );
  for (const path of [
    alice.home + "/credential.txt",
    privateProject.cwd + "/private.txt",
    shared.cwd + "/home-link",
    shared.cwd + "/private-link",
    "/var/lib/bb-agent-launcher/project-access",
  ])
    await denied(bob, path);
  assert.equal(await aclDigest(), before);
  await sync(1, [charlie, bob]);
  assert.notEqual(
    (await raw({ members: [{ userId: bob.id, uid: bob.uid }] })).code,
    0,
  );
  assert.notEqual(
    (await raw({ members: [{ userId: charlie.id, uid: bob.uid }] })).code,
    0,
  );
  assert.notEqual(
    (await raw({ members: [{ userId: randomUUID(), uid: 219999 }] })).code,
    0,
  );
  assert.notEqual(
    (await raw({ slug: privateProject.slug, revision: 2 })).code,
    0,
  );
  assert.notEqual(
    (await raw({ projectId: "proj_alias", revision: 2 })).code,
    0,
  );
  const direct = await exec(
    "/usr/bin/setpriv",
    [
      "--reuid=1000",
      "--regid=1000",
      "--clear-groups",
      "/usr/bin/sudo",
      "-n",
      "--",
      helper,
      "launch",
      bob.id,
      String(bob.uid),
      randomUUID(),
      shared.cwd,
      "--",
      "--version",
    ],
    { timeout: 5000, maxBuffer: 16384 },
  ).then(
    () => false,
    () => true,
  );
  assert.equal(direct, true, "Legacy launch accepted a foreign cwd");
  await as(
    alice,
    `require("node:fs").writeFileSync(${JSON.stringify(secondary.cwd + "/allowed.txt")},"secondary")`,
  );
  await service({
    mode: "sync",
    projectId: secondary.projectId,
    revision: 1,
    memberIds: [bob.id],
  });
  await sync(2, [charlie]);
  await as(
    bob,
    `require("node:fs").readFileSync(${JSON.stringify(secondary.cwd + "/allowed.txt")})`,
  );
  await assert.rejects(
    as(
      bob,
      `require("node:fs").readdirSync(${JSON.stringify(alice.projectsRoot)})`,
    ),
    (error) => error.stderr?.includes("EACCES"),
  );

  await denied(bob, shared.cwd + "/existing.txt");
  await as(
    charlie,
    `require("node:fs").readFileSync(${JSON.stringify(shared.cwd + "/bob-directory/new.txt")})`,
  );
  assert.notEqual(
    (
      await raw({
        revision: 1,
        members: [
          { userId: bob.id, uid: bob.uid },
          { userId: charlie.id, uid: charlie.uid },
        ],
      })
    ).code,
    0,
  );
  await denied(bob, shared.cwd + "/existing.txt");
  await as(
    alice,
    `require("node:fs").linkSync(process.env.HOME+"/credential.txt",${JSON.stringify(shared.cwd + "/hard-link")})`,
  );
  await assert.rejects(sync(3, [bob, charlie]));
  await as(
    charlie,
    `require("node:fs").readFileSync(${JSON.stringify(shared.cwd + "/existing.txt")})`,
  );
  await denied(bob, shared.cwd + "/existing.txt");
  assert.equal(await aclDigest(), before);
  assert.notEqual(
    (
      await raw({
        revision: 2,
        members: [{ userId: charlie.id, uid: charlie.uid }],
      })
    ).code,
    0,
  );
  await as(
    alice,
    `require("node:fs").unlinkSync(${JSON.stringify(shared.cwd + "/hard-link")})`,
  );
  await sync(3, [bob, charlie]);
  await as(
    bob,
    `require("node:fs").readFileSync(${JSON.stringify(shared.cwd + "/existing.txt")})`,
  );
  await as(
    alice,
    `const fs=require("node:fs"),root=${JSON.stringify(shared.cwd)};fs.renameSync(root,root+"-held");fs.symlinkSync(process.env.HOME,root);`,
  );
  await assert.rejects(sync(4, []));
  assert.equal(await aclDigest(), before);
  await as(
    alice,
    `const fs=require("node:fs"),root=${JSON.stringify(shared.cwd)};fs.unlinkSync(root);fs.renameSync(root+"-held",root);`,
  );
  await sync(4, [bob, charlie]);
  await as(
    alice,
    `require("node:child_process").execFileSync("/usr/bin/mkfifo",[${JSON.stringify(shared.cwd + "/unsupported-fifo")}])`,
  );
  await assert.rejects(sync(5, []));
  await as(
    alice,
    `require("node:fs").unlinkSync(${JSON.stringify(shared.cwd + "/unsupported-fifo")})`,
  );
  await sync(5, []);
  await service({
    mode: "sync",
    projectId: secondary.projectId,
    revision: 2,
    memberIds: [],
  });

  for (const user of [bob, charlie])
    await denied(user, shared.cwd + "/existing.txt");
  await assert.rejects(
    as(
      bob,
      `require("node:child_process").execFileSync("/usr/bin/sudo",["-n","--",${JSON.stringify(helper)},"project-access",${JSON.stringify(alice.id)},${JSON.stringify(String(alice.uid))},"shared",${JSON.stringify(shared.projectId)},"5"],{input:JSON.stringify({members:[]})});`,
    ),
  );
  assert.equal(await aclDigest(), before);
  const names = await readdir("/var/lib/bb-agent-launcher/project-access");
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) =>
        JSON.parse(
          await readFile(
            "/var/lib/bb-agent-launcher/project-access/" + name,
            "utf8",
          ),
        ),
      ),
  );
  const record = records.find((row) => row.projectId === shared.projectId);
  assert.equal(record.revision, 5);
  assert.equal(record.phase, "ready");
  assert.deepEqual(record.members, []);
  const policyProject = seed.projects.find((row) => row.slug === "policy");
  await as(
    alice,
    `require("node:fs").writeFileSync(${JSON.stringify(policyProject.cwd + "/policy.txt")},"saved-policy")`,
  );
  const changePolicy = (role) =>
    service({
      mode: "policy-grant",
      projectId: policyProject.projectId,
      userId: bob.id,
      role,
    });
  const applyPolicy = () =>
    service({ mode: "policy-apply", projectId: policyProject.projectId });
  const runner = await changePolicy("runner");
  assert.deepEqual(runner.memberIds, [bob.id]);
  assert.notEqual(runner.revision, runner.appliedRevision);
  assert.equal((await applyPolicy()).revision, runner.revision);
  await as(
    bob,
    `require("node:fs").appendFileSync(${JSON.stringify(policyProject.cwd + "/policy.txt")},"-bob")`,
  );
  const viewer = await changePolicy("viewer");
  assert.ok(viewer.revision > runner.revision);
  assert.deepEqual(viewer.memberIds, []);
  assert.deepEqual(
    await service({
      mode: "policy-receipt",
      projectId: policyProject.projectId,
      revision: runner.revision,
    }),
    { accepted: false },
  );
  await applyPolicy();
  await denied(bob, policyProject.cwd + "/policy.txt");
  await changePolicy("runner");
  await applyPolicy();
  await as(
    bob,
    `require("node:fs").readFileSync(${JSON.stringify(policyProject.cwd + "/policy.txt")})`,
  );
  await changePolicy(null);
  await applyPolicy();
  await denied(bob, policyProject.cwd + "/policy.txt");
  const uidLeases = await verifyProjectUidLeases({
    alice,
    bob,
    charlie,
    project: policyProject,
    service,
    as,
    denied,
  });
  return {
    verification: {
      ...uidLeases.verification,
      projectAclDatabaseRunnerGrantAndViewerDowngrade: true,
      projectAclDatabaseRemovedGrantRevokesAndStaleReceiptDenied: true,
      projectAclRealMigratedRegistryAndNumericUsers: true,
      projectAclExistingAndInheritedFilesShared: true,
      projectAclHomesAndOtherProjectsUnchanged: true,
      projectAclRevisionConflictAndIdentityRebindDenied: true,
      projectAclRevocationAndStaleGrantDenied: true,
      projectAclHardlinkAndSymlinkTargetsUntouched: true,
      projectAclFailureAndSameRevisionRecovery: true,
      projectAclRetainedMemberSurvivesFailedNewGrant: true,
      projectAclSiblingGrantTraversalPreserved: true,
      projectAclFifoRejectedWithoutBlocking: true,
      projectAclAgentCannotInvokeHelper: true,
      projectAclLegacyForeignLaunchStillDenied: true,
      projectAclLargeTreeEntries: 2048,
    },
    async verifyPersistence() {
      const maintenancePersistence =
        await uidLeases.verifyMaintenancePersistence();
      assert.equal((await applyPolicy()).revision, uidLeases.revision);
      await denied(bob, policyProject.cwd + "/policy.txt");
      assert.deepEqual(
        await service({
          mode: "policy-receipt",
          projectId: policyProject.projectId,
          revision: runner.revision,
        }),
        { accepted: false },
      );
      assert.notEqual(
        (
          await raw({
            projectId: policyProject.projectId,
            slug: policyProject.slug,
            revision: runner.revision,
            members: [{ userId: bob.id, uid: bob.uid }],
          })
        ).code,
        0,
      );
      await sync(5, []);
      assert.notEqual(
        (
          await raw({
            revision: 3,
            members: [{ userId: bob.id, uid: bob.uid }],
          })
        ).code,
        0,
      );
      await denied(bob, shared.cwd + "/existing.txt");
      return {
        ...maintenancePersistence,
        projectAclStateSurvivesHelperRestartAndOldRevisionCannotRegrant: true,
        projectAclDatabasePolicyPersistsAndStaleReceiptDenied: true,
      };
    },
  };
}
if (process.argv.includes("--standalone")) {
  const result = await verifyProjectDirectoryAccess();
  console.log(
    JSON.stringify({
      ...result.verification,
      ...(await result.verifyPersistence()),
    }),
  );
}
