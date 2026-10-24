import { z } from "zod";

const flowSchema = z.object({
  flowId: z.string().uuid(),
  authorizationUrl: z.string().url(),
  expiresAt: z.number(),
  pollIntervalMs: z.number().int().min(1000),
});
const exchangeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("authorized"),
    accessToken: z.string().regex(/^agt_[A-Za-z0-9_-]{43}$/u),
    tokenType: z.literal("Bearer"),
    expiresAt: z.number(),
  }),
]);
const userSchema = z.object({
  role: z.literal("user"),
  user: z.object({
    id: z.string().uuid(),
    login: z.string(),
    environmentStatus: z.enum(["allocated", "provisioning", "ready", "failed"]),
  }),
  expiresAt: z.number(),
});

export function createControlPlaneClient(args: {
  origin: string;
  fetch?: typeof fetch;
  token?: () => string | null;
}) {
  const url = new URL(args.origin);
  if (
    url.origin !== args.origin ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error(
      "Control-plane clients require an HTTPS origin or HTTP loopback",
    );
  const fetcher = args.fetch ?? fetch;
  const request = async (
    path: string,
    method: string,
    body?: object,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const headers = new Headers();
    if (body) headers.set("content-type", "application/json");
    const token = args.token?.();
    if (token) headers.set("authorization", `Bearer ${token}`);
    const response = await fetcher(new URL(path, url), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
      signal,
    });
    if (!response.ok)
      throw new Error(`Control-plane request failed (${response.status})`);
    return response.json();
  };
  return {
    async start(clientName: string, challenge: string, signal?: AbortSignal) {
      const result = flowSchema.parse(
        await request(
          "/control-plane/auth/start",
          "POST",
          { clientName, challenge },
          signal,
        ),
      );
      if (new URL(result.authorizationUrl).origin !== url.origin)
        throw new Error("Invalid authorization origin");
      return result;
    },
    async exchange(flowId: string, verifier: string, signal?: AbortSignal) {
      return exchangeSchema.parse(
        await request(
          "/control-plane/auth/exchange",
          "POST",
          { flowId, verifier },
          signal,
        ),
      );
    },
    async session(signal?: AbortSignal) {
      return userSchema.parse(
        await request("/control-plane/user", "GET", undefined, signal),
      );
    },
    async logout(signal?: AbortSignal) {
      z.object({ ok: z.literal(true) }).parse(
        await request("/control-plane/user/logout", "POST", undefined, signal),
      );
    },
  };
}
