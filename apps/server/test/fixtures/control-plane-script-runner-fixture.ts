import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createConnection } from "@bb/db";
import { z } from "zod";
import { createControlPlaneBackgroundJobs } from "../../src/control-plane/background-jobs.js";
import { runControlPlaneAutomationScript } from "../../src/control-plane/automation-script-runner.js";
import { withControlPlaneUser } from "../../src/control-plane/access.js";

const subjects = z
  .array(
    z
      .object({
        userId: z.string().uuid(),
        projectId: z.string(),
        originThreadId: z.string(),
      })
      .strict(),
  )
  .length(2)
  .parse(JSON.parse(process.argv[2] ?? ""));
const db = createConnection("/srv/bb/bb.db");
const jobs = createControlPlaneBackgroundJobs(db, "automations", true);
const markers: string[] = [];
try {
  for (const subject of subjects) {
    await withControlPlaneUser(subject.userId, async () => {
      const source = await jobs.bind({
        kind: "automation",
        objectId: randomUUID(),
        revision: 1,
        projectId: subject.projectId,
        originThreadId: subject.originThreadId,
        profileVersionId: null,
        sourceBindingId: null,
      });
      try {
        for (const mode of [
          "succeeded",
          "failed",
          "output_limit",
          "invalid_output",
          "incomplete_output",
          "cancelled",
          "timed_out",
          "authority_revoked",
        ] as const) {
          const run = await jobs.bind({
            kind: "automation-run",
            objectId: randomUUID(),
            revision: 1,
            projectId: subject.projectId,
            originThreadId: subject.originThreadId,
            profileVersionId: null,
            sourceBindingId: source.id,
          });
          const controller = new AbortController();
          const marker = `bounded-script-${randomUUID()}`;
          markers.push(marker);
          const hang = `import {spawn} from 'node:child_process';spawn(process.execPath,['-e','setInterval(()=>{},1000)',${JSON.stringify(marker)}],{detached:true,stdio:'ignore'});console.log('ready');setInterval(()=>{},1000);`;
          const body =
            mode === "succeeded"
              ? 'console.log(JSON.stringify({uid:process.getuid(),home:process.env.HOME,cwd:process.cwd(),job:process.env.BB_AGENT_JOB_ID,credential:!!process.env.BB_SERVER_TOKEN}));console.error("stderr-proof");'
              : mode === "failed"
                ? 'console.log("failure-proof");process.exitCode=17;'
                : mode === "output_limit"
                  ? 'process.stdout.write("x".repeat(700000));process.stderr.write("y".repeat(700000));setInterval(()=>{},1000);'
                  : mode === "incomplete_output"
                    ? "process.stdout.write(Buffer.from([226,130]));"
                    : mode === "invalid_output"
                      ? "process.stdout.write(Buffer.from([255]));setInterval(()=>{},1000);"
                      : hang;
          let revokeTask: Promise<void> | null = null;
          const timer = setTimeout(() => {
            if (mode === "cancelled") controller.abort();
            if (mode === "authority_revoked")
              revokeTask = jobs.setEnabled(source.id, false).then(() => {});
          }, 1500);
          try {
            const jobId = randomUUID();
            const result = await runControlPlaneAutomationScript(
              db,
              run.id,
              {
                jobId,
                source: body,
                timeoutMs: mode === "timed_out" ? 2000 : 15000,
              },
              controller.signal,
            );
            assert.equal(
              result.status,
              mode === "incomplete_output" ? "invalid_output" : mode,
              JSON.stringify(result),
            );
            assert.ok(result.outputBytes <= 1048576);
            assert.ok(
              Buffer.byteLength(result.stdout) +
                Buffer.byteLength(result.stderr) <=
                1048576,
            );
            if (mode === "succeeded") {
              const proof = z
                .object({
                  uid: z.number(),
                  home: z.string(),
                  cwd: z.string(),
                  job: z.string(),
                  credential: z.boolean(),
                })
                .parse(JSON.parse(result.stdout));
              assert.ok(proof.uid >= 200000);
              assert.ok(proof.home.includes(subject.userId));
              assert.ok(proof.cwd.includes(subject.userId));
              assert.equal(proof.job, jobId);
              assert.equal(proof.credential, false);
              assert.match(result.stderr, /stderr-proof/u);
            }
            if (mode === "failed") assert.equal(result.exitCode, 17);
            if (mode === "output_limit") {
              assert.equal(result.outputBytes, 1048576);
              assert.equal(result.truncated, true);
              assert.ok(result.stdout.length > 0);
              assert.ok(result.stderr.length > 0);
            }
            if (["cancelled", "timed_out", "authority_revoked"].includes(mode))
              assert.match(result.stdout, /ready/u);
          } finally {
            clearTimeout(timer);
            if (revokeTask) await revokeTask;
            await jobs.setEnabled(source.id, true);
            await jobs.remove(run.id);
          }
        }
      } finally {
        await jobs.remove(source.id);
      }
    });
  }
  process.stdout.write(
    JSON.stringify({
      markers,
      boundedScriptRunnerTwoOwners: true,
      boundedScriptRunnerExitAndSeparateStreams: true,
      boundedScriptRunnerOutputAndUtf8Limits: true,
      boundedScriptRunnerCancelDeadlineAndRevocation: true,
    }) + "\n",
  );
} finally {
  db.$client.close();
}
