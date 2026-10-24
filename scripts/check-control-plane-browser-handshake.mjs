import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export async function verifyExternalBrowser({ origin, users, signal }) {
  if (process.env.BB_CONTROL_PLANE_BROWSER_TEST !== "1") return {};
  console.log(`BB_BROWSER_READY ${JSON.stringify({ origin, users })}`);
  while (!signal.aborted) {
    try {
      const result = JSON.parse(
        await readFile("/tmp/bb-browser-result.json", "utf8"),
      );
      assert.equal(result.ok, true, "Production browser verification failed");
      assert.equal(
        result.verification?.productionBrowserRenderingVerified,
        true,
      );
      return { productionBrowser: result.verification };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Production browser verification timed out");
}
