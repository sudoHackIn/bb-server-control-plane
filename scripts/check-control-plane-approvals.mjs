import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export function createApprovalFixture({ db, users }) {
  const targets = new Map();
  const calls = new Set();
  let classifierFailures = 0;
  return {
    handle(body, res) {
      const classifierTarget = targets.get("auto-fallback");
      if (
        classifierTarget &&
        JSON.stringify(body.messages).includes(classifierTarget) &&
        !body.tools?.some((tool) =>
          ["write_file", "run_shell_command"].includes(tool.function?.name),
        )
      ) {
        classifierFailures++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "classifier-failure-fixture",
            object: "chat.completion",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "deliberately-invalid-classifier-output",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return true;
      }
      const marker = JSON.stringify(body.messages).match(
        /BB_APPROVAL_(auto-fallback|allow|deny|stop|revoke|edit|auto)/u,
      )?.[1];
      if (
        !marker ||
        !body.tools?.some((tool) =>
          ["write_file", "run_shell_command"].includes(tool.function?.name),
        )
      )
        return false;
      const target = targets.get(marker);
      assert.ok(target);
      const first = !calls.has(marker);
      calls.add(marker);
      const editing = marker === "edit" || marker === "auto";
      const name = editing ? "write_file" : "run_shell_command";
      assert.ok(body.tools.some((tool) => tool.function?.name === name));
      const code = `require("node:fs").writeFileSync(${JSON.stringify(target)},"approved")`;
      const delta = first
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `approval_${marker}`,
                type: "function",
                function: {
                  name,
                  arguments: JSON.stringify(
                    editing
                      ? { file_path: target, content: "approved" }
                      : {
                          command: `/usr/local/bin/node -e '${code}'`,
                          description: "Verify controlled approval",
                          timeout: 30000,
                        },
                  ),
                },
              },
            ],
          }
        : { role: "assistant", content: `Approval ${marker} completed` };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ id: `approval_${marker}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: `approval_${marker}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
      return true;
    },
    async verify({ send, wait, token }) {
      for (const marker of [
        "allow",
        "deny",
        "stop",
        "revoke",
        "edit",
        "auto",
        "auto-fallback",
      ]) {
        const user = users[marker === "deny" ? 1 : 0];
        const project = db
          .prepare(
            "SELECT * FROM control_plane_projects WHERE owner_user_id = ? AND slug = 'app'",
          )
          .get(user.id);
        const environment = db
          .prepare(
            "SELECT * FROM environments WHERE project_id = ? AND path = ?",
          )
          .get(project.project_id, project.cwd);
        const mode = marker.startsWith("auto") ? "auto" : "accept-edits";
        const target = `${marker === "edit" || marker.startsWith("auto") ? project.cwd : user.home}/bb-approval-${marker}`;
        targets.set(marker, target);
        const profile = await send(
          "/control-plane/admin/profiles",
          {
            slug: `approval-${marker}`,
            name: `Approval ${marker}`,
            definition: {
              prompt: "Controlled approval fixture",
              providerId: "qwen-server",
              model: "qwen-job-test",
              reasoningLevel: "none",
              permissionMode: mode,
              tools: ["run_shell_command", "write_file"],
              mcpServers: [],
            },
          },
          token,
        );
        assert.equal(profile.status, 201);
        const access = `/control-plane/admin/profiles/${profile.body.profile.id}/access/${user.id}`;
        assert.equal(
          (await send(access, { allowed: true }, token, "PUT")).status,
          200,
        );
        const started = await send(
          "/api/v1/threads",
          {
            projectId: project.project_id,
            environment: { type: "reuse", environmentId: environment.id },
            providerId: "qwen-server",
            controlPlaneProfileVersionId: profile.body.version.id,
            origin: "app",
            model: "qwen-configured-default",
            reasoningLevel: "none",
            permissionMode: mode,
            input: [
              { type: "text", text: `BB_APPROVAL_${marker}`, mentions: [] },
            ],
          },
          token,
        );
        assert.equal(started.status, 201, JSON.stringify(started.body));
        const id = started.body.id;
        const complete = async () =>
          wait(() => {
            const row = db
              .prepare("SELECT status FROM threads WHERE id = ?")
              .get(id);
            if (row?.status === "error")
              throw new Error(
                `Approval ${marker} failed: ${JSON.stringify(db.prepare("SELECT data FROM events WHERE thread_id = ? ORDER BY seq DESC LIMIT 5").all(id))}`,
              );
            return row?.status === "idle";
          }, `approval ${marker} completion`);
        if (marker !== "edit" && marker !== "auto") {
          const interaction = await wait(async () => {
            const pending = await send(
              `/api/v1/threads/${id}/interactions`,
              undefined,
              token,
            );
            const row = db
              .prepare("SELECT status FROM threads WHERE id = ?")
              .get(id);
            if (row?.status === "error")
              throw new Error(
                `Approval ${marker} failed before request: ${JSON.stringify(db.prepare("SELECT data FROM events WHERE thread_id = ? ORDER BY seq DESC LIMIT 5").all(id))}`,
              );
            return pending.body.find(
              (entry) => entry.payload?.kind === "approval",
            );
          }, `approval ${marker} request`);
          assert.equal(interaction.payload.subject.kind, "command");
          await assert.rejects(
            readFile(target),
            (error) => error.code === "ENOENT",
          );
          if (marker === "stop") {
            assert.equal(
              (
                await send(
                  `/api/v1/threads/${id}/stop`,
                  undefined,
                  token,
                  "POST",
                )
              ).status,
              200,
            );
          } else {
            if (marker === "revoke")
              assert.equal(
                (await send(access, { allowed: false }, token, "PUT")).status,
                200,
              );
            const resolution = ["deny", "auto-fallback"].includes(marker)
              ? { decision: "deny" }
              : { decision: "allow_once", grantedPermissions: null };
            const resolved = await send(
              `/api/v1/threads/${id}/interactions/${interaction.id}/resolve`,
              resolution,
              token,
            );
            assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
          }
        }
        await complete();
        if (["allow", "edit", "auto"].includes(marker))
          assert.equal(await readFile(target, "utf8"), "approved");
        else
          await assert.rejects(
            readFile(target),
            (error) => error.code === "ENOENT",
          );
        assert.deepEqual(
          (await send(`/api/v1/threads/${id}/interactions`, undefined, token))
            .body,
          [],
        );
        if (marker === "auto-fallback")
          assert.ok(
            classifierFailures > 0,
            "The native classifier failure path was not exercised",
          );
        if (marker === "revoke")
          assert.equal(
            (await send(access, { allowed: true }, token, "PUT")).status,
            200,
          );
      }
      return {
        nativeApprovalAllowDenyAndStop: true,
        grantRecheckedAfterApproval: true,
        workspaceEditsAutoApproved: true,
        nativeAutoModeWorkspaceEdit: true,
        nativeAutoClassifierFailureRequiresApproval: true,
      };
    },
  };
}
