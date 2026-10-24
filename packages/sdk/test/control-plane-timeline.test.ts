import { expect, it } from "vitest";
import { createControlPlaneClient } from "../src/control-plane.js";

it("encodes owned timeline cursors and detail identities without accepting execution overrides", async () => {
  const requests: Request[] = [];
  const api = createControlPlaneClient({
    origin: "https://bb.example",
    token: () => "private-token",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        rows: [],
        olderCursor: null,
        historySnapshot: "snapshot",
      });
    },
  }).threads;
  await api.timelineDetails("thread/owned", {
    turnId: "turn?one",
    sourceSeqStart: 1,
    sourceSeqEnd: 8,
    itemId: "cmd&private",
    beforeCursor: "cursor&next",
  });
  const url = new URL(requests[0]!.url);
  expect(url.pathname).toBe(
    "/control-plane/user/threads/thread%2Fowned/timeline-details",
  );
  expect(url.searchParams.get("itemId")).toBe("cmd&private");
  expect(url.searchParams.get("beforeCursor")).toBe("cursor&next");
  expect(requests[0]!.headers.get("authorization")).toBe(
    "Bearer private-token",
  );
  expect(url.href).not.toContain("private-token");
  await expect(
    api.timelineDetails("owned", {
      turnId: "turn",
      sourceSeqStart: 10,
      sourceSeqEnd: 1,
    }),
  ).rejects.toThrow();
  const override = {
    turnId: "turn",
    sourceSeqStart: 1,
    sourceSeqEnd: 10,
    environmentId: "foreign",
  };
  await expect(api.timelineDetails("owned", override)).rejects.toThrow();
  expect(requests).toHaveLength(1);
});
