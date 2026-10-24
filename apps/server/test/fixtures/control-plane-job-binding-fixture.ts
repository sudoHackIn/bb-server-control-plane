import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { createControlPlaneBackgroundJobs } from "../../src/control-plane/background-jobs.js";
import {
  currentControlPlanePrincipal,
  withControlPlaneUser,
} from "../../src/control-plane/access.js";
import { createConnection, requireControlPlaneJobDispatch } from "@bb/db";

const subjectSchema = z
  .object({
    userId: z.string().uuid(),
    projectId: z.string().min(1),
    profileVersionId: z.string().uuid(),
    originThreadId: z.string().min(1),
  })
  .strict();
const savedSchema = z
  .array(
    subjectSchema.extend({
      definitionId: z.string().uuid(),
      runId: z.string().uuid(),
      uid: z.number().int(),
      home: z.string(),
      cwd: z.string(),
    }),
  )
  .length(2);
const mode = z.enum(["create", "resume"]).parse(process.argv[2]);
const statePath = "/srv/bb/job-binding-proof.json";
const db = createConnection("/srv/bb/bb.db");
const jobs = createControlPlaneBackgroundJobs(db, "automations", true);
const workflows = createControlPlaneBackgroundJobs(db, "workflows", true);
try {
  if (mode === "create") {
    const subjects = z
      .array(subjectSchema)
      .length(2)
      .parse(JSON.parse(process.argv[3] ?? ""));
    assert.throws(
      () => createControlPlaneBackgroundJobs(db, "automations", false),
      /not authorized/u,
    );
    const saved = await Promise.all(
      subjects.map((subject) =>
        withControlPlaneUser(subject.userId, async () => {
          const definition = await jobs.bind({
            projectId: subject.projectId,
            profileVersionId: subject.profileVersionId,
            revision: 1,
            kind: "automation",
            objectId: `fixture-definition-${subject.userId}`,
            sourceBindingId: null,
            originThreadId: null,
          });
          const run = await jobs.bind({
            projectId: subject.projectId,
            profileVersionId: null,
            originThreadId: subject.originThreadId,
            revision: 1,
            kind: "automation-run",
            objectId: `fixture-run-${subject.userId}`,
            sourceBindingId: definition.id,
          });
          const execution = jobs.withAuthority(run.id, () => {
            assert.deepEqual(currentControlPlanePrincipal(), {
              kind: "user",
              userId: subject.userId,
            });
            return requireControlPlaneJobDispatch(db, run.id);
          });
          assert.equal(execution.user.id, subject.userId);
          assert.equal(execution.profileVersion.id, subject.profileVersionId);
          assert.equal(execution.project.projectId, subject.projectId);
          await jobs.setEnabled(definition.id, false);
          assert.throws(
            () => jobs.withAuthority(run.id, () => null),
            /not authorized/u,
          );
          await jobs.setEnabled(definition.id, true);
          return {
            ...subject,
            definitionId: definition.id,
            runId: run.id,
            uid: execution.user.uid,
            home: execution.user.home,
            cwd: execution.project.cwd,
          };
        }),
      ),
    );
    assert.equal(currentControlPlanePrincipal(), null);
    const alice = saved[0],
      bob = saved[1];
    assert.ok(alice && bob);
    assert.throws(
      () =>
        withControlPlaneUser(bob.userId, () =>
          jobs.withAuthority(alice.runId, () => {
            throw new Error("Foreign callback executed");
          }),
        ),
      /not authorized/u,
    );
    assert.notEqual(alice.uid, bob.uid);
    assert.notEqual(alice.home, bob.home);
    assert.equal(
      await withControlPlaneUser(bob.userId, () => jobs.get(alice.runId)),
      null,
    );
    assert.equal(
      (
        await withControlPlaneUser(bob.userId, () =>
          jobs.list({
            kind: "automation-run",
            projectId: alice.projectId,
            cursor: null,
            limit: 1,
          }),
        )
      ).bindings.length,
      0,
    );
    await assert.rejects(
      withControlPlaneUser(alice.userId, () =>
        workflows.bind({
          projectId: alice.projectId,
          profileVersionId: alice.profileVersionId,
          originThreadId: alice.originThreadId,
          kind: "workflow-run",
          revision: 1,
          objectId: "forged-job-source",
          sourceBindingId: bob.definitionId,
        }),
      ),
      /not authorized/u,
    );
    await assert.rejects(
      jobs.bind({
        kind: "automation-run",
        objectId: "unscoped-background-registration",
        revision: 1,
        projectId: alice.projectId,
        profileVersionId: alice.profileVersionId,
        originThreadId: alice.originThreadId,
        sourceBindingId: null,
      }),
      /not authorized/u,
    );
    await writeFile(statePath, JSON.stringify(savedSchema.parse(saved)), {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        durableJobBindings: true,
        currentSourceAuthority: true,
        foreignJobBindingsDenied: true,
        backgroundJobSpiCreateReadAndRegistrationScope: true,
      }),
    );
  } else {
    const saved = savedSchema.parse(
      JSON.parse(await readFile(statePath, "utf8")),
    );
    await Promise.all(
      saved.map(async (subject) => {
        const execution = await jobs.withAuthority(subject.runId, async () => {
          await Promise.resolve();
          assert.deepEqual(currentControlPlanePrincipal(), {
            kind: "user",
            userId: subject.userId,
          });
          return requireControlPlaneJobDispatch(db, subject.runId);
        });
        assert.equal(currentControlPlanePrincipal(), null);
        assert.equal(execution.binding.sourceBindingId, subject.definitionId);
        assert.equal(execution.user.id, subject.userId);
        assert.equal(execution.user.uid, subject.uid);
        assert.equal(execution.user.home, subject.home);
        assert.equal(execution.project.cwd, subject.cwd);
        assert.equal(execution.profileVersion.id, subject.profileVersionId);
        assert.equal(
          execution.profileVersion.definition.model,
          "qwen-job-test",
        );
      }),
    );
    assert.equal(currentControlPlanePrincipal(), null);
    console.log(
      JSON.stringify({
        durableJobBindingsSurviveRestartWithoutBrowserTokens: true,
        backgroundJobPrincipalRemainsUserAfterAsyncRestart: true,
        backgroundJobSpiSurvivesRestartWithoutBrowserTokens: true,
      }),
    );
  }
} finally {
  db.$client.close();
}
