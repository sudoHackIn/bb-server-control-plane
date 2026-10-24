import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const sessionId = process.argv.includes("--resume")
  ? arg("--resume")
  : arg("--session-id");
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    if (
      message.request.subtype === "initialize" &&
      process.env.QWEN_FIXTURE_AUTH_REQUIRED === "1"
    ) {
      const event = {
        type: "system",
        subtype: "auth_required",
        uuid: randomUUID(),
        session_id: "",
        auth_type: "myqwen",
        url: "https://login.example.invalid/signin?state=fixture",
      };
      send(event);
      send({ ...event, uuid: randomUUID() });
      setTimeout(
        () =>
          send({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response: {},
            },
          }),
        100,
      );
      return;
    }
    const response =
      message.request.subtype === "get_available_models"
        ? {
            subtype: "get_available_models",
            models: [
              { id: "fixture-a", label: "Fixture A" },
              { id: "fixture-b" },
            ],
          }
        : {};
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response,
      },
    });
  }
  if (message.type === "user") {
    send({
      type: "assistant",
      uuid: randomUUID(),
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: randomUUID(),
        type: "message",
        role: "assistant",
        model: "fixture",
        content: [{ type: "text", text: "real SDK transport answer" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    send({
      type: "result",
      subtype: "success",
      uuid: randomUUID(),
      session_id: sessionId,
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: "real SDK transport answer",
      usage: { input_tokens: 1, output_tokens: 1 },
      permission_denials: [],
    });
  }
});
