import { expect, it } from "vitest";
import { createApp } from "../../src/server.js";
import { withTestHarness } from "../helpers/test-app.js";

it("preserves the native standalone entry point when shared-server authentication is not configured", async () => {
  await withTestHarness(async (harness) => {
    const server = createApp(harness.deps);
    try {
      const response = await server.app.request(
        "/control-plane/browser-context",
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ mode: "standalone" });
    } finally {
      await server.pluginService.stop();
      await server.closeWebSockets();
    }
  });
});
