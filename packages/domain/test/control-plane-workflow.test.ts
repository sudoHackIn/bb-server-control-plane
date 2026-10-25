import { expect, it } from "vitest";
import { controlPlaneWorkflowStartSchema } from "../src/control-plane-workflow.js";

const input = {
  originThreadId: "origin",
  script: 'export const meta={name:"test",description:"test"}; return args;',
};
it("rejects capability overrides and unsafe or unbounded workflow args before transport", () => {
  expect(controlPlaneWorkflowStartSchema.parse(input)).toMatchObject({
    args: null,
    resumeRunId: null,
  });
  for (const field of [
    "userId",
    "projectId",
    "profileVersionId",
    "home",
    "uid",
    "command",
    "environmentId",
  ])
    expect(
      controlPlaneWorkflowStartSchema.safeParse({ ...input, [field]: "forged" })
        .success,
    ).toBe(false);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let nested: unknown = null;
  for (let index = 0; index < 40; index++) nested = [nested];
  const getter = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      throw new Error("must not invoke getters");
    },
  });
  for (const args of [
    cycle,
    nested,
    new Date(),
    getter,
    { value: Infinity },
    new Array(2),
    { [Symbol("hidden")]: 1 },
    JSON.parse('{"__proto__":1}'),
    "a".repeat(131073),
  ])
    expect(
      controlPlaneWorkflowStartSchema.safeParse({ ...input, args }).success,
    ).toBe(false);
  expect(
    controlPlaneWorkflowStartSchema.safeParse({
      ...input,
      args: { text: "Привет", items: [1, true, null] },
    }).success,
  ).toBe(true);
});
