import { expect, it } from "vitest";
import {
  controlPlaneBrowserReturnTo,
  getControlPlaneThreadPath,
  isControlPlaneBrowserShellPath,
} from "../src/control-plane-browser-path.js";

it("limits certificate login destinations to canonical personal shells", () => {
  const origin = "https://bb.example";
  expect(controlPlaneBrowserReturnTo(undefined, origin)).toBe(
    "/control-plane/app",
  );
  expect(
    controlPlaneBrowserReturnTo("/projects/p/threads/t#msg=42", origin),
  ).toBe("/projects/p/threads/t#msg=42");
  for (const value of [
    "//evil.example",
    "/\\evil.example/projects/p",
    "https://evil.example",
    "/api/v1/projects",
    "/plugins/test/app.js",
    "/projects/p/../../control-plane/admin",
    "/projects/p/threads/t/extra",
    "/projects/%2Fetc",
    "/",
    "/".repeat(4097),
  ])
    expect(controlPlaneBrowserReturnTo(value, origin), value).toBeNull();
  expect(isControlPlaneBrowserShellPath("/threads/t")).toBe(true);
  expect(getControlPlaneThreadPath("p", "t", 42)).toBe(
    "/projects/p/threads/t#msg=42",
  );
  for (const seq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity])
    expect(() => getControlPlaneThreadPath("p", "t", seq)).toThrow();
  expect(() => getControlPlaneThreadPath("../p", "t")).toThrow();
});
