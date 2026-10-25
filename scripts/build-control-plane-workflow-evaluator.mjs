import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { buildNodeEsmEntry } from "./build-utils.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
await buildNodeEsmEntry({
  cleanDist: false,
  entryPoint: resolve(root, "plugins/workflows/src/evaluator-entry.ts"),
  outfile: resolve(
    root,
    "apps/server/.control-plane-runtime/workflow-evaluator.mjs",
  ),
  packageRoot: root,
  sourcemap: false,
});
