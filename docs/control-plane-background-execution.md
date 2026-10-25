# Shared-server background execution

This is a source inventory and integration plan for the required personal
workflow/automation/schedule stage. The authority-binding foundation and native
workflow owner/binding persistence and isolated pure evaluation are implemented.
Worker authority/dispatch and the isolated agent process bridge are implemented.
Nested workflows and automation integration remain unfinished. The acceptance checklist in `server-control-plane.md` remains authoritative.

## Existing persistence and execution

| Area                         | Source                                                                                                                                | Current boundary and required integration                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow entry points        | `plugins/workflows/src/server.ts`, `cli.ts`, `ui-contract.ts`, `workflow-input.ts`                                                    | Agent tool, CLI and UI RPC accept origin/run identifiers. Source loading can read workspace workflow files. Bind verified owner/project authority before loading tenant source or exposing a run. Origin metadata is not authentication.                                                                                                                                                                                                  |
| Workflow durability          | `plugins/workflows/src/data.ts`, `service.ts`                                                                                         | Existing runs, calls, workers, replay, retries, recovery and notifications remain the durable workflow store. Owner/binding references and owner-filtered native readers are now attached to runs. Definition ownership and controlled runtime recovery remain open.                                                                                                                                                                      |
| Workflow execution           | `plugins/workflows/src/runtime.ts`, `service.ts`                                                                                      | Standalone QuickJS executes in the service; managed pure evaluation uses the fixed registered-UID process. Existing standalone worker threads use `bb.sdk.threads.spawn` with the origin environment and selected provider/model/reasoning/mode. Tenant script evaluation needs a separate registered-UID process; worker creation needs the saved binding and approved profile. A VM alone does not meet the Unix isolation requirement. |
| Automation definitions/runs  | `plugins/automations/src/data.ts`, `service.ts`, `rpc.ts`, `cli.ts`                                                                   | Plugin-owned SQLite stores definitions, triggers, runs and output, with project/creator metadata. Add ownership through binding references at create/edit/read/run boundaries. Shared project membership must not reveal another user's personal automation.                                                                                                                                                                              |
| Automation dispatch/recovery | `plugins/automations/src/run.ts`, `sweep.ts`, `server.ts`                                                                             | New-thread dispatch, target-thread sends, script execution, due sweeps and reconciliation must use saved user authority. Restart and callback execution cannot inherit service privileges.                                                                                                                                                                                                                                                |
| Automation workspace scripts | `plugins/automations/src/script-runner.ts`, `script-files.ts`, `working-directory.ts`                                                 | Current direct `spawn` has cwd/env but no registered UID/GID. Route tenant scripts through the restricted launcher; resolve cwd/HOME from registry/project authority. Do not expose the service CLI credential or database.                                                                                                                                                                                                               |
| Platform plugin schedules    | `packages/db/src/data/plugin-schedules.ts`, `apps/server/src/services/plugins/plugin-service.ts`                                      | `plugin_schedules` identifies centrally registered callbacks by pluginId/name. This is a trusted plugin timer, not a personal job owner. Preserve its atomic claim; personal due objects still require their own authority and lifecycle.                                                                                                                                                                                                 |
| Native queued/delayed sends  | `packages/db/src/data/queued-thread-messages.ts`, `apps/server/src/services/threads/queued-messages.ts`, `queued-message-dispatch.ts` | Messages persist thread identity, schedule/claim/retry state and origin metadata. Authorize actual execution through the owned thread and job ancestry when supplied. A sender/origin ID alone grants no rights.                                                                                                                                                                                                                          |
| Periodic retries/restart     | `apps/server/src/services/system/periodic-sweeps.ts`                                                                                  | Separate idle queue delivery, due scheduled delivery, failed retry, orphaned wait cleanup and plugin schedule sweeps exist. Audit actual dispatch and recovery, not just the initial HTTP request.                                                                                                                                                                                                                                        |

`plugins/scheduled-send/server.ts` is currently a stub; delayed-message behavior is
implemented by the native queue paths above. Scheduler, workflow replay and the
queue's claims do not establish exactly-once external side effects.

## Central authority bindings

