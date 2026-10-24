import { request } from "node:http";
import { z } from "zod";
const schema = z
  .object({
    threadId: z.string().min(1),
    sessionId: z.string().uuid(),
    id: z.string().uuid(),
    user: z.string(),
    uid: z.number().int().min(200000).max(299999),
    gid: z.number().int().min(200000).max(299999),
    home: z.string().startsWith("/"),
    cwd: z.string().startsWith("/"),
  })
  .strict();
export type ServiceContext = z.infer<typeof schema>;
export async function resolveServiceContext(
  socketPath: string,
  cwd: string,
  sessionId: string,
  threadId: string,
): Promise<ServiceContext> {
  const raw = await new Promise<unknown>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: "/resolve",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          data += chunk;
          if (data.length > 16384)
            req.destroy(new Error("Context response too large"));
        });
        response.on("error", reject);
        response.on("end", () => {
          if (response.statusCode !== 200)
            return reject(new Error("Execution context denied"));
          try {
            const value: unknown = JSON.parse(data);
            resolve(value);
          } catch {
            reject(new Error("Invalid context response"));
          }
        });
      },
    );
    req.setTimeout(10000, () =>
      req.destroy(new Error("Context service timed out")),
    );
    req.on("error", reject);
    req.end(JSON.stringify({ cwd, sessionId, threadId }));
  });
  const context = schema.parse(raw);
  if (
    context.cwd !== cwd ||
    context.uid !== context.gid ||
    context.threadId !== threadId ||
    context.sessionId !== sessionId
  )
    throw new Error("Unexpected execution context");
  return context;
}
