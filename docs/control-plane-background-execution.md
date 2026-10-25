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
Nested workflows use the isolated evaluator and scoped worker bridge; automation
integration remains pending.

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
archive lifecycle, without an unrestricted SDK fallback. Scoped discovery now recovers mapped workers and persists their parent binding
independently of run retention. Additional controller recovery paths still
require completion.

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

## Worker discovery and interrupted execution

Builtin Workflows reconciles registered workers through a source-filtered core
query, with no global thread SDK fallback. Central worker/parent bindings and
native ownership establish identity; plugin metadata supplies optional call
correlation only. Cursor pages contain at most 100 rows. Current user project
access is applied in SQL before pagination. Startup includes archived threads
so a crash between native archive and plugin acknowledgement can be repaired;
periodic discovery lists only unarchived threads.

The plugin's real SQLite migration adds `workflow_workers.parent_binding_id`,
backfilled from retained runs. New ownership records save it before attachment;
discovery fills absent references without replacing an existing nonnull parent.
This reference survives run-history deletion and authorizes scoped cleanup.
Native deletion is handled idempotently, while an existing foreign worker still
fails relation checks. Cleanup retries keep their existing bounded backoff.

Docker verifies actual automatic recovery after graceful server restart: a
successful prefix is reused, the interrupted attempt remains disabled/stopped,
and a new attempt completes the pending step under saved user authority. A
private fixture seeds registered workers with missing run history while BB is
offline; startup discovers and archives them, including one already archived
before its cleanup acknowledgement. Earlier ancestry fixtures now include actual
call correlation, so periodic orphan cleanup can distinguish active calls.
Interrupted side effects may execute again; these checks do not establish
exactly-once behavior, all provider retries, notifications
or personal background APIs.

## Abrupt server termination

A separate Docker scenario kills BB with `SIGKILL` while two owner workflows are
waiting on actual Qwen shell tools. Process identities for both workflow
interpreters are included in the existing PID/start-time death checks, alongside
the daemon, supervisors and Qwen descendants. BB restarts only after those old
processes are dead. One owner's profile is revoked offline through the existing
access primitive: that run cannot create a replacement attempt. The other run
reuses its saved successful prefix and completes through a new owned worker.
Both old attempts are disabled and archived. This verifies that crash recovery
uses current authority rather than a browser credential or a cached grant.
The fixture restores the revoked grant after assertion. Interrupted side effects
may be repeated; remaining provider-retry and notification cases are separate.

## Provider failure and structured-result recovery

The scoped worker reader includes the latest bounded failure and an idle
completion sequence. It compares system-error and turn-completion sequences so
an earlier turn cannot hide a fresh authorization/provisioning failure. A failed
or interrupted completion also remains a failure if native status has become
idle. Managed controllers consume completions monotonically once, rather than
settling from generic global idle/failed events. This prevents polling an old
idle snapshot from spending multiple corrective turns.

The existing durable retry counter and bounded backoff now receive authoritative
provider errors. Authorization/permanent-status and configuration failures take
precedence over retryable wording or object flags. Qualifying transient failures
retire the old attempt and create a new worker through normal current-grant
checks. Structured fallback validation reuses the same worker for at most two
corrective turns; exhaustion does not become a provider retry.

Docker injects an OpenAI-compatible SSE error after a stream opens, observes a
successful replacement worker, rejects a mixed authentication/unavailable error
without retry, repairs a structured answer in the same worker and verifies
bounded correction exhaustion. The tested stock Qwen internally keeps retrying
some headless HTTP 503 responses; that behavior is separate from the external
controller. Corporate-fork behavior and the remaining retry/revocation matrix
still require verification.

## Backoff cancellation and final write admission

Docker now waits for the second external retry's four-second backoff before
cancelling the workflow or revoking its profile through the administrative CLI.
Both runs settle without another worker; restoring the profile and waiting past
the original retry deadline does not revive the failed run. Continuous stream
failures exhaust three worker attempts, and every retired attempt is disabled
and archived through the scoped adapter.

Native message appending rechecks current managed authority in the same SQLite
transaction, after preflight and before events/outbound effects. New waiting and
explicit queued-message rows have the same creation-time check. These core paths
are used by workflow corrections as well as ordinary sends. Real-database tests
verify denial after an earlier admission, including atomic rollback of a
preflight revocation. The existing native correction pipeline remains exercised
in Docker; the precise commit-time race is verified at the core boundary rather
than by relying on wall-clock ordering of model responses.

## Scoped workflow origin notifications

