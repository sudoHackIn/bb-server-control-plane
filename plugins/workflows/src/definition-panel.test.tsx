// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  loadPluginApp,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { workflowDefinitionRpcContract } from "./definition-api.js";

const app = await loadPluginApp(() => import("./app"));
const panel = app.navPanels.find((entry) => entry.id === "definitions")!;
const owner = "11111111-1111-4111-8111-111111111111";
const saved = {
  id: "wfd_test",
  projectId: "project",
  originThreadId: "thread",
  revision: 1,
  name: "Release",
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
  script:
    'export const meta={name:"Release",description:"Saved"}; return args;',
  args: { saved: true },
};
const row = { ...saved, ownerUserId: owner };
function unexpected(): never {
  throw new Error("Unexpected RPC");
}
const defaults: PluginRpcTestHandlers<typeof workflowDefinitionRpcContract> = {
  controlPlaneDefinitionInventory: unexpected,
  controlPlaneDefinitionCreate: unexpected,
  controlPlaneDefinitions: unexpected,
  controlPlaneDefinitionGet: unexpected,
  controlPlaneDefinitionApprove: unexpected,
  controlPlaneDefinitionUpdate: unexpected,
  controlPlaneDefinitionEnabled: unexpected,
  controlPlaneDefinitionRemove: unexpected,
  controlPlaneDefinitionRun: unexpected,
};
afterEach(cleanup);

