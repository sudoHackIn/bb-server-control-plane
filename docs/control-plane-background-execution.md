# Shared-server background execution

This is a source inventory and integration plan for the required personal
workflow/automation/schedule stage. The authority-binding foundation is implemented;
existing workflow and automation execution is not yet integrated with it. The
acceptance checklist in `server-control-plane.md` remains authoritative.

## Existing persistence and execution

| Area                         | Source                                                                                                                                | Current boundary and required integration                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow entry points        | `plugins/workflows/src/server.ts`, `cli.ts`, `ui-contract.ts`, `workflow-input.ts`                                                    | Agent tool, CLI and UI RPC accept origin/run identifiers. Source loading can read workspace workflow files. Bind verified owner/project authority before loading tenant source or exposing a run. Origin metadata is not authentication.                                                                                                                   |
| Workflow durability          | `plugins/workflows/src/data.ts`, `service.ts`                                                                                         | Existing runs, calls, workers, replay, retries, recovery and notifications remain the durable workflow store. Do not duplicate that history in the central registry. Add authoritative binding references and owner-filtered readers.                                                                                                                      |
| Workflow execution           | `plugins/workflows/src/runtime.ts`, `service.ts`                                                                                      | QuickJS WASM currently executes in the service; worker threads use `bb.sdk.threads.spawn` with the origin environment and selected provider/model/reasoning/mode. Tenant script evaluation needs a separate registered-UID process; worker creation needs the saved binding and approved profile. A VM alone does not meet the Unix isolation requirement. |
| Automation definitions/runs  | `plugins/automations/src/data.ts`, `service.ts`, `rpc.ts`, `cli.ts`                                                                   | Plugin-owned SQLite stores definitions, triggers, runs and output, with project/creator metadata. Add ownership through binding references at create/edit/read/run boundaries. Shared project membership must not reveal another user's personal automation.                                                                                               |
| Automation dispatch/recovery | `plugins/automations/src/run.ts`, `sweep.ts`, `server.ts`                                                                             | New-thread dispatch, target-thread sends, script execution, due sweeps and reconciliation must use saved user authority. Restart and callback execution cannot inherit service privileges.                                                                                                                                                                 |
| Automation workspace scripts | `plugins/automations/src/script-runner.ts`, `script-files.ts`, `working-directory.ts`                                                 | Current direct `spawn` has cwd/env but no registered UID/GID. Route tenant scripts through the restricted launcher; resolve cwd/HOME from registry/project authority. Do not expose the service CLI credential or database.                                                                                                                                |
| Platform plugin schedules    | `packages/db/src/data/plugin-schedules.ts`, `apps/server/src/services/plugins/plugin-service.ts`                                      | `plugin_schedules` identifies centrally registered callbacks by pluginId/name. This is a trusted plugin timer, not a personal job owner. Preserve its atomic claim; personal due objects still require their own authority and lifecycle.                                                                                                                  |
| Native queued/delayed sends  | `packages/db/src/data/queued-thread-messages.ts`, `apps/server/src/services/threads/queued-messages.ts`, `queued-message-dispatch.ts` | Messages persist thread identity, schedule/claim/retry state and origin metadata. Authorize actual execution through the owned thread and job ancestry when supplied. A sender/origin ID alone grants no rights.                                                                                                                                           |
| Periodic retries/restart     | `apps/server/src/services/system/periodic-sweeps.ts`                                                                                  | Separate idle queue delivery, due scheduled delivery, failed retry, orphaned wait cleanup and plugin schedule sweeps exist. Audit actual dispatch and recovery, not just the initial HTTP request.                                                                                                                                                         |

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
cycles and chains longer than 32 bindings fail closed. Origin references retain
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
wraps these same operations; actual native workflow/automation persistence and
execution integration is still pending.

## Remaining integration

- Connect native plugin persistence to the verified builtin-only adapter. It
  derives user context at the boundary and rejects userId/UID/HOME/credential
  overrides; a service callback must adopt saved user authority before binding.
- Bind native definition/run revisions atomically with plugin persistence or use
  an explicit fail-closed reservation/reconciliation protocol across databases.
- Apply owner/source checks to RPC, API, CLI, UI, events, logs, notifications,
  result/history reads and replay before returning data or accepting actions.
- Propagate the binding into child/worker creation and mandatory native dispatch,
  retries, resumes and tools. Recheck immediately before each actual operation.
- Isolate tenant workflow evaluation and automation scripts under their registered
  Unix identity; keep centrally installed trusted plugin code in the service.
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

This facade does not evaluate source, create workers or authorize a native plugin
object merely because a binding ID was supplied. Native plugin handlers must
verify the object/binding association and current caller, and bind their own
durable records before exposing personal operations. Actual user-facing job
APIs, ownership-aware plugin persistence and tenant runtime isolation remain
required work.
