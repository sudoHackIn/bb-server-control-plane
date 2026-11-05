import { expect, it, vi } from "vitest";
import { createControlPlaneClient } from "@bb/sdk/node";
import { registerServerWebhookCommands } from "../../commands/server-webhooks.js";
import {
  runCommand,
  setupCommandOutputTestEnvironment,
} from "../helpers/command-output-harness.js";
setupCommandOutputTestEnvironment();
it("routes webhook management and pagination through the restricted SDK", async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const id = "11111111-1111-4111-8111-111111111111",
    version = "22222222-2222-4222-8222-222222222222";
  const hook = {
    id,
    name: "Tasks",
    projectId: "project",
    profileVersionId: version,
    inputField: "task",
    enabled: true,
    createdAt: 1,
    deliveryPath: `/control-plane/webhooks/${id}/deliver`,
  };
  const client = createControlPlaneClient({
    origin: "https://bb.example",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push({
        path: new URL(request.url).pathname,
        method: request.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json(
        request.url.includes("/history")
          ? { deliveries: [], nextCursor: null }
          : request.method === "POST"
            ? { webhook: hook, secret: `whk_${"a".repeat(43)}` }
            : request.method === "PUT"
              ? { ...hook, enabled: false }
              : { webhooks: [hook], nextCursor: null },
      );
    },
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  const register = (program: import("commander").Command) =>
    registerServerWebhookCommands(program, () => client);
  await runCommand(
    [
      "webhooks",
      "create",
      "project",
      "--profile-version",
      version,
      "--name",
      "Tasks",
      "--input-field",
      "task",
      "--json",
    ],
    register,
  );
  await runCommand(["webhooks", "list", "project", "--json"], register);
  await runCommand(["webhooks", "history", id, "--json"], register);
  await runCommand(["webhooks", "disable", id, "--json"], register);
  await runCommand(["webhooks", "rotate", id, "--json"], register);
  expect(calls.map((c) => c.method)).toEqual([
    "POST",
    "GET",
    "GET",
    "PUT",
    "POST",
  ]);
  expect(calls[0].body).toEqual({
    projectId: "project",
    profileVersionId: version,
    name: "Tasks",
    inputField: "task",
  });
  expect(calls[3].body).toEqual({ enabled: false });
  expect(calls[4].path).toBe(`/control-plane/user/webhooks/${id}/rotate`);
});
