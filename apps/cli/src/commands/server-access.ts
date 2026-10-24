import type { Command } from "commander";
import { z } from "zod";
import { action } from "../action.js";
import { cliFetch } from "../client.js";
import { createServerAccessStore } from "../server-access-session.js";

function endpoint(base: string, path: string): URL {
  const url = new URL(base);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error("Server access requires HTTPS or HTTP loopback");
  return new URL(path, url.origin);
}

export function registerServerAccessCommands(
  server: Command,
  getUrl: () => string,
): void {
  const access = server
    .command("access")
    .description("Sign in to a protected shared BB server");
  access
    .command("login")
    .requiredOption("--login <name>", "Administrator login")
    .requiredOption("--password-stdin", "Read the password from private stdin")
    .action(
      action(async (options: { login: string; passwordStdin: boolean }) => {
        if (!options.passwordStdin || process.stdin.isTTY)
          throw new Error("Supply the password on stdin from a private file");
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += value.length;
          if (size > 4096) throw new Error("Password input is too large");
          chunks.push(value);
        }
        const target = endpoint(getUrl(), "/control-plane/login");
        const response = await cliFetch(target, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            login: options.login,
            password: Buffer.concat(chunks)
              .toString("utf8")
              .replace(/\r?\n$/u, ""),
          }),
        });
        if (!response.ok)
          throw new Error(`Server sign-in failed (${response.status})`);
        const body: unknown = await response.json();
        const result = z
          .object({
            token: z.string(),
            expiresAt: z.number(),
            role: z.literal("admin"),
          })
          .safeParse(body);
        if (!result.success) throw new Error("Invalid server sign-in response");
        createServerAccessStore().save({
          origin: target.origin,
          token: result.data.token,
          expiresAt: result.data.expiresAt,
        });
        console.log(`Signed in as administrator ${options.login}`);
      }),
    );
  access
    .command("status")
    .description("Show the current administrative session")
    .action(
      action(async () => {
        const response = await cliFetch(
          endpoint(getUrl(), "/control-plane/session"),
        );
        if (!response.ok)
          throw new Error(`No active server session (${response.status})`);
        const body: unknown = await response.json();
        const value = z
          .object({ role: z.literal("admin"), login: z.string() })
          .safeParse(body);
        if (!value.success) throw new Error("Invalid server session response");
        console.log(`Administrator: ${value.data.login}`);
      }),
    );
  access
    .command("logout")
    .description("Revoke the current administrative session")
    .action(
      action(async () => {
        const target = endpoint(getUrl(), "/control-plane/logout");
        const response = await cliFetch(target, { method: "POST" });
        if (!response.ok)
          throw new Error(`Server sign-out failed (${response.status})`);
        createServerAccessStore().remove(target.origin);
        console.log("Signed out");
      }),
    );
}
