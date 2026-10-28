import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { controlPlaneQwenNativeTools } from "@bb/domain";

it("keeps publication's native tool catalog aligned with the separately bundled Qwen provider", () => {
  const providerSource = readFileSync(
    new URL(
      "../../../../plugins/provider-qwen-server/src/native-tools.ts",
      import.meta.url,
    ),
    "utf8",
  );
  expect(controlPlaneQwenNativeTools).toEqual(
    [...providerSource.matchAll(/"([^"]+)"/gu)].map((match) => match[1]),
  );
});