Migration 0152 adds `control_plane_job_bindings` to the shared BB database. A
binding identifies a native object kind, native object ID and immutable revision.
It stores the owner user, project, immutable profile version, optional original
thread and optional source binding. It stores no browser credential, UID/HOME
copy, workflow source, call history, result, cron state or plugin configuration.
Those durable product records remain in their existing stores.

The unique native object/revision identity makes repeated registration idempotent.
An object cannot change owner or project through another revision. Definition
configuration changes can create a new binding revision while prior runs retain
their exact source/profile references. The plugin integration must explicitly
choose which revision is current and retire superseded definitions when required;
this registry does not silently switch an existing run to the latest profile.

Owner/project filtering occurs in SQL before list cursors/limits. Current project
read access permits reading authorized historical metadata after profile loss;
execution additionally requires an enabled user, provisioned environment,
executable owned project, current profile/version grants and a valid source chain.
Every source is checked for enabled/deleted state and matching owner/project;
cycles and ancestry graphs larger than 32 bindings fail closed. An origin that
is itself a mapped worker contributes its binding as another dependency; shared
ancestors in a convergent graph do not count as cycles. Origin references retain
their ID after a thread is physically removed, so removal cannot turn a dependent
job into an unbound job. Deleted projects cascade their central bindings.

Only enabled state and deletion tombstones can change on an existing binding.
Re-enabling checks current execution permissions and ancestry. Disabling or
removing one's accessible binding remains possible after profile loss. Tombstoned
binding revisions cannot be recreated by an idempotent registration. Missing
bindings have no fallback to public/admin execution.

`withControlPlaneJobAuthority` resolves current registry/profile/project state and
runs a callback under the saved user's server principal. A user principal cannot
invoke another user's binding. Async callbacks preserve that principal; the
caller's previous scope is restored afterward. This is internal server plumbing,
not a public capability token. The internal builtin-only Plugin SDK facade now
wraps these same operations. Native workflow runs now retain binding references;
the worker kernel and isolated agent bridge now participate in native dispatch.
Nested workflows and automation integration remain pending.

## Remaining integration

- Complete native definition/automation persistence through the builtin-only adapter. It
  derives user context at the boundary and rejects userId/UID/HOME/credential
  overrides; a service callback must adopt saved user authority before binding.
- Bind native definition/run revisions atomically with plugin persistence or use
  an explicit fail-closed reservation/reconciliation protocol across databases.
- Apply owner/source checks to RPC, API, CLI, UI, events, logs, notifications,
  result/history reads and replay before returning data or accepting actions.
- Propagate the binding into child/worker creation and mandatory native dispatch,
  retries, resumes and tools. Recheck immediately before each actual operation.
- Complete isolated automation scripts and controlled workflow capabilities under
  saved authority. Pure workflow evaluation now uses the registered Unix identity;
  centrally installed trusted plugin code remains in the service.
- Preserve timezone/schedule/run state, concurrency and duplicate/retry semantics.
  Legacy unbound objects require explicit administrative assignment or disabling;
  their existing metadata must not become an administrative execution context.
- Verify actual scheduled/background worker execution, two-user denials,
  revocation, replay and restart through Docker before completing the stage.

The kernel's SQLite and Docker checks do not claim these integrations are done.

## Internal plugin facade

`bb.server.internal_DO_NOT_USE_backgroundJobs` is available only to the builtin
Workflows and Automations plugin IDs on a configured shared server; standalone
hosts return null. Non-builtin provenance and other IDs are rejected. Registration
captures the authenticated user, or the registered project owner for an explicit
administrative request. Inherited profile selection uses the origin thread's
saved version; it does not follow later profile publications. Background service
code must adopt a saved user scope before creating a child binding. Plugin service starts/restarts
and schedule callbacks explicitly clear the activating request principal.
Administrative registration/reenable is bounded to a live authenticated request;
escaped async callbacks lose that privilege even if their old principal object
remains in AsyncLocalStorage.

The facade delegates reads, lists and mutations to the same registry helpers as
core. The helpers have an explicit trusted administrative metadata mode; user
scope still requires owner/current-project predicates before pagination.
Administrative/service readers remain limited to that builtin's supported kinds.
Execution always rechecks the actual saved user's permissions. Cached facade
methods stop working when their owning plugin is unloaded. The audit entry and
Plugin Guide inventory document its internal status.