it("uses saved revisions and arguments, preserves a stale draft across enable, and sends CAS updates", async () => {
  const update = vi.fn(() => {
    throw new Error("revision conflict");
  });
  const run = vi.fn(() => ({
    id: "wfr_run",
    projectId: "project",
    originThreadId: "thread",
    name: "Release",
    status: "queued" as const,
    phase: null,
    error: null,
    resultAvailable: false,
    notificationOutcome: "pending" as const,
    createdAt: 1,
    startedAt: null,
    finishedAt: null,
  }));
  const slot = renderSlot<
    PluginNavPanelProps,
    typeof workflowDefinitionRpcContract
  >(
    panel,
    { subPath: "" },
    {
      rpc: {
        ...defaults,
        controlPlaneDefinitionInventory: () => ({
          definitions: [row],
          nextCursor: null,
        }),
        controlPlaneDefinitionGet: ({ revision }) => ({
          ...saved,
          revision: revision ?? 1,
        }),
        controlPlaneDefinitionEnabled: () => ({
          ...saved,
          revision: 9,
          enabled: false,
        }),
        controlPlaneDefinitionRun: run,
        controlPlaneDefinitionUpdate: update,
      },
    },
  );
  fireEvent.click(await slot.findByRole("button", { name: "Release" }));
  await slot.findByRole("heading", { name: "Loaded revision 1: Release" });
  expect(slot.getByText(owner, { exact: true })).toBeTruthy();
  fireEvent.change(slot.getByLabelText("Definition source"), {
    target: { value: "draft" },
  });
  fireEvent.change(slot.getByLabelText("Default arguments"), {
    target: { value: '{"draft":true}' },
  });
  fireEvent.click(slot.getByRole("button", { name: "Run saved revision" }));
  await slot.findByText("Started workflow: wfr_run");
  expect(run).toHaveBeenCalledWith({ id: saved.id, revision: 1 });
  fireEvent.click(slot.getByRole("button", { name: "Disable definition" }));
  await slot.findByRole("button", { name: "Enable definition" });
  expect(
    slot.getByRole("heading", { name: "Loaded revision 1: Release" }),
  ).toBeTruthy();
  expect(slot.getByLabelText("Definition source")).toHaveProperty(
    "value",
    "draft",
  );
  expect(
    slot.getByRole("button", { name: "Run saved revision" }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(slot.getByRole("button", { name: "Save new revision" }));
  await slot.findByRole("alert");
  expect(update).toHaveBeenCalledWith({
    id: saved.id,
    expectedRevision: 1,
    script: "draft",
    args: { draft: true },
  });
  fireEvent.change(slot.getByLabelText("Revision to load"), {
    target: { value: "4" },
  });
  fireEvent.click(slot.getByRole("button", { name: "Load revision" }));
  await slot.findByRole("heading", { name: "Loaded revision 4: Release" });
});

it("creates from an origin, validates JSON before RPC, and deletes without keeping stale controls", async () => {
  const create = vi.fn(() => saved);
  const remove = vi.fn(() => ({ deleted: true as const }));
  const slot = renderSlot<
    PluginNavPanelProps,
    typeof workflowDefinitionRpcContract
  >(
    panel,
    { subPath: "" },
    {
      rpc: {
        ...defaults,
        controlPlaneDefinitionInventory: () => ({
          definitions: [],
          nextCursor: null,
        }),
        controlPlaneDefinitionCreate: create,
        controlPlaneDefinitionRemove: remove,
      },
    },
  );
  await slot.findByRole("region", { name: "Definition editor" });
  fireEvent.change(slot.getByLabelText("Project ID"), {
    target: { value: " project " },
  });
  fireEvent.change(slot.getByLabelText("Origin thread ID"), {
    target: { value: " thread " },
  });
  fireEvent.change(slot.getByLabelText("Definition source"), {
    target: { value: saved.script },
  });
  fireEvent.change(slot.getByLabelText("Default arguments"), {
    target: { value: "{" },
  });
  fireEvent.click(slot.getByRole("button", { name: "Create definition" }));
  await slot.findByRole("alert");
  expect(create).not.toHaveBeenCalled();
  fireEvent.change(slot.getByLabelText("Default arguments"), {
    target: { value: "null" },
  });
  fireEvent.click(slot.getByRole("button", { name: "Create definition" }));
  await slot.findByRole("button", { name: "Delete definition" });
  expect(create).toHaveBeenCalledWith({
    projectId: "project",
    originThreadId: "thread",
    script: saved.script,
    args: null,
  });
  expect(slot.getByLabelText("Project ID")).toHaveProperty("disabled", true);
  fireEvent.click(slot.getByRole("button", { name: "Delete definition" }));
  await waitFor(() =>
    expect(
      slot.queryByRole("button", { name: "Run saved revision" }),
    ).toBeNull(),
  );
  expect(remove).toHaveBeenCalledWith({ id: saved.id });
  expect(slot.getByLabelText("Origin thread ID")).toHaveProperty("value", "");
});

it("pages and filters metadata and hides cached controls when inventory access fails", async () => {
  let fail = false;
  const inventory = vi.fn(({ cursor }: { cursor?: string | null }) => {
    if (fail) throw new Error("access expired");
    return { definitions: [row], nextCursor: cursor ? null : owner };
  });
  const slot = renderSlot<
    PluginNavPanelProps,
    typeof workflowDefinitionRpcContract
  >(
    panel,
    { subPath: "" },
    {
      rpc: {
        ...defaults,
        controlPlaneDefinitionInventory: inventory,
        controlPlaneDefinitionGet: () => saved,
      },
    },
  );
  fireEvent.click(await slot.findByRole("button", { name: "Release" }));
  await slot.findByRole("button", { name: "Run saved revision" });
  fireEvent.change(slot.getByLabelText("Filter by project ID"), {
    target: { value: " project " },
  });
  fireEvent.click(slot.getByRole("button", { name: "Refresh definitions" }));
  await waitFor(() =>
    expect(inventory).toHaveBeenLastCalledWith({
      cursor: null,
      limit: 20,
      projectId: "project",
    }),
  );
  await waitFor(() =>
    expect(
      slot.getByRole("button", { name: "Next definitions" }),
    ).toHaveProperty("disabled", false),
  );
  fireEvent.click(slot.getByRole("button", { name: "Next definitions" }));
  await waitFor(() =>
    expect(inventory).toHaveBeenLastCalledWith({
      cursor: owner,
      limit: 20,
      projectId: "project",
    }),
  );
  await waitFor(() =>
    expect(
      slot.getByRole("button", { name: "Refresh definitions" }),
    ).toHaveProperty("disabled", false),
  );
  fail = true;
  fireEvent.click(slot.getByRole("button", { name: "Refresh definitions" }));
  await slot.findByRole("alert");
  expect(slot.queryByRole("region", { name: "Definition editor" })).toBeNull();
  expect(slot.queryByRole("button", { name: "Release" })).toBeNull();
});

it("clears the previous source and execution controls when another definition cannot be read", async () => {
  let fail: (() => void) | undefined;
  const pending = new Promise<typeof saved>((_, reject) => {
    fail = () => reject(new Error("definition unavailable"));
  });
  const slot = renderSlot<
    PluginNavPanelProps,
    typeof workflowDefinitionRpcContract
  >(
    panel,
    { subPath: "" },
    {
      rpc: {
        ...defaults,
        controlPlaneDefinitionInventory: () => ({
          definitions: [row, { ...row, id: "other", name: "Other owner" }],
          nextCursor: null,
        }),
        controlPlaneDefinitionGet: ({ id }) =>
          id === saved.id ? saved : pending,
      },
    },
  );
  fireEvent.click(await slot.findByRole("button", { name: "Release" }));
  await slot.findByRole("button", { name: "Run saved revision" });
  fireEvent.click(slot.getByRole("button", { name: "Other owner" }));
  await waitFor(() =>
    expect(slot.getByLabelText("Definition source")).toHaveProperty(
      "value",
      "",
    ),
  );
  expect(slot.queryByRole("button", { name: "Run saved revision" })).toBeNull();
  await act(async () => {
    fail?.();
    await pending.catch(() => {});
  });
  await slot.findByRole("alert");
  expect(slot.getByRole("alert").textContent).toContain(
    "definition unavailable",
  );
  expect(slot.getByLabelText("Definition source")).toHaveProperty("value", "");
  expect(slot.queryByRole("button", { name: "Run saved revision" })).toBeNull();
});
