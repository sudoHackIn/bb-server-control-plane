import { expect, it, vi } from "vitest";
import { createApprovalTransport } from "../src/approval-transport.js";

const request = (id: string) => ({
  type: "control_request",
  request_id: id,
  request: {
    subtype: "can_use_tool",
    tool_name: "run_shell_command",
    tool_use_id: `tool-${id}`,
    input: { command: "same command" },
    blocked_path: null,
  },
});

it("keeps parallel identical calls bound to their native tool and request IDs", async () => {
  const decisions = new Map<string, (allowed: boolean) => void>();
  const responses: object[] = [];
  const transport = createApprovalTransport({
    request: (value) =>
      new Promise((resolve) => decisions.set(value.toolUseId, resolve)),
    write: (value) => responses.push(value),
  });
  expect(transport.handle(request("one"))).toBe(true);
  expect(transport.handle(request("two"))).toBe(true);
  expect(transport.handle({ type: "control_response", response: {} })).toBe(
    false,
  );
  expect(
    transport.handle({
      type: "control_request",
      request_id: "other",
      request: { subtype: "mcp_message" },
    }),
  ).toBe(false);
  decisions.get("tool-two")?.(true);
  decisions.get("tool-one")?.(false);
  await vi.waitFor(() => expect(responses).toHaveLength(2));
  expect(responses).toEqual([
    {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "two",
        response: {
          behavior: "allow",
          updatedInput: { command: "same command" },
        },
      },
    },
    {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "one",
        response: {
          behavior: "deny",
          message: "Tool approval was denied or is unavailable",
        },
      },
    },
  ]);
});

it("denies cancelled, timed out and closed approvals and never accepts late replies", async () => {
  const responses: object[] = [];
  const transport = createApprovalTransport({
    request: () => new Promise(() => {}),
    write: (value) => responses.push(value),
    timeoutMs: 20,
  });
  transport.handle(request("cancelled"));
  transport.handle({ type: "control_cancel_request", request_id: "cancelled" });
  transport.handle(request("timeout"));
  await vi.waitFor(() => expect(responses).toHaveLength(2));
  expect(JSON.stringify(responses)).not.toContain('"behavior":"allow"');
  transport.handle(request("closed"));
  transport.cancel();
  await vi.waitFor(() => expect(responses).toHaveLength(3));
  expect(JSON.stringify(responses)).not.toContain('"behavior":"allow"');
});