A binding ID alone does not authorize a native plugin object. Evaluation and
controlled worker operations use the validated saved authority. Native plugin handlers must
verify the object/binding association and current caller, and bind their own
durable records before exposing personal operations. Actual user-facing job
APIs, automation/definition ownership and tenant runtime isolation remain
required work.

## Native workflow owner integration

The actual builtin registry identifies the plugins as `workflows` and
`automations`. The internal adapter now imports those registry constants;
`bb--workflows` and `bb--automations` are rejected. Earlier fixture-only checks
used those incorrect IDs. Docker now enables and calls the actual builtin
Workflows plugin through the administrator CLI.

The next plugin-owned SQLite migration adds nullable `owner_user_id` and
`authority_binding_id`, plus owner/project/origin indexes. New managed runs
reserve a central binding using their preallocated native run ID, then insert
the native row with both references. Insertion failure retires the binding. A
crash before insertion leaves no executable native row; this is a cross-database
reservation protocol, not an atomic transaction or exactly-once guarantee.

User readers constrain the owner before SQL limits and verify the native
object/binding association and current project access before returning history.
Inspect, paginated history, latest/active reads, resume and stop share this
boundary. Trusted metadata readers retain legacy history. Resume requires an
assigned previous run with matching owner/project/environment; cancellation
retires the current execution binding without making it a mandatory ancestor of
a future resumed run. Replay profile/tool identity still needs integration
before tenant execution opens.

The origin selection comes from the internal pinned-profile reader, rather than
unrestricted thread defaults. Managed execution revalidates the saved binding
and evaluates pure workflows in the fixed registered-UID process. Agent calls now use controlled workers through the framed process bridge.
Nested workflow capability now runs a child VM inside that isolated process,
sharing the parent's agent scheduler and abort chain. Unassigned queued legacy workflows fail with an
administrative-migration error. Managed notifications do not use unrestricted
thread sends. Standalone execution remains covered by its existing full tests.
Scoped notifications, personal routes
and recovery/cleanup authorization still require implementation and Docker proof.

## Registered-UID evaluator

`evaluateWorkflow` launches only the root-installed, SHA-256-pinned artifact via
`helper.py launch-workflow`. The existing launcher validates the immutable user
manifest and project path, then uses the same UID/GID, cleared groups,
no-new-privileges, user/PID/mount namespace and descendant supervision as Qwen.
Workflow jobs receive no model backend credential and no Node options from the
caller. Normal cancellation uses the same per-job lease, including pre-launch
stop fencing and client-ancestor death cleanup.

The core adapter validates bounded input and protocol frames. The trusted runner
reports its actual UID/HOME/cwd before evaluation; the adapter matches all three
against saved authority. QuickJS exposes deterministic JSON computation, log and
phase. Node globals are not exposed. Agent calls are forwarded to the existing durable call controller through a
bounded JSON channel. Nested workflows do not fall back to the service process
or unrestricted SDK. The adapter rechecks current
execution grants at launch, each event/result, completion and every 500 ms while
running. Abort, deadline, protocol violation or revocation invoke the fixed stop
helper and await process close. Result/output/event limits bound the transport.

Native managed runs persist successful results and phases through their existing
SQLite paths. No browser token is needed by the evaluator. Recovery, controlled
workers, nested-workflow budgets/replay, notifications and personal surfaces
remain required work; successful pure computation does not complete that stage.
The independent build task produces the same portable artifact used in Docker.

## Workflow worker ancestry

Migration 0154 adds the nullable `control_plane_threads.job_binding_id` reference
and a unique index: one worker attempt can belong to one native thread, while
ordinary threads retain null. The reference deliberately survives physical removal
of a binding. Managed Workflows threads without a binding, or with a missing or
mismatched binding, cannot execute. Old records are not silently assigned rights.

