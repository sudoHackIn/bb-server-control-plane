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
import { loadControlPlaneConfig } from "../../src/control-plane/config.js";
import {
  hashAdminPassword,
  verifyAdminPassword,
} from "../../src/control-plane/credentials.js";

afterEach(() => vi.unstubAllEnvs());

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
