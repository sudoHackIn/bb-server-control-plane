import { readFile, writeFile, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { startControlPlaneRuntime } from "../../src/control-plane/runtime.js";
import { withTestHarness } from "../helpers/test-app.js";

const observationSchema = z.array(
  z.object({
    pid: z.number(),
    hostId: z.string(),
    keyHash: z.string(),
    socket: z.string(),
    secretInEnvironment: z.boolean(),
    secretInArguments: z.boolean(),
  }),
);

it("bootstraps a supervised child privately, restarts it with the same host identity and closes its context socket", async () => {
  await withTestHarness(async (harness) => {
    const entrypoint = join(
      harness.config.dataDir,
      "managed-daemon-fixture.mjs",
    );
    const observations = join(
      harness.config.dataDir,
      "managed-observations.json",
    );
    await writeFile(
      entrypoint,
      `
      import fs from 'node:fs';
      import { createHash } from 'node:crypto';
      let text = '';
      process.stdin.on('data', (part) => {
        text += part;
        if (!text.includes('\\n')) return;
        const bootstrap = JSON.parse(text.split('\\n')[0]);
        const file = process.env.BB_DATA_DIR + '/managed-observations.json';
        const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
        old.push({pid: process.pid, hostId: bootstrap.hostId,
          keyHash: createHash('sha256').update(bootstrap.enrollKey).digest('hex'),
          socket: process.env.QWEN_SERVER_CONTEXT_SOCKET,
          secretInEnvironment: Object.values(process.env).includes(bootstrap.enrollKey),
          secretInArguments: process.argv.includes(bootstrap.enrollKey)});
        fs.writeFileSync(file, JSON.stringify(old), {mode: 0o600});
      });
      process.stdin.once('end', () => process.exit(0));
      process.once('SIGUSR1', () => process.exit(2));
    `,
      { mode: 0o600 },
    );
    const config = {
      version: 1 as const,
      publicOrigin: "https://bb.example",
      admin: { login: "admin", passwordHash: "unused trusted fixture value" },
      runtime: {
        daemonEntrypoint: entrypoint,
        cliDirectory: dirname(process.execPath),
      },
    };
    const observed = async () =>
      observationSchema.parse(JSON.parse(await readFile(observations, "utf8")));
    const runtime = await startControlPlaneRuntime(
      harness.deps,
      config,
      harness.config.dataDir,
    );
    try {
      await vi.waitFor(async () => expect(await observed()).toHaveLength(1));
      const first = (await observed())[0];
      if (!first) throw new Error("Missing child observation");
      expect(first.hostId).toBe(runtime.hostId);
      expect(first.socket).toBe(runtime.socketPath);
      expect(first.secretInEnvironment).toBe(false);
      expect(first.secretInArguments).toBe(false);
      expect((await lstat(first.socket)).mode & 0o777).toBe(0o600);
      process.kill(first.pid, "SIGUSR1");
      await vi.waitFor(async () => expect(await observed()).toHaveLength(2), {
        timeout: 5000,
      });
      const second = (await observed())[1];
      if (!second) throw new Error("Missing restarted child");
      expect(second.hostId).toBe(first.hostId);
      expect(second.keyHash).not.toBe(first.keyHash);
      expect(second.pid).not.toBe(first.pid);
      expect(second.secretInEnvironment).toBe(false);
      await runtime.close();
      expect(() => process.kill(second.pid, 0)).toThrow();
      await expect(lstat(runtime.socketPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await runtime.close();
    }
    const restarted = await startControlPlaneRuntime(
      harness.deps,
      config,
      harness.config.dataDir,
    );
    try {
      expect(restarted.hostId).toBe(runtime.hostId);
      await vi.waitFor(async () => expect(await observed()).toHaveLength(3));
    } finally {
      await restarted.close();
    }
  });
});
