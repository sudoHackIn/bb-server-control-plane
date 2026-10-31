import { expect, it } from "vitest";
import { z } from "zod";
import { withTestHarness } from "../helpers/test-app.js";

it("repeats the deterministic command across transport retries until this conversation contains its tool result", async () => {
  await withTestHarness(async (harness) => {
    const imported: unknown = await import(
      new URL(
        "../../../../scripts/check-control-plane-user-threads.mjs",
        import.meta.url,
      ).href
    );
    const factory = z
      .object({
        createUserThreadFixture: z.custom<
          (input: { db: typeof harness.db.$client; users: [] }) => {
            handle: (
              body: {
                model: string;
                messages: Array<{
                  role: string;
                  content: string;
                  tool_call_id?: string;
                }>;
                tools: Array<{ function: { name: string } }>;
              },
              response: {
                writeHead: (
                  status: number,
                  headers: Record<string, string>,
                ) => void;
                end: (text: string) => void;
              },
            ) => boolean;
          }
        >((value) => typeof value === "function"),
      })
      .parse(imported).createUserThreadFixture;
    const fixture = factory({ db: harness.db.$client, users: [] });
    const base = {
      model: "qwen-job-test",
      tools: [{ function: { name: "run_shell_command" } }],
      messages: [{ role: "user", content: "BB_PERSONAL_fixture-retry" }],
    };
    function respond(body: typeof base) {
      let output = "";
      expect(
        fixture.handle(body, {
          writeHead: (status, headers) => {
            expect(status).toBe(200);
            expect(headers["content-type"]).toBe("text/event-stream");
          },
          end: (text) => {
            output = text;
          },
        }),
      ).toBe(true);
      return output;
    }
    expect(respond(base)).toContain('"finish_reason":"tool_calls"');
    expect(respond(base)).toContain('"finish_reason":"tool_calls"');
    const completed = {
      ...base,
      messages: [
        ...base.messages,
        {
          role: "tool",
          content: "command finished",
          tool_call_id: "personal_fixture-retry",
        },
      ],
    };
    expect(respond(completed)).toContain('"finish_reason":"stop"');
    expect(respond(base)).toContain('"finish_reason":"tool_calls"');
  });
});
