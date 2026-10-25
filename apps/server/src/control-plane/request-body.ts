import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";

export function controlPlaneBodyLimit(maxSize: number) {
  return bodyLimit({
    maxSize,
    onError(context) {
      context.header("connection", "close");
      return context.json({ error: "payload_too_large" }, 413);
    },
  });
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
