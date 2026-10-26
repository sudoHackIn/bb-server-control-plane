import { expect, it } from "vitest";
import { createControlPlaneClient } from "../src/control-plane.js";

it("cancels project connection and personal credential reads through the underlying fetch signal", async () => {
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Missing cancellation signal");
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Cancelled", "AbortError")),
          { once: true },
        );
      });
    },
  });
  for (const read of [
    (signal: AbortSignal) => client.mcp.connections("project", signal),
    (signal: AbortSignal) =>
      client.mcp.credential("11111111-1111-4111-8111-111111111111", signal),
  ]) {
    const controller = new AbortController();
    const pending = read(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("Cancelled");
  }
});
