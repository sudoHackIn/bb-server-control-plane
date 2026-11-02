// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { DelegatedRunBanner } from "./DelegatedRunBanner";
import type { ControlPlaneDelegation } from "@bb/domain";
afterEach(cleanup);
const value: ControlPlaneDelegation = {
  invocationId: "00000000-0000-4000-8000-000000000001",
  state: "succeeded",
  cleanupPending: false,
  depth: 2,
  deadlineAt: 600000,
  parent: { kind: "workflow", id: "parent" },
};
function Location() {
  return <output>{useLocation().search}</output>;
}
it("opens the saved parent directly and clears stale child selections", () => {
  render(
    <MemoryRouter
      initialEntries={[
        "/projects/project?view=inspections&inspectKind=thread&inspectRun=child&inspectCall=old&inspectThread=old&testRun=old",
      ]}
    >
      <DelegatedRunBanner value={value} />
      <Location />
    </MemoryRouter>,
  );
  expect(screen.getByText("Closed delegated run")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Inspect parent" }));
  expect(screen.getByRole("status").textContent).toBe(
    "?view=inspections&inspectKind=workflow&inspectRun=parent",
  );
});
it("distinguishes parent-controlled work and fenced cleanup without exposing an unreadable parent", () => {
  const view = render(
    <MemoryRouter>
      <DelegatedRunBanner
        value={{ ...value, state: "running", parent: null }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText("Parent-controlled agent")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Inspect parent" })).toBeNull();
  view.rerender(
    <MemoryRouter>
      <DelegatedRunBanner
        value={{
          ...value,
          state: "cancelled",
          cleanupPending: true,
          parent: null,
        }}
      />
    </MemoryRouter>,
  );
  expect(
    screen.getByText("Execution is fenced. Child cleanup is pending."),
  ).toBeTruthy();
});
