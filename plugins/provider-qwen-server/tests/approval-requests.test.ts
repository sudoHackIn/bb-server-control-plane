import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  approvalPayload,
  createApprovalRequests,
} from "../src/approval-requests.js";
import type { NativeApproval } from "../src/approval-transport.js";

it("classifies command, local edit, symlink escape and generic tool approvals", async () => {
  const root = await mkdtemp(join(tmpdir(), "qwen-approval-"));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const source: NativeApproval = {
    toolName: "write_file",
    toolUseId: "actual-tool-id",
    input: { file_path: "new/child.txt", content: "content" },
    blockedPath: null,
    signal: new AbortController().signal,
  };
  try {
    expect((await approvalPayload(source, cwd))?.subject).toMatchObject({
      kind: "file_change",
      itemId: "actual-tool-id",
    });
    expect(
      (await approvalPayload({ ...source, blockedPath: "../blocked" }, cwd))
        ?.subject.kind,
    ).toBe("tool_use");
    await symlink(root, join(cwd, "escape"));
    expect(
      (
        await approvalPayload(
          { ...source, input: { file_path: "escape/outside" } },
          cwd,
        )
      )?.subject.kind,
    ).toBe("tool_use");
    expect(
      (
        await approvalPayload(
          { ...source, input: { file_path: "../outside" } },
          cwd,
        )
      )?.subject.kind,
    ).toBe("tool_use");
    expect(
      (
        await approvalPayload(
          {
            ...source,
            toolName: "run_shell_command",
            input: { command: "git push" },
          },
          cwd,
        )
      )?.subject,
    ).toMatchObject({
      kind: "command",
      command: "git push",
      itemId: "actual-tool-id",
    });
    expect(
      (await approvalPayload({ ...source, toolName: "mcp__bb__tool" }, cwd))
        ?.subject.kind,
    ).toBe("tool_use");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("accepts only a one-time approval and fences scope cancellation and late responses", async () => {
  const sent: Parameters<Parameters<typeof createApprovalRequests>[0]>[0][] =
    [];
  const requests = createApprovalRequests((request) => sent.push(request));
  const controller = new AbortController();
  const scope = {};
  const payload = await approvalPayload(
    {
      toolName: "run_shell_command",
      toolUseId: "native-id",
      input: { command: "git push" },
      blockedPath: null,
      signal: controller.signal,
    },
    "/workspace",
  );
  if (!payload) throw new Error("Missing fixture payload");
  const ask = () =>
    requests.request(scope, {
      threadId: "thread",
      providerThreadId: "session",
      turnId: "turn",
      signal: controller.signal,
      payload,
    });
  const one = ask();
  const first = sent[0]!;
  expect(first.params).toMatchObject({
    threadId: "thread",
    providerThreadId: "session",
    turnId: "turn",
    providerNativeIds: true,
    payload: { subject: { itemId: "native-id" } },
  });
  requests.handle({
    id: first.id,
    result: { decision: "allow_once", grantedPermissions: null },
  });
  expect(await one).toBe(true);
  const persistent = ask();
  requests.handle({
    id: sent[1]!.id,
    result: { decision: "allow_for_session", grantedPermissions: null },
  });
  expect(await persistent).toBe(false);
  const cancelled = ask();
  requests.cancel(scope);
  expect(await cancelled).toBe(false);
  expect(
    requests.handle({
      id: sent[2]!.id,
      result: { decision: "allow_once", grantedPermissions: null },
    }),
  ).toBe(false);
  const aborted = ask();
  controller.abort();
  expect(await aborted).toBe(false);
});
