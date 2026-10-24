import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import {
  controlPlaneConfigSchema,
  controlPlaneTls,
  loadControlPlaneConfig,
} from "../../src/control-plane/config.js";
import {
  hashAdminPassword,
  verifyAdminPassword,
} from "../../src/control-plane/credentials.js";

afterEach(() => vi.unstubAllEnvs());

it("requires HTTPS and private server-owned TLS files when certificate users are enabled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bb-user-tls-config-"));
  try {
    const keyFile = join(directory, "server.key");
    const certFile = join(directory, "server.crt");
    const clientCaFile = join(directory, "client-ca.crt");
    for (const file of [keyFile, certFile, clientCaFile])
      writeFileSync(file, "test-fixture", { mode: 0o600 });
    const config = controlPlaneConfigSchema.parse({
      version: 1,
      publicOrigin: "https://bb.example",
      admin: {
        login: "operator",
        passwordHash: await hashAdminPassword("long-test-only-password"),
      },
      users: {
        usersRoot: "/srv/users",
        firstUid: 200000,
        lastUid: 299999,
        tls: { keyFile, certFile, clientCaFile },
      },
    });
    expect(controlPlaneTls(config)).toMatchObject({
      requestCert: true,
      rejectUnauthorized: false,
    });
    const runtime = {
      daemonEntrypoint: "/opt/bb/apps/host-daemon/dist/control-plane.js",
      cliDirectory: "/opt/bb/apps/cli/dist",
    };
    expect(
      controlPlaneConfigSchema.safeParse({ ...config, runtime }).success,
    ).toBe(true);
    expect(
      controlPlaneConfigSchema.safeParse({
        ...config,
        runtime,
        users: undefined,
      }).success,
    ).toBe(false);
    expect(
      controlPlaneConfigSchema.safeParse({
        ...config,
        runtime: { ...runtime, daemonEntrypoint: "../daemon.js" },
      }).success,
    ).toBe(false);
    expect(
      controlPlaneConfigSchema.safeParse({
        ...config,
        runtime: { daemonEntrypoint: runtime.daemonEntrypoint },
      }).success,
    ).toBe(false);
    expect(
      controlPlaneConfigSchema.safeParse({
        ...config,
        publicOrigin: "http://127.0.0.1",
      }).success,
    ).toBe(false);
    expect(
      controlPlaneConfigSchema.safeParse({
        ...config,
        users: { ...config.users, usersRoot: "/srv/users/../outside" },
      }).success,
    ).toBe(false);
    if (process.platform !== "win32") {
      chmodSync(keyFile, 0o644);
      expect(() => controlPlaneTls(config)).toThrow("key must be private");
      chmodSync(keyFile, 0o600);
    }
    rmSync(keyFile);
    symlinkSync(certFile, keyFile);
    expect(() => controlPlaneTls(config)).toThrow("regular files");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("requires valid private configuration in shared-server deployments and never falls back after configuration errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bb-access-config-"));
  try {
    vi.stubEnv("BB_CONTROL_PLANE_REQUIRED", "0");
    expect(loadControlPlaneConfig(dir)).toBeNull();
    vi.stubEnv("BB_CONTROL_PLANE_REQUIRED", "1");
    expect(() => loadControlPlaneConfig(dir)).toThrow("Could not read");
    const path = join(dir, "control-plane.json");
    const hash = await hashAdminPassword("test-only-long-password");
    const data = {
      version: 1,
      publicOrigin: "https://bb.example",
      admin: { login: "operator", passwordHash: hash },
    };
    writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
    expect(loadControlPlaneConfig(dir)).toEqual(data);
    expect(await verifyAdminPassword("wrong", hash)).toBe(false);
    expect(await verifyAdminPassword("test-only-long-password", hash)).toBe(
      true,
    );
    if (process.platform !== "win32") {
      chmodSync(path, 0o644);
      expect(() => loadControlPlaneConfig(dir)).toThrow("private regular file");
      chmodSync(path, 0o600);
    }
    writeFileSync(
      path,
      JSON.stringify({ ...data, publicOrigin: "http://public.example" }),
    );
    expect(() => loadControlPlaneConfig(dir)).toThrow("Invalid control-plane");
    writeFileSync(path, "secret-invalid-config");
    expect(() => loadControlPlaneConfig(dir)).toThrow("Invalid control-plane");
    vi.stubEnv("BB_CONTROL_PLANE_REQUIRED", "0");
    expect(() => loadControlPlaneConfig(dir)).toThrow("Invalid control-plane");
    rmSync(path);
    const target = join(dir, "target");
    writeFileSync(target, JSON.stringify(data), { mode: 0o600 });
    symlinkSync(target, path);
    expect(() => loadControlPlaneConfig(dir)).toThrow("private regular file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
