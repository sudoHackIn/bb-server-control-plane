import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createMigratedConnection } from "@bb/db/testing";
import { createControlPlaneBackgroundJobs } from "../../src/control-plane/background-jobs.js";
import { runControlPlaneAutomationScript } from "../../src/control-plane/automation-script-runner.js";
import { withControlPlaneUser } from "../../src/control-plane/access.js";
import { seedControlPlaneJobSubjects } from "../helpers/control-plane-authority.js";

it("rejects foreign, disabled, wrong-purpose and cancelled script launches before spawning", async () => {
  const db = createMigratedConnection();
  try {
    const { alice, bob } = seedControlPlaneJobSubjects(db);
    const jobs = createControlPlaneBackgroundJobs(db, "automations", true);
    await withControlPlaneUser(alice.user.id, async () => {
      const source = await jobs.bind({ ...alice.input, kind: "automation" });
      const run = await jobs.bind({
        ...alice.input,
        objectId: randomUUID(),
        kind: "automation-run",
        sourceBindingId: source.id,
      });
      const input = {
        jobId: randomUUID(),
        source: 'console.log("ok")',
        timeoutMs: 1000,
      };
      const active = new AbortController();
      await expect(
        withControlPlaneUser(bob.user.id, () =>
          runControlPlaneAutomationScript(db, run.id, input, active.signal),
        ),
      ).rejects.toThrow("not authorized");
      await expect(
        runControlPlaneAutomationScript(db, source.id, input, active.signal),
      ).rejects.toThrow("not authorized");
      const workflowJobs = createControlPlaneBackgroundJobs(
        db,
        "workflows",
        true,
      );
      expect(() =>
        workflowJobs.runAutomationScript(
          run.id,
          { source: input.source, timeoutMs: input.timeoutMs },
          active.signal,
        ),
      ).toThrow("not authorized");
      expect(() => workflowJobs.stopAutomationScript(run.id)).toThrow(
        "not authorized",
      );
      await expect(
        withControlPlaneUser(bob.user.id, () =>
          jobs.stopAutomationScript(run.id),
        ),
      ).rejects.toThrow("not authorized");
      expect(() =>
        jobs.runAutomationScript(
          run.id,
          {
            source: input.source,
            timeoutMs: input.timeoutMs,
            ...{ jobId: input.jobId },
          },
          active.signal,
        ),
      ).toThrow();
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(
        runControlPlaneAutomationScript(db, run.id, input, cancelled.signal),
      ).rejects.toThrow("before launch");
      for (const invalid of [
        { ...input, source: "я".repeat(131073) },
        { ...input, timeoutMs: 900001 },
        { ...input, jobId: "not-a-job" },
        { ...input, cwd: "/" },
      ])
        await expect(
          runControlPlaneAutomationScript(db, run.id, invalid, active.signal),
        ).rejects.toThrow();
      await jobs.setEnabled(source.id, false);
      await expect(
        runControlPlaneAutomationScript(db, run.id, input, active.signal),
      ).rejects.toThrow("not authorized");
    });
  } finally {
    db.$client.close();
  }
});
