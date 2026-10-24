import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { withControlPlaneJobAuthority } from "../../src/control-plane/job-authority.js";
import {
  currentControlPlanePrincipal,
  withControlPlaneUser,
} from "../../src/control-plane/access.js";
import {
  createConnection,
  createControlPlaneJobBinding,
  getControlPlaneJobBinding,
  listControlPlaneJobBindings,
  requireControlPlaneJobDispatch,
  setControlPlaneJobEnabled,
  ControlPlaneJobError,
} from "@bb/db";

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
try {
  if (mode === "create") {
    const subjects = z
      .array(subjectSchema)
      .length(2)
      .parse(JSON.parse(process.argv[3] ?? ""));
    const saved = subjects.map((subject) => {
      const definition = createControlPlaneJobBinding(db, {
        ...subject,
        revision: 1,
        kind: "automation",
        objectId: `fixture-definition-${subject.userId}`,
        sourceBindingId: null,
        originThreadId: null,
      });
      const run = createControlPlaneJobBinding(db, {
        ...subject,
        revision: 1,
        kind: "automation-run",
        objectId: `fixture-run-${subject.userId}`,
        sourceBindingId: definition.id,
      });
      const execution = withControlPlaneJobAuthority(db, run.id, (context) => {
        assert.deepEqual(currentControlPlanePrincipal(), {
          kind: "user",
          userId: subject.userId,
        });
        return context;
      });
      assert.equal(currentControlPlanePrincipal(), null);
      assert.equal(execution.user.id, subject.userId);
      assert.equal(execution.profileVersion.id, subject.profileVersionId);
      assert.equal(execution.project.projectId, subject.projectId);
      setControlPlaneJobEnabled(db, subject.userId, definition.id, false);
      assert.throws(
        () => requireControlPlaneJobDispatch(db, run.id),
        ControlPlaneJobError,
      );
      setControlPlaneJobEnabled(db, subject.userId, definition.id, true);
      return {
        ...subject,
        definitionId: definition.id,
        runId: run.id,
        uid: execution.user.uid,
        home: execution.user.home,
        cwd: execution.project.cwd,
      };
    });
    const alice = saved[0],
      bob = saved[1];
    assert.ok(alice && bob);
    assert.throws(
      () =>
        withControlPlaneUser(bob.userId, () =>
          withControlPlaneJobAuthority(db, alice.runId, () => {
            throw new Error("Foreign callback executed");
          }),
        ),
      /not authorized/u,
    );
    assert.notEqual(alice.uid, bob.uid);
    assert.notEqual(alice.home, bob.home);
    assert.equal(getControlPlaneJobBinding(db, bob.userId, alice.runId), null);
    assert.equal(
      listControlPlaneJobBindings(db, bob.userId, {
        projectId: alice.projectId,
        cursor: null,
        limit: 1,
      }).bindings.length,
      0,
    );
    assert.throws(
      () =>
        createControlPlaneJobBinding(db, {
          ...subjects[0],
          userId: alice.userId,
          projectId: alice.projectId,
          profileVersionId: alice.profileVersionId,
          originThreadId: alice.originThreadId,
          kind: "workflow-run",
          revision: 1,
          objectId: "forged-job-source",
          sourceBindingId: bob.definitionId,
        }),
      ControlPlaneJobError,
    );
    await writeFile(statePath, JSON.stringify(savedSchema.parse(saved)), {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        durableJobBindings: true,
        currentSourceAuthority: true,
        foreignJobBindingsDenied: true,
      }),
    );
  } else {
    const saved = savedSchema.parse(
      JSON.parse(await readFile(statePath, "utf8")),
    );
    await Promise.all(
      saved.map(async (subject) => {
        const execution = await withControlPlaneJobAuthority(
          db,
          subject.runId,
          async (context) => {
            await Promise.resolve();
            assert.deepEqual(currentControlPlanePrincipal(), {
              kind: "user",
              userId: subject.userId,
            });
            return context;
          },
        );
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
      }),
    );
  }
} finally {
  db.$client.close();
}
