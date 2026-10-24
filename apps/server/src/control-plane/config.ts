import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  })
  .strict();

export type ControlPlaneConfig = z.infer<typeof controlPlaneConfigSchema>;

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
