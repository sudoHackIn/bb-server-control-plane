import { expect, it } from "vitest";
import {
  controlPlaneAutomationCreateSchema,
  controlPlaneAutomationUpdateSchema,
  controlPlaneAutomationRunInputSchema,
} from "../src/control-plane-automation.js";

it("rejects execution authority overrides, unsafe sizes, invalid revisions and empty edits", () => {
  const valid = {
    originThreadId: "thread",
    name: "Definition",
    prompt: "Execute",
    trigger: { triggerType: "once", runAt: Date.now() + 60000 },
  };
  expect(controlPlaneAutomationCreateSchema.parse(valid).enabled).toBe(true);
  for (const field of [
    "userId",
    "uid",
    "home",
    "cwd",
    "projectId",
    "profileVersionId",
    "providerId",
    "model",
    "tools",
    "mcp",
    "execution",
    "command",
    "environment",
  ])
    expect(
      controlPlaneAutomationCreateSchema.safeParse({
        ...valid,
        [field]: "forged",
      }).success,
    ).toBe(false);
  expect(
    controlPlaneAutomationCreateSchema.safeParse({
      ...valid,
      prompt: "я".repeat(70000),
    }).success,
  ).toBe(false);
  expect(
    controlPlaneAutomationCreateSchema.safeParse({ ...valid, prompt: "" })
      .success,
  ).toBe(false);
  for (const edit of [
    { expectedRevision: 0, name: "changed" },
    { expectedRevision: 1 },
    { expectedRevision: 1, name: "" },
    { expectedRevision: 1, providerId: "forged" },
  ])
    expect(controlPlaneAutomationUpdateSchema.safeParse(edit).success).toBe(
      false,
    );
  expect(
    controlPlaneAutomationUpdateSchema.parse({
      expectedRevision: 1,
      prompt: "changed",
    }).prompt,
  ).toBe("changed");
  expect(
    controlPlaneAutomationRunInputSchema.safeParse({
      idempotencyKey: "x".repeat(201),
    }).success,
  ).toBe(false);
});
