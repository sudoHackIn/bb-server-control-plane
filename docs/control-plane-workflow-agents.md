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

## Step profiles and result authority

A managed `agent()` invocation inherits the run's exact profile version or selects
an explicit approved `profileVersionId`. Provider/model/reasoning overrides must
match that selected version. The server derives the worker's user, project,
UID/HOME/cwd and permissions from saved bindings; request text cannot replace them.

Current step-profile authority is checked before dispatch, during polling, when
accepting idle or structured results and before consuming a successful call.
Final run success also requires current root authority. A UID maintenance pause
retains the pending result until release without repeating agent execution;
permanent revocation rejects the affected result. An unhandled denial fails the
executing workflow.

Replay validates the source's saved user, project, environment, root profile and
execution mode, then checks the current grants for each cached step. Provenance
is followed through replay-of-replay references; missing or inconsistent bindings
fail closed. Traversal rejects cycles and chains exceeding 32 source calls.
Cancelling an old run does not remove its historical completed work; a new replay
still needs its own valid authority. Historical owned results remain readable
under existing project-read policy; that read permission does not authorize reuse
of the result in new execution.

## Remaining P3 work

Publication, invocation and per-step profile/result/replay authority are verified.
See [the step authority record](control-plane-phase-91-verification.json).
The next slices show phase/call/child progress directly in the agent task detail,
add scoped reviewer/developer access and separate developer test runs. Workflow
agent scheduling, interactive strategies and agent delegation are separate work.

## Owner execution inspection

The personal Agents task detail and advanced Workflows run detail link to
`?inspectRun=<run-id>`. Step and worker selection use `inspectCall` and
`inspectThread`; these are navigation values, never authorization. A plain
conversation agent opens its actual existing conversation directly.

The workflow inspector reads native records, with no second execution log:

- `GET /control-plane/user/workflows/:id/inspection?after=-1&limit=20`
  returns native run identity, input, source hash and output contract, central
  pinned root profile/workflow revision, call counts and at most 100 step
  summaries. `nextCursor` is the last returned call index when another page exists.
- `GET /control-plane/user/workflows/:id/calls/:callId` returns one recorded
  prompt/result/contract, execution selection, current counters/error, timing,
  up to 100 recorded worker IDs and readable replay provenance. Worker records
  include previous provider attempts; this list does not claim chronological
  order or invent individual attempt timestamps/errors that were never recorded.
- SDK `workflows.inspect` / `workflows.inspectCall` and CLI
  `bb server access workflows inspect` / `workflows call` use those same routes.

Both operations require the current run owner and current project read access.
A call ID must belong to the selected run. Replay source links require current
read access to the source. Each worker transcript independently uses the existing
scoped thread get/timeline/details/stream APIs. Deep-linking a worker not recorded
for that selected call does not request its transcript. Revoked/unavailable data
is hidden, including cached query data after a failed recheck. There are no send,
stop, replay or interaction-resolution controls inside the inspector.

The UI uses the native BB timeline and tool detail renderer with a return to the
selected step/run. A cached step says that it did not invoke a new model and
links to original work only when readable. A restart replay within the same run
can retain its existing worker records; a resumed-run cached call has no new
worker record. An archived/deleted worker may no longer have an available timeline.

This is the first P3.3 slice: root-to-agent calls, recorded phases, ordering and
execution intervals. Native nested workflow evaluation currently shares a flat
call list. Persisting nested workflow invocation spans, explicit parallel groups,
individual retry error history and independent file-change artifacts remains a
following P3.3 slice. Reviewer/developer grants and their administration remain
P3.4; administrators retain the existing full native BB/Workflows interfaces.
