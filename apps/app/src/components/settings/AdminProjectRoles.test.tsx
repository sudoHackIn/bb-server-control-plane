// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createControlPlaneClient } from "@bb/sdk/browser";
import { afterEach, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { AdminProjectRoles } from "./AdminProjectRoles";

const ownerId = "00000000-0000-4000-8000-000000000001";
const aliceId = "00000000-0000-4000-8000-000000000002";
const operationId = "00000000-0000-4000-8000-000000000003";

afterEach(() => {
  cleanup();
});

it("uses the current policy revision when granting and removing a searched user", async () => {
  let revision = 1;
  let aliceRole: "runner" | "viewer" | null = null;
  const mutations: Array<{ role: string | null; expectedRevision: number }> =
    [];
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/control-plane/admin/users") {
      return Response.json({
        users: [
          {
            userId: aliceId,
            login: "alice",
            enabled: true,
            environmentStatus: "ready",
          },
        ],
        nextCursor: null,
      });
    }
    if (path === "/control-plane/admin/projects/proj_test/access") {
      return Response.json({
        projectId: "proj_test",
        revision,
        appliedRevision: revision,
        grants: [
          {
            userId: ownerId,
            login: "owner",
            role: "owner",
            enabled: true,
            environmentStatus: "ready",
          },
          ...(aliceRole
            ? [
                {
                  userId: aliceId,
                  login: "alice",
                  role: aliceRole,
                  enabled: true,
                  environmentStatus: "ready",
                },
              ]
            : []),
        ],
        pendingOperationId: null,
      });
    }
    if (
      path === `/control-plane/admin/projects/proj_test/access/${aliceId}` &&
      init?.method === "PUT"
    ) {
      const inputBody: unknown = JSON.parse(String(init.body));
      if (
        !inputBody ||
        typeof inputBody !== "object" ||
        !("role" in inputBody) ||
        !("expectedRevision" in inputBody)
      )
        throw new Error("Invalid role body");
      const role = inputBody.role;
      const expectedRevision = inputBody.expectedRevision;
      if (
        (role !== "runner" && role !== "viewer" && role !== null) ||
        typeof expectedRevision !== "number"
      )
        throw new Error("Invalid role mutation");
      mutations.push({ role, expectedRevision });
      if (expectedRevision !== revision)
        return Response.json(
          { error: "role_change_conflict" },
          { status: 409 },
        );
      aliceRole = role;
      revision += 1;
      return Response.json({
        changed: true,
        revision,
        operationId,
        phase: "complete",
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  });
  const client = createControlPlaneClient({
    origin: "http://localhost:3000",
    fetch: fetcher,
  });
  const { wrapper } = createQueryClientTestHarness();
  render(<AdminProjectRoles client={client} projectId="proj_test" />, {
    wrapper,
  });

  fireEvent.click(screen.getByRole("button", { name: "Manage server access" }));
  expect(await screen.findByText(/Policy revision 1/)).toBeDefined();
  fireEvent.click(await screen.findByRole("button", { name: "Grant runner" }));
  await waitFor(() =>
    expect(mutations).toEqual([{ role: "runner", expectedRevision: 1 }]),
  );
  expect(await screen.findByText(/Policy revision 2/)).toBeDefined();
  fireEvent.change(screen.getByRole("combobox", { name: "alice role" }), {
    target: { value: "remove" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(mutations).toEqual([
      { role: "runner", expectedRevision: 1 },
      { role: null, expectedRevision: 2 },
    ]),
  );
  expect(await screen.findByText(/Policy revision 3/)).toBeDefined();
});

it("holds another role change until saved maintenance completes", async () => {
  let changed = false;
  let completed = false;
  let operationReads = 0;
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/control-plane/admin/users")
      return Response.json({
        users: [
          {
            userId: aliceId,
            login: "alice",
            enabled: true,
            environmentStatus: "ready",
          },
        ],
        nextCursor: null,
      });
    if (path === "/control-plane/admin/projects/proj_test/access")
      return Response.json({
        projectId: "proj_test",
        revision: changed ? 2 : 1,
        appliedRevision: completed ? 2 : 1,
        grants: [
          {
            userId: ownerId,
            login: "owner",
            role: "owner",
            enabled: true,
            environmentStatus: "ready",
          },
        ],
        pendingOperationId: changed && !completed ? operationId : null,
      });
    if (
      path === `/control-plane/admin/projects/proj_test/access/${aliceId}` &&
      init?.method === "PUT"
    ) {
      changed = true;
      return Response.json({
        changed: true,
        revision: 2,
        operationId,
        phase: "draining",
      });
    }
    if (
      path ===
      `/control-plane/admin/projects/proj_test/access/maintenance/${operationId}`
    ) {
      operationReads += 1;
      completed = operationReads > 1;
      return Response.json({
        operationId,
        projectId: "proj_test",
        revision: 2,
        phase: completed ? "complete" : "draining",
        participantCount: 2,
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  });
  const client = createControlPlaneClient({
    origin: "http://localhost:3000",
    fetch: fetcher,
  });
  const { wrapper } = createQueryClientTestHarness();
  render(<AdminProjectRoles client={client} projectId="proj_test" />, {
    wrapper,
  });
  fireEvent.click(screen.getByRole("button", { name: "Manage server access" }));
  fireEvent.click(await screen.findByRole("button", { name: "Grant runner" }));
  await screen.findByText("Applying access change: draining");
  expect(
    screen
      .getByRole("button", { name: "Grant runner" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await waitFor(() => expect(completed).toBe(true), { timeout: 4000 });
  await waitFor(() =>
    expect(screen.getByText(/Policy revision 2; applied 2/)).toBeDefined(),
  );
});