Managed Workflows now notify the saved origin through a narrow builtin adapter,
instead of abandoning every notice or using the unrestricted SDK. The core
checks current run/source authority and the origin's own immutable profile,
uses the registered owner and submits an agent-only native message with
`steer-if-active`. Ordinary UI/CLI/SDK messages use the same implementation.
The caller cannot substitute a thread, UID, HOME or execution profile.

Migration 0155 adds one durable acceptance receipt per central run binding. The
receipt and native client request commit together; a failed append rolls both
back. A repeated attempt after a lost plugin acknowledgement observes that
receipt and does not append another request. Receipts survive run-history
pruning and service restart. They record BB acceptance, not successful provider
execution. Native replay may repeat external side effects; no exactly-once
execution guarantee is added.

Missing/deleted/disabled bindings, revoked user/project/profile/source grants and
unavailable origins abandon the notice. Transient preparation failures use the
existing persisted notification backoff, including after service restart.
Notifications are not sent through an unrestricted fallback. In particular,
cancelled runs with disabled bindings cannot inject an additional origin turn.

The real-SQLite contract tests exercise receipt/event rollback, duplicate
acknowledgements, foreign callers, substituted origins and revoked/disabled
execution. Plugin tests exercise accepted/denied/unavailable outcomes and
transient failure followed by restart without unrestricted thread lookups or
sends. Docker verifies two owners and an offline injection of the lost-plugin-
acknowledgement window; it does not claim to kill the server at a precisely timed
instruction between the two database writes.

Live notification delivery also exposed a bridge-retirement race. A bridge with
no attached session can still be initializing or constructing a worker. The
native runtime now reserves its process key through start/resume/staged-rewind
construction; stale-hash cleanup skips initializing/reserved processes and
retries cleanup when the last reservation releases. Real-process regression
checks cover both the handshake and the ready-but-not-attached interval. Explicit
shutdown remains available; this does not serialize user threads or expand
execution permissions.

## Personal workflow run API

Personal clients can start, list, get, inspect result/history and stop native
workflow runs through `/control-plane/user/workflows`, the limited SDK and
`bb server access workflows`. Core resolves the origin's current owner/project
and execution grants. The builtin plugin reuses its existing SQLite persistence,
start/replay/stop controller and evaluator. Policy and caller authentication
remain in the control plane. A fixed-method RPC adapter verifies installed
builtin provenance and preserves the user principal; generic plugin RPC remains
closed to personal credentials.

List pagination selects central owner/project bindings before LIMIT, then reads
only those native IDs. Shared project access does not expose someone else's
personal run. Missing/pruned native rows can produce an empty page with a
continuation cursor. Reads recheck the current project grant; cancellation is
still available after execution-profile loss and disables run authority. Start
requires current execution grants, derives execution context from an owned
origin and lets the existing native replay checks validate a terminal prior run.
No browser token is persisted as job authority.

Inline source and bounded JSON arguments are the initial authoring interface.
CLI `--file` reads locally. Definitions, dedicated job progress subscriptions,
workflow UI, automation/schedule operations and the remaining pending-execution/
recovery audit are not completed by this increment.

## HTTP input boundaries for personal execution

The personal thread middleware and administrative profile guards now use the
verified root-and-nested Hono wildcard. Bounded JSON/form readers preserve
transport size failures instead of turning them into malformed-JSON errors.
Workflow bodies retain their 4 MiB envelope and tighter source/argument bounds.
Cancelling a thread/run or signing out accepts no action parameters beyond an
optional empty object, so a caller cannot accidentally send ignored overrides.

HTTP 413 responses explicitly close the connection and contain a structured
error. Docker retains a normal keep-alive client, submits Content-Length and
chunked oversized requests across the control-plane body consumers, and then
performs valid authenticated requests. It checks unchanged profiles, grants,
projects, threads, job bindings and sessions; an oversized exchange leaves its
approved certificate flow unconsumed. Normal JSON/form login and certificate
approval still work, and a valid exchange can subsequently consume that flow.
The execution, retry, recovery and UI work listed above remains required.

## Personal workflow run workspace

The personal web workspace now calls the existing limited Workflow SDK for
project-scoped lists, status/results/agent-call history, inline start, terminal
replay and cancellation. The main-content view keeps native project/thread
navigation. Current conversation authority controls execution; read-only project
views have no start/replay form. Active polling is two seconds, and read failures
hide cached run details. Drafts/selection reset on project/conversation/view
changes and are not persisted. This UI adds no plugin RPC bypass or separate
workflow store. Definitions, automations/schedules and the remaining audit above
remain required. See `control-plane-phase-40-verification.json` for this increment.