A `workflow-worker` binding requires a workflow-run source, matching origin,
owner/project and a currently approved worker profile. The source workflow's
profile must also remain granted. Registration, thread insertion and mandatory
native dispatch verify this graph. Owned worker origins add their own binding
as a dependency, so launching another workflow from a worker cannot drop its
parent's constraints. Traversal rejects cycles/missing edges, permits convergent
dependencies and bounds the complete graph to 32 bindings.

The worker adapter reserves authority before canonical thread creation, preserves
the managed origin environment, and sets hidden child/lifecycle/provenance
metadata internally. The public thread request has no new authority override.
Creation failure retires the reserved binding. Metadata/send/stop methods check
the exact parent-to-thread relationship. Safe stop disables the worker attempt;
there is no unrestricted SDK fallback. A service-scoped monitor checks pending,
starting and active mapped workers every 500 ms and calls canonical stop when
current execution authority is lost. Server shutdown closes and awaits this
monitor before closing the database-facing application boundary.

Docker seeds mapped worker records beneath actual running native workflows, then
uses the real personal CLI, daemon and stock Qwen to run shell probes. Stopping
one native parent stops its mapped worker while preserving the other user's
active worker. Resume is rejected before admitting a new user message, and the
binding/source denial persists after restart. This proves the authority kernel,
not a completed `agent()` bridge: worker seeding uses a private fixture, and
successful `startWorker` through the native evaluator is now also verified by
the later full agent round-trip and prefix replay checks. Personal job surfaces, replay,
recovery, notifications and automations remain required work.

## Isolated agent process bridge

The same durable call/replay controller now serves standalone and managed runs.
Managed evaluation forwards normalized agent options over bounded JSON frames;
request IDs/order, total calls, concurrent calls and reply sizes are checked.
The server invokes the controller under saved user authority, and the controller
uses scoped worker start/status/send/stop/archive operations. Model selection
inherits the bound immutable profile by default. `agent()` may select an
approved immutable version through `profileVersionId`; current parent and
selected-profile authority are required even for replay. A conflicting explicit
model tuple is rejected. Arbitrary tool/MCP/environment options are not accepted by this channel.

A pending reservation subscribes to the per-call abort signal before native
creation. Abort disables its authority immediately, so provisioning or a late
host reply cannot admit execution after cancellation. Independently owned worker
records retain the parent run even when cancellation wins attachment. RPC close,
reply failure and deadlines abort pending callbacks and await their cleanup.
Completed workers are stopped, disabled and retired using core's single-thread
archive lifecycle, without an unrestricted SDK fallback. Scoped discovery of old
orphan workers and all controller recovery paths still require completion.

Immutable profile version is part of managed call identity; standalone cache
identity is unchanged. The existing successful unchanged-prefix replay algorithm
and structured-result validator are reused. Docker verifies two-user native
`agent()` → Qwen → result round trips, actual worker profiles/UIDs/HOMEs/cwd,
structured replies, no new thread for completed-prefix replay, and cancellation
through the VM/RPC/worker chain. A second replay after server restart uses durable
call results without creating a new worker. Worker archival and the reservation
cancellation race also have direct evidence. These checks do not finish all retry/recovery cases, notifications,
personal job APIs, automations or schedules.

## Nested evaluation in the registered UID

Managed `workflow()` supports inline source and the existing project-based
name/path conventions. The child is parsed and evaluated inside the same
registered-UID process; there is no central SDK/file reader or service-UID VM.
The parent's scheduler tracks agents across both VMs, so child creation cannot
reset the agent-call or concurrency budget. Depth remains one level. Separate
nested invocation and active-VM ceilings equal the run's agent-call and
concurrency limits, with queued child launches checking cancellation before I/O.
The existing bounded JSON/schema validator is shared by native and isolated
controllers, including input/output validation.

The Linux reader opens the actual cwd directory, then each path component
relative to its open descriptor through private `/proc/self/fd`. Every opened
component uses `O_NOFOLLOW`; directories require `O_DIRECTORY`. Lexical traversal
outside the project is rejected before opening. The final file must be regular;
`O_NONBLOCK` prevents a FIFO open from hanging. A bounded 512 KiB read rejects
oversized or invalid UTF-8 source without following symlinks. This confines child
source resolution, not all filesystem operations of the agent.
