import type { Context, MiddlewareHandler } from "hono";

async function drainRejectedBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), 500);
    timer.unref?.();
  });
  let drained = 0;
  try {
    while (drained <= 8 * 1024 * 1024) {
      const item = await Promise.race([reader.read(), expired]);
      if (item === null) break;
      if (item.done) return;
      drained += item.value.byteLength;
    }
    void reader.cancel().catch(() => {});
  } catch {
    void reader.cancel().catch(() => {});
  } finally {
    clearTimeout(timer);
  }
}

export function controlPlaneBodyLimit(maxSize: number): MiddlewareHandler {
  return async (context, next) => {
    const body = context.req.raw.body;
    if (!body) return next();
    const reader = body.getReader();
    async function reject() {
      await drainRejectedBody(reader);
      context.header("connection", "close");
      return context.json({ error: "payload_too_large" }, 413);
    }
    if (Number(context.req.header("content-length")) > maxSize) return reject();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxSize) return reject();
      chunks.push(item.value);
    }
    reader.releaseLock();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    context.req.raw = new Request(context.req.url, {
      method: context.req.method,
      headers: context.req.raw.headers,
      signal: context.req.raw.signal,
      body: bytes,
    });
    return next();
  };
}

export async function readControlPlaneJson(context: Context): Promise<unknown> {
  const text = await context.req.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function readControlPlaneForm(context: Context) {
  const text = await context.req.text();
  try {
    const form = await new Response(text, {
      headers: { "content-type": context.req.header("content-type") ?? "" },
    }).formData();
    const entries = [...form.entries()];
    if (new Set(entries.map(([key]) => key)).size !== entries.length)
      return null;
    return Object.fromEntries(entries);
  } catch {
    return null;
  }
}

export async function hasControlPlaneEmptyBody(
  context: Context,
): Promise<boolean> {
  const text = await context.req.text();
  if (text.length === 0) return true;
  try {
    const body: unknown = JSON.parse(text);
    return (
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      Object.keys(body).length === 0
    );
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}
