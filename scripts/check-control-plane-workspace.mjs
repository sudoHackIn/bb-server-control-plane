import assert from "node:assert/strict";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import Database from "better-sqlite3";

const exec = promisify(execFile);
export function createWorkspaceFixture({ db, users }) {
  const subjects = [];
  const asUser = (user, file, args) =>
    exec(
      "/usr/bin/setpriv",
      [
        "--reuid=" + user.uid,
        "--regid=" + user.gid,
        "--clear-groups",
        "--no-new-privs",
        "--",
        "/usr/bin/env",
        "-i",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "HOME=" + user.home,
        "USER=" + user.id,
        file,
        ...args,
      ],
      { maxBuffer: 1048576, timeout: 15000 },
    );
  const git = (subject, args) =>
    asUser(subject.user, "/usr/bin/git", ["-C", subject.cwd, ...args]);
  const write = (subject, path, text, mode = 0o600) =>
    asUser(subject.user, "/usr/local/bin/node", [
      "-e",
      'require("node:fs").writeFileSync(process.argv[1],process.argv[2],{mode:Number(process.argv[3])})',
      path,
      text,
      String(mode),
    ]);
  function withWrite(run) {
    const writer = new Database("/srv/bb/bb.db");
    try {
      return run(writer);
    } finally {
      writer.close();
    }
  }
  function hook(subject, foreign, hold) {
    return (
      "#!/usr/local/bin/node\n" +
      `const fs=require("node:fs");const cp=require("node:child_process");const home=process.env.HOME;const denied=(path)=>{try{fs.readFileSync(path);return false}catch(error){return error.code==="EACCES"||error.code==="EPERM"}};const result={uid:process.getuid(),gid:process.getgid(),home,cwd:process.cwd(),serviceDenied:denied("/srv/bb/bb.db"),foreignProjectDenied:denied(${JSON.stringify(foreign.cwd + "/tenant-secret.txt")}),foreignHomeDenied:denied(${JSON.stringify(foreign.user.home + "/bb-managed-" + foreign.user.login + ".json")}),modelKey:!!(process.env.OPENAI_API_KEY||process.env.NEURALDEAP_KEY),groups:process.getgroups()};fs.writeFileSync(home+"/workspace-hook.json",JSON.stringify(result));if(result.uid!==${subject.user.uid}||!result.serviceDenied||!result.foreignProjectDenied||!result.foreignHomeDenied||result.modelKey)process.exit(1);fs.rmSync(home+"/workspace-heartbeat",{force:true});const child=cp.spawn(process.execPath,["-e",'setInterval(()=>require("node:fs").writeFileSync(process.env.HOME+"/workspace-heartbeat",String(Date.now())),25)'],{detached:true,stdio:"ignore"});child.unref();const deadline=Date.now()+3000;while(!fs.existsSync(home+"/workspace-heartbeat")&&Date.now()<deadline){}if(!fs.existsSync(home+"/workspace-heartbeat"))process.exit(2);${hold ? 'fs.writeFileSync(home+"/workspace-hold-entered","held");setInterval(()=>{},1000);' : ""}`
    );
  }
  return {
    async prepare() {
      for (const user of users) {
        const project = db
          .prepare(
            "SELECT * FROM control_plane_projects WHERE owner_user_id=? AND slug='app'",
          )
          .get(user.id);
        const environment = db
          .prepare(
            "SELECT id FROM environments WHERE project_id=? AND path=? AND status <> 'destroyed'",
          )
          .get(project.project_id, project.cwd);
        const subject = {
          user,
          cwd: project.cwd,
          projectId: project.project_id,
          environmentId: environment.id,
        };
        subjects.push(subject);
        await git(subject, ["init", "--initial-branch=main"]);
        await git(subject, ["config", "user.name", "Workspace fixture"]);
        await git(subject, [
          "config",
          "user.email",
          "workspace@example.invalid",
        ]);
        await write(subject, subject.cwd + "/tracked.txt", "initial\n");
        await write(subject, subject.cwd + "/tenant-secret.txt", user.login);
        await git(subject, ["add", "."]);
        await git(subject, ["commit", "-m", "Initial owner commit"]);
        withWrite((writer) =>
          writer
            .prepare("UPDATE environments SET status='provisioning' WHERE id=?")
            .run(environment.id),
        );
      }
    },
    async verify({ send, token, wait }) {
      assert.equal(subjects.length, 2);
      for (const [index, subject] of subjects.entries()) {
        const foreign = subjects[1 - index];
        assert.equal(
          db
            .prepare("SELECT is_git_repo FROM environments WHERE id=?")
            .get(subject.environmentId).is_git_repo,
          1,
        );
        await write(
          subject,
          subject.cwd + "/.git/hooks/prepare-commit-msg",
          hook(subject, foreign, false),
          0o700,
        );
        await write(subject, subject.cwd + "/tracked.txt", "changed-own\n");
        const path = `/api/v1/environments/${subject.environmentId}`;
        const status = await send(path + "/status", undefined, token);
        assert.equal(status.status, 200, JSON.stringify(status.body));
        assert.equal(
          status.body.outcome,
          "available",
          JSON.stringify(status.body),
        );
        const diff = await send(
          path + "/diff?target=uncommitted",
          undefined,
          token,
        );
        assert.equal(diff.status, 200, JSON.stringify(diff.body));
        assert.ok(
          JSON.stringify(diff.body).includes("changed-own"),
          JSON.stringify(diff.body),
        );
        const commit = await send(
          path + "/actions",
          { action: "commit" },
          token,
        );
        assert.equal(commit.status, 200, JSON.stringify(commit.body));
        subject.head = (
          await git(subject, ["rev-parse", "HEAD"])
        ).stdout.trim();
        assert.equal(subject.head, commit.body.commitSha);
        const probe = JSON.parse(
          await readFile(subject.user.home + "/workspace-hook.json", "utf8"),
        );
        assert.equal(probe.uid, subject.user.uid);
        assert.equal(probe.gid, subject.user.gid);
        assert.equal(probe.home, subject.user.home);
        assert.equal(probe.cwd, subject.cwd);
        assert.equal(probe.serviceDenied, true);
        assert.equal(probe.foreignProjectDenied, true);
        assert.equal(probe.foreignHomeDenied, true);
        assert.equal(probe.modelKey, false);
        assert.ok(probe.groups.every((group) => group === subject.user.gid));
        const heartbeat = () =>
          stat(subject.user.home + "/workspace-heartbeat").then(
            (value) => value.mtimeMs,
            (error) => {
              if (error.code !== "ENOENT") throw error;
              return null;
            },
          );
        const before = await heartbeat();
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(
          await heartbeat(),
          before,
          "Hook descendant survived acknowledged workspace completion",
        );
      }
      const [alice, bob] = subjects;
      await write(alice, alice.cwd + "/tracked.txt", "must-not-commit\n");
      await write(
        alice,
        alice.cwd + "/.git/hooks/prepare-commit-msg",
        hook(alice, bob, true),
        0o700,
      );
      const pending = send(
        `/api/v1/environments/${alice.environmentId}/actions`,
        { action: "commit" },
        token,
      );
      await wait(
        () =>
          stat(alice.user.home + "/workspace-hold-entered").then(
            () => true,
            () => false,
          ),
        "registered UID commit hook entered",
      );
      try {
        withWrite((writer) =>
          writer
            .prepare(
              "UPDATE control_plane_project_access SET role='viewer' WHERE project_id=? AND user_id=?",
            )
            .run(alice.projectId, alice.user.id),
        );
        const denied = await pending;
        assert.notEqual(denied.status, 200, JSON.stringify(denied.body));
        assert.equal(
          (await git(alice, ["rev-parse", "HEAD"])).stdout.trim(),
          alice.head,
        );
        assert.equal(
          (
            await send(
              `/api/v1/environments/${bob.environmentId}/status`,
              undefined,
              token,
            )
          ).body.outcome,
          "available",
        );
      } finally {
        withWrite((writer) =>
          writer
            .prepare(
              "UPDATE control_plane_project_access SET role='owner' WHERE project_id=? AND user_id=?",
            )
            .run(alice.projectId, alice.user.id),
        );
        await write(
          alice,
          alice.cwd + "/.git/hooks/prepare-commit-msg",
          hook(alice, bob, false),
          0o700,
        );
      }
      const resumed = await send(
        `/api/v1/environments/${alice.environmentId}/actions`,
        { action: "commit" },
        token,
      );
      assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
      alice.head = resumed.body.commitSha;
      assert.equal(
        (await git(alice, ["rev-parse", "HEAD"])).stdout.trim(),
        alice.head,
      );
      return {
        managedWorkspaceNativeGitStatusDiffCommitUnderTwoUids: true,
        managedWorkspaceHookCannotReadServiceOrForeignFiles: true,
        managedWorkspaceNoServiceModelCredentials: true,
        managedWorkspaceDescendantsReaped: true,
        managedWorkspaceActiveProjectRevocationStopsCommit: true,
        managedWorkspaceRegrantAllowsNextCommit: true,
      };
    },
    async afterRestart({ send, token }) {
      for (const subject of subjects) {
        const status = await send(
          `/api/v1/environments/${subject.environmentId}/status`,
          undefined,
          token,
        );
        assert.equal(status.status, 200, JSON.stringify(status.body));
        assert.equal(
          status.body.outcome,
          "available",
          JSON.stringify(status.body),
        );
        assert.equal(
          (await git(subject, ["rev-parse", "HEAD"])).stdout.trim(),
          subject.head,
        );
      }
      return { managedWorkspaceGitIdentitySurvivesRestart: true };
    },
  };
}
