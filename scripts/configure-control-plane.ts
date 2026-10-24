import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { hashAdminPassword } from "../apps/server/src/control-plane/credentials.js";
import { controlPlaneConfigSchema } from "../apps/server/src/control-plane/config.js";

async function main() {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string" },
      origin: { type: "string" },
      login: { type: "string" },
      "users-root": { type: "string" },
      "first-uid": { type: "string" },
      "last-uid": { type: "string" },
      "tls-key": { type: "string" },
      "tls-cert": { type: "string" },
      "client-ca": { type: "string" },
    },
    strict: true,
  });
  if (
    !values["data-dir"] ||
    !values.origin ||
    !values.login ||
    process.stdin.isTTY
  ) {
    throw new Error(
      "Use --data-dir, --origin and --login; supply the password on stdin from a private file",
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 4096) throw new Error("Password input is too large");
    chunks.push(value);
  }
  const password = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/u, "");
  const config = controlPlaneConfigSchema.parse({
    version: 1,
    publicOrigin: values.origin,
    admin: {
      login: values.login,
      passwordHash: await hashAdminPassword(password),
    },
    ...([
      values["users-root"],
      values["tls-key"],
      values["tls-cert"],
      values["client-ca"],
      values["first-uid"],
      values["last-uid"],
    ].some(Boolean)
      ? {
          users: {
            usersRoot: values["users-root"],
            firstUid: Number(values["first-uid"] ?? "200000"),
            lastUid: Number(values["last-uid"] ?? "299999"),
            tls: {
              keyFile: values["tls-key"],
              certFile: values["tls-cert"],
              clientCaFile: values["client-ca"],
            },
          },
        }
      : {}),
  });
  const dataDir = resolve(values["data-dir"]);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dataDir, "control-plane.json"),
    JSON.stringify(config, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Administrative access configured. Set BB_CONTROL_PLANE_REQUIRED=1 when starting the shared server.",
  );
}

main().catch((error) => {
  console.error(
    error instanceof Error && error.message.includes("EEXIST")
      ? "Configuration already exists; it was not overwritten"
      : "Could not configure administrative access; check arguments, password length and private file permissions",
  );
  process.exitCode = 1;
});
