import type { Command } from "commander";
import { z } from "zod";
import { action } from "../action.js";
import { cliFetch } from "../client.js";
import { createServerAccessStore } from "../server-access-session.js";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { createControlPlaneClient } from "@bb/sdk/node";

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
    .command("environment")
    .description(
      "Inspect your server environment, or provision its directories",
    )
    .option(
      "--provision",
      "Create or verify your registered HOME and project directories",
    )
    .action(
      action(async (options: { provision?: boolean }) => {
        const target = endpoint(getUrl(), "/control-plane/user/environment");
        const client = createControlPlaneClient({
          origin: target.origin,
          fetch: cliFetch,
        });
        const result = options.provision
          ? await client.provisionEnvironment()
          : await client.environment();
        console.log(JSON.stringify(result, null, 2));
      }),
    );
  access
    .command("authorize")
    .description("Authorize as a user through a browser client certificate")
    .option(
      "--client-name <name>",
      "Name displayed by the browser approval page",
      "BB CLI",
    )
    .action(
      action(async (options: { clientName: string }) => {
        const target = endpoint(getUrl(), "/control-plane/auth/start");
        const client = createControlPlaneClient({
          origin: target.origin,
          fetch: cliFetch,
        });
        const verifier = randomBytes(32).toString("base64url");
        const signal = AbortSignal.timeout(10 * 60 * 1000);
        const flow = await client.start(
          options.clientName,
          createHash("sha256").update(verifier).digest("base64url"),
          signal,
        );
        console.log(
          `Open this URL in your browser and sign in with your user certificate:\n${flow.authorizationUrl}`,
        );
        while (Date.now() < flow.expiresAt) {
          const result = await client.exchange(flow.flowId, verifier, signal);
          if (result.status === "authorized") {
            createServerAccessStore().save({
              origin: target.origin,
              token: result.accessToken,
              expiresAt: result.expiresAt,
            });
            console.log("Signed in as user");
            return;
          }
          await setTimeout(flow.pollIntervalMs, undefined, { signal });
        }
        throw new Error("User authorization expired");
      }),
    );
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
        const target = endpoint(getUrl(), "/control-plane/session");
        if (
          createServerAccessStore()
            .read(target.origin)
            ?.token.startsWith("agt_")
        ) {
          const result = await createControlPlaneClient({
            origin: target.origin,
            fetch: cliFetch,
          }).session();
          console.log(`User: ${result.user.login}`);
          return;
        }
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
        if (
          createServerAccessStore()
            .read(target.origin)
            ?.token.startsWith("agt_")
        ) {
          await createControlPlaneClient({
            origin: target.origin,
            fetch: cliFetch,
          }).logout();
          createServerAccessStore().remove(target.origin);
          console.log("Signed out");
          return;
        }
        const response = await cliFetch(target, { method: "POST" });
        if (!response.ok)
          throw new Error(`Server sign-out failed (${response.status})`);
        createServerAccessStore().remove(target.origin);
        console.log("Signed out");
      }),
    );
}
