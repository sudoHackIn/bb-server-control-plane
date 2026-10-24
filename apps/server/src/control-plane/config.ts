import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { ServerOptions } from "node:https";
import { z } from "zod";
import { isAdminPasswordHash } from "./credentials.js";

export const controlPlaneConfigSchema = z
  .object({
    version: z.literal(1),
    publicOrigin: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.origin === value &&
          !url.username &&
          !url.password &&
          (url.protocol === "https:" ||
            (url.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
        );
      }, "Use an HTTPS origin, or HTTP loopback for development"),
    admin: z
      .object({
        login: z.string().trim().min(1).max(100),
        passwordHash: z.string().refine(isAdminPasswordHash),
      })
      .strict(),
    runtime: z
      .object({
        daemonEntrypoint: z.string().refine(isAbsolute),
        cliDirectory: z.string().refine(isAbsolute),
      })
      .strict()
      .optional(),
    users: z
      .object({
        usersRoot: z
          .string()
          .refine(
            (value) =>
              isAbsolute(value) && normalize(value) === value && value !== "/",
          ),
        firstUid: z.number().int().min(200000).max(299999),
        lastUid: z.number().int().min(200000).max(299999),
        tls: z
          .object({
            keyFile: z.string().refine(isAbsolute),
            certFile: z.string().refine(isAbsolute),
            clientCaFile: z.string().refine(isAbsolute),
          })
          .strict(),
      })
      .strict()
      .refine((value) => value.firstUid <= value.lastUid)
      .optional(),
  })
  .strict()
  .refine(
    (value) => !value.users || value.publicOrigin.startsWith("https:"),
    "Certificate login requires HTTPS",
  )
  .refine(
    (value) => !value.runtime || value.users !== undefined,
    "Managed execution requires the user registry",
  );

export type ControlPlaneConfig = z.infer<typeof controlPlaneConfigSchema>;

export function controlPlaneTls(
  config: ControlPlaneConfig | null,
): ServerOptions | undefined {
  if (!config?.users) return undefined;
  const { keyFile, certFile, clientCaFile } = config.users.tls;
  for (const path of [keyFile, certFile, clientCaFile]) {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      (process.platform !== "win32" &&
        (stat.uid !== process.getuid?.() ||
          (path === keyFile && (stat.mode & 0o077) !== 0)))
    )
      throw new Error(
        "TLS files must be regular files owned by the server user; the key must be private",
      );
  }
  return {
    key: readFileSync(keyFile),
    cert: readFileSync(certFile),
    ca: readFileSync(clientCaFile),
    requestCert: true,
    rejectUnauthorized: false,
    minVersion: "TLSv1.2",
  };
}

export function loadControlPlaneConfig(
  dataDir: string,
): ControlPlaneConfig | null {
  const required =
    z
      .enum(["0", "1"])
      .default("0")
      .parse(process.env.BB_CONTROL_PLANE_REQUIRED) === "1";
  const path = join(dataDir, "control-plane.json");
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      !required
    )
      return null;
    throw new Error("Could not read control-plane configuration");
  }
  if (
    !stat.isFile() ||
    (process.platform !== "win32" &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
  ) {
    throw new Error(
      "Control-plane configuration must be a private regular file owned by the server user",
    );
  }
  try {
    return controlPlaneConfigSchema.parse(
      JSON.parse(readFileSync(path, "utf8")),
    );
  } catch {
    throw new Error("Invalid control-plane configuration");
  }
}
