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

The P3.3 inspector now also reads native execution structure from
`GET /control-plane/user/workflows/:id/trace?after=-1&limit=20`.
The SDK is `workflows.trace`; CLI is `bb server access workflows trace`.
Each evaluator execution creates a server-owned attempt UUID and increasing
sequence. Responses contain an attempt summary and at most 100 entries; pin
`attemptId` (`--attempt`) with each numeric continuation cursor. The default
selects the latest attempt. A known older attempt must still belong to this run
under current owner/project read authority. Legacy/unstarted runs return a null
attempt, not an invented hierarchy.

Workflow entries record the actually loaded nested source name/hash and actual
agent-call parent scope, including when concurrent nested VMs interleave. The
existing single-child-level runtime limit is unchanged. Parallel entries record
explicit `parallel()` boundaries, branch count and failed-branch count in the
containing workflow VM. They do not claim agent/child-workflow membership in an
individual parallel branch; asynchronous time overlap is not evidence of that
relationship. A parallel group can settle successfully with failed branches,
because the existing DSL converts those failures into null result slots.

Native SQLite retains structure attempts/entries alongside native runs. Recovery
marks an unfinished attempt interrupted before a new one begins. Attempt-local
live/cached admission is retained even if a successful native call is reused on
restart. A historical entry links to its native call only while its captured
cache key still matches the call record; overwritten records do not silently
open different work. These entries are structure metadata, not a transcript
snapshot or a second execution/result log. Worker chats remain native BB records.
Native run retention cascades to recorded structure.

The recorder admits at most 1024 scope/group nodes and 1 MiB of metadata per
evaluator attempt; further structure is explicitly truncated without changing
execution results or worker budgets. Unclosed omitted nodes become incomplete.
The server assigns receipt timestamps, validates scope parents and bounds trace
frames independently of the existing workflow traffic budget. Trace metadata
cannot grant execution or read authority. The fixed local evaluator protocol is
version 2; rebuild/redeploy that artifact with the server. No host-daemon protocol
or launcher identity/permission behavior changes.

Call inspection also returns `diagnostics` and `fileArtifacts` through the same
owner/project-scoped route, SDK `workflows.inspectCall` and CLI `workflows call`.
The native plugin journal records call admission, provider retry decisions,
structured-output rejections and terminal errors with receipt timestamps, worker
references and attempt counters. A rejection counter does not imply that a new
corrective turn was admitted: the final over-budget rejection is recorded too.
Messages are bounded to 8 KiB with a truncation suffix; at most 100 journal
entries are returned. `recordedSince: null` means complete coverage is unknown
for an old call, not that no error happened. Available partial entries still show.
Journal writes share the state-change transaction and native call retention.
A captured cache key isolates the current call from prior overwritten records;
replay does not manufacture new provider attempts or copy original error history.

File artifacts are read from retained native `item/completed` events: normalized
`fileChange` patches and Qwen `write_file`/`edit` results. They include event/worker
identity, time, path, native status and available patch/result text, including
failed edit attempts. The service checks each worker's current owner/project
access and only uses its current call reference or a matching journal reference.
Unbound historical workers and deleted/unreadable workers are explicitly counted
as unavailable. No file path is opened by this read API. File artifacts are not
filesystem snapshots, a proof every attempted edit succeeded, or a complete
record of arbitrary shell writes. Missing/retention-pruned events mean no
available artifact, not no file modification. Cached resumed runs link to their
readable original work instead of copying artifacts.

The response admits at most 100 artifacts from the first 100 candidate events,
64 KiB per patch/result and 1 MiB aggregate patch/result bytes. Malformed or
oversized event payloads and excess entries are explicitly marked omitted;
individual patch/result truncation is separate. Native retained tool outputs are
hydrated within a 1 MiB event read budget; expired or oversized retained outputs
keep their existing preview and truncation indicator. Paths are display metadata,
never an API capability to read arbitrary filesystem content. No host-daemon
protocol or provider behavior changes are required by this inspection slice.
Deploy the server, builtin Workflows bundle and limited SDK/CLI clients together:
the strict call-inspection response now includes diagnostics and file artifacts.

Reviewer/developer grants remain P3.4; administrators retain existing full native
BB/Workflows interfaces.
