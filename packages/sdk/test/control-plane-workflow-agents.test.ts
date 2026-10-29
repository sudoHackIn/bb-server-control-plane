import { expect, it, vi } from "vitest";
import { createControlPlaneClient } from "../src/control-plane.js";

it("keeps workflow agents on the existing limited run surface and bounds UTF-8 task input before transport", async () => {
  const run = {
    runId: `wfa_${"a".repeat(64)}`,
    threadId: null,
    workflowRunId: `wfa_${"a".repeat(64)}`,
    strategy: "workflow",
    projectId: "project",
    profileId: "11111111-1111-4111-8111-111111111111",
    profileVersionId: "22222222-2222-4222-8222-222222222222",
    source: "manual",
    title: "Convert",
    status: "succeeded",
    createdAt: 1,
    updatedAt: 2,
  };
  const input = {
    projectId: "project",
    profileVersionId: run.profileVersionId,
    input: "task",
    source: "manual" as const,
    idempotencyKey: "retry",
  };
  const paths: string[] = [];
  const transport = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(input.toString()).pathname;
    paths.push(path);
    if (path.endsWith("/result"))
      return Response.json({ run, text: '{"converted":true}' });
    if (path.endsWith("/cancel")) return Response.json({ ok: true });
    if (path.endsWith("/events"))
      return Response.json(
        { error: "workflow_history_required" },
        { status: 409 },
      );
    return Response.json(run);
  });
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: transport,
  });
  expect(await client.agentRuns.start(input)).toMatchObject({
    strategy: "workflow",
    threadId: null,
    status: "succeeded",
  });
  expect((await client.agentRuns.result(run.runId)).text).toContain(
    "converted",
  );
  expect(await client.agentRuns.cancel(run.runId)).toEqual({ ok: true });
  await expect(client.agentRuns.events(run.runId)).rejects.toThrow("409");
  const calls = transport.mock.calls.length;
  await expect(
    client.agentRuns.start({ ...input, input: "я".repeat(70000) }),
  ).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(calls);
  expect(
    paths.every((path) => path.startsWith("/control-plane/user/agent-runs")),
  ).toBe(true);
});
