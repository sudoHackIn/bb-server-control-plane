import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function writeControlPlaneSeccomp(path) {
  const profile = JSON.parse(
    await readFile(
      new URL(
        "../deploy/control-plane/security/moby-default-seccomp.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const [name, index, values] of [
    ["unshare", 0, [0x10000000, 0x20020000, 0x30020000]],
    ["mount", 3, [278528, 14]],
  ]) {
    for (const value of values) {
      profile.syscalls.push({
        names: [name],
        action: "SCMP_ACT_ALLOW",
        args: [{ index, value, op: "SCMP_CMP_EQ" }],
      });
    }
  }
  await writeFile(path, JSON.stringify(profile, null, 2) + "\n", {
    mode: 0o600,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.length !== 3)
    throw new Error("Usage: node scripts/control-plane-seccomp.mjs OUTPUT");
  await writeControlPlaneSeccomp(process.argv[2]);
}
