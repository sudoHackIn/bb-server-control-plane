import { once } from "node:events";
import { request } from "node:http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { expect, it } from "vitest";
import {
  controlPlaneBodyLimit,
  readControlPlaneJson,
} from "../../src/control-plane/request-body.js";

it("returns complete HTTP 413 responses while draining large uploads, then still accepts normal requests", async () => {
  const app = new Hono();
  let dispatched = 0;
  app.use("/*", controlPlaneBodyLimit(4 * 1024 * 1024));
  app.post("/", async (context) => {
    dispatched++;
    return context.json(await readControlPlaneJson(context));
  });
  const server = serve({
    fetch: app.fetch,
    overrideGlobalObjects: false,
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing TCP address");
    const port = address.port;
    async function send(body: string, chunked: boolean) {
      return new Promise<{ status: number | undefined; text: string }>(
        (resolve, reject) => {
          const req = request(
            `http://127.0.0.1:${port}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(chunked
                  ? { "transfer-encoding": "chunked" }
                  : { "content-length": String(Buffer.byteLength(body)) }),
              },
            },
            (res) => {
              let text = "";
              res.setEncoding("utf8");
              res.on("data", (part: string) => {
                text += part;
              });
              res.on("end", () => resolve({ status: res.statusCode, text }));
              res.on("error", reject);
            },
          );
          req.on("error", reject);
          req.end(body);
        },
      );
    }
    for (let index = 0; index < 8; index++) {
      const rejected = await send(
        "{}" + " ".repeat(4 * 1024 * 1024),
        index % 2 === 0,
      );
      expect(rejected).toEqual({
        status: 413,
        text: '{"error":"payload_too_large"}',
      });
      expect(dispatched).toBe(index);
      expect(await send('{"ok":true}', false)).toEqual({
        status: 200,
        text: '{"ok":true}',
      });
    }
  } finally {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("bounds rejection draining for stalled and endless oversized streams before dispatch", async () => {
  const app = new Hono();
  let dispatched = false;
  app.use("/*", controlPlaneBodyLimit(10));
  app.post("/", (context) => {
    dispatched = true;
    return context.text("unexpected");
  });
  let pulls = 0;
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const endlessInit = { method: "POST", body: endless, duplex: "half" };
  expect((await app.request("/", endlessInit)).status).toBe(413);
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThanOrEqual(12);
  let stalledCancelled = false;
  const stalled = new ReadableStream<Uint8Array>({
    cancel() {
      stalledCancelled = true;
    },
  });
  const stalledInit = {
    method: "POST",
    headers: { "content-length": "100" },
    body: stalled,
    duplex: "half",
  };
  expect((await app.request("/", stalledInit)).status).toBe(413);
  expect(stalledCancelled).toBe(true);
  expect(dispatched).toBe(false);
});
