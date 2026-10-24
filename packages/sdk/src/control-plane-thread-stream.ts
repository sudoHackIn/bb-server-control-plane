import { controlPlaneThreadStreamMessageSchema } from "@bb/server-contract";

export async function* readControlPlaneThreadStream(
  response: Response,
  threadId: string,
  signal?: AbortSignal,
) {
  if (
    response.headers.get("content-type")?.split(";")[0] !==
      "text/event-stream" ||
    !response.body
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Invalid thread stream response");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  try {
    while (!signal?.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = /\r?\n\r?\n/u.exec(buffer);
      while (boundary && boundary.index !== undefined) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (frame.length > 16 * 1024 * 1024)
          throw new Error("Thread stream frame is too large");
        const data = frame
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /u, ""))
          .join("\n");
        if (data) {
          const raw: unknown = JSON.parse(data);
          const message = controlPlaneThreadStreamMessageSchema.parse(raw);
          if (message.kind === "event" && message.event.threadId !== threadId)
            throw new Error("Invalid thread stream ownership");
          if (
            message.kind === "realtime" &&
            (message.message.type === "changed"
              ? message.message.id
              : message.message.target.threadId) !== threadId
          )
            throw new Error("Invalid thread stream ownership");
          yield message;
        }
        boundary = /\r?\n\r?\n/u.exec(buffer);
      }
      if (buffer.length > 16 * 1024 * 1024)
        throw new Error("Thread stream frame is too large");
    }
    if (!signal?.aborted)
      throw new Error(
        "Thread stream closed; reconnect from the last event sequence",
      );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
