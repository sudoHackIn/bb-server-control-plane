# Published workflow agents

An immutable agent version may include `workflow: {definitionId, revision}`.
The administrator publishes an enabled saved workflow revision. Publication
validates the native workflow contracts and copies its exact source into private
storage keyed by the profile version, in the same transaction as that version.
Personal catalog/profile responses expose the reference and strategy, without
the copied source. The original saved definition remains an authoring object.
Its later edits, disablement or removal do not modify the approved copy. Revoke
an agent/profile version or its grants to prevent further execution.

## Prepare and publish

The workflow must declare a literal `meta.inputSchema` with `type: "string"`
and an `outputSchema`. For example:

```js
export const meta = {
  name: "diagram-converter",
  description: "Convert a supplied diagram to PlantUML",
  inputSchema: { type: "string", minLength: 1, maxLength: 20000 },
  outputSchema: { type: "string", maxLength: 100000 },
};
return await agent("Convert this diagram to PlantUML:\n" + args);
```

Save the source through the advanced workflow authoring surface or
`bb server access workflows definitions create <origin-thread-id> --file
<local-file> --args '"example input"' --json`. Record its ID and revision.
An administrator can choose **Background workflow** in the Server agents editor,
enter that reference and publish the normal prompt/model/tools/MCP profile.
The same definition is accepted by the existing administrative profiles SDK and
`profiles create/publish --definition-stdin` commands. No raw workflow source is
accepted in the profile request. Approval of a missing/disabled revision or a
workflow without the required contracts fails before creating an agent version.

The saved definition's owner/project are not execution authority for its users.
Grant the published agent as usual. A granted user invokes it in their own
registered, authorized project, under their persisted UID, HOME and cwd.

## Invoke and inspect

The catalog offers **Run task** and displays the task in the existing work list.
Users choose an agent and enter task text. Chat and schedule actions are hidden
for this strategy, and their backend admission paths reject it as well.

API clients use the existing `POST /control-plane/user/agent-runs`,
`agentRuns.start` SDK method, or `bb server access agent-runs start <project-id>
--profile-version <version-id> --input <text> --idempotency-key <key>`.
Both strategies share listing, get/status, result and cancel operations.
Workflow tasks return `strategy: "workflow"`, `threadId: null` and
`workflowRunId` equal to `runId`, with native queued/running/succeeded/failed/
cancelled status. A result string is readable text; other JSON is formatted;
failed tasks expose their bounded native error. The task title comes from input.

Input is nonblank text capped at 128 KiB UTF-8. Native workflow schema validation
checks the arguments before admission and the final value before success.
Output must be JSON within 1 MiB encoded size, 100,000 nodes and depth 128;
invalid output becomes a persisted failed workflow with no successful result.
Saved default arguments are not applied to an agent task.

The native workflow run is the sole lifecycle/history/result record. Existing
central job bindings pin its user, project and agent version. The `wfa_` namespace
is reserved for admitted workflow-agent runs; its deterministic ID hashes user
identity and the idempotency key. Native persistence verifies source, arguments,
project and profile on a retry. Admissions for a user's retry key are serialized
across strategies, and native workflow admissions also serialize repeated IDs.
No independent control-plane run status or result table is introduced.

Read native call history with `workflows.history(workflowRunId)` or
`bb server access workflows history <workflow-run-id> --json`. Thread events and
workflow calls have distinct cursors; `agentRuns.events/stream` on a workflow task
return `409 workflow_history_required`. The task UI polls native status/result.
Advanced project workflow replay accepts this run as its source with the same
pinned profile and environment. Replayed runs remain in advanced workflow history.
Successful-prefix replay is not an exactly-once guarantee for external effects.

## Remaining P3 work

This slice publishes and invokes a background strategy. The next slices audit
and complete per-step profile selection/revocation/recovery for published agents,
and show phase/call/child progress directly in the agent task detail. Workflow
agent scheduling, interactive strategies and agent delegation are separate work.
