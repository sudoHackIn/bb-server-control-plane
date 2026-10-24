import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});
it("binds only same-origin application requests to the verified document identity", async () => {
  vi.resetModules();
  vi.stubGlobal("window", { location: { origin: "https://bb.example" } });
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(
        new Request(
          new URL(
            input instanceof Request ? input.url : input.toString(),
            "https://bb.example",
          ),
          init,
        ),
      );
      return Response.json({ ok: true });
    }),
  );
  const { configureAccountStorage } = await import("./account-storage");
  configureAccountStorage("admin:оператор", "a".repeat(64));
  const { fetchWithAppSurface } = await import("./app-surface");
  await fetchWithAppSurface("/api/v1/projects");
  await fetchWithAppSurface("https://other.example/api/v1/projects");
  expect(requests[0]?.headers.get("x-bb-client-identity")).toBe(
    encodeURIComponent("admin:оператор"),
  );
  expect(requests[0]?.headers.get("x-bb-client-session")).toBe("a".repeat(64));
  expect(requests[1]?.headers.has("x-bb-client-identity")).toBe(false);
  expect(requests[1]?.headers.has("x-bb-client-session")).toBe(false);
});
