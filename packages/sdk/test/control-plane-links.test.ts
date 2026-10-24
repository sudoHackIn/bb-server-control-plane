import { expect, it } from "vitest";
import { createControlPlaneClient } from "../src/control-plane.js";

it("resolves browser links through the current authorized thread reader without exposing credentials", async () => {
  const requests: Request[] = [];
  const controller = new AbortController();
  const api = createControlPlaneClient({
    origin: "https://bb.example",
    token: () => "private-token",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return request.url.endsWith("/owned")
        ? Response.json({
            id: "owned",
            projectId: "project",
            title: "Private",
            profileVersionId: null,
            status: "idle",
            createdAt: 1,
            updatedAt: 1,
            archived: false,
          })
        : Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  expect(
    await api.threads.browserUrl("owned", {
      messageSeq: 42,
      signal: controller.signal,
    }),
  ).toBe("https://bb.example/projects/project/threads/owned#msg=42");
  expect(requests[0]?.headers.get("authorization")).toBe(
    "Bearer private-token",
  );
  expect(requests[0]?.url).toBe(
    "https://bb.example/control-plane/user/threads/owned",
  );
  await expect(api.threads.browserUrl("foreign")).rejects.toThrow("404");
});
