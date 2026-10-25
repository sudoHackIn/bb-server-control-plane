# Isolated Node script launcher primitive

Phase 48 adds the private launcher, phase 49 its bounded TypeScript runner and
phase 50 the native managed Automations controller. Centrally managed scripts
use inline Node ESM, project cwd and a full-permission approved origin profile.
Phase 51 adds the limited personal definition/output API, SDK, CLI and editor.
Agent prompt requests retain their existing format.

## Installation and invocation

The operator can opt in when installing the existing privileged helper:

```sh
python3 -I /opt/bb-control-plane/launcher/install.py \
  --service-user node --users-root /srv/agent-users \
  --script-runtime node-esm
```

Supply the existing Qwen/workflow artifact flags as well when those runtimes are
used. The installer verifies the fixed Node executable path is root-owned and
not writable by users, then writes `scriptRuntime: "node-esm"` in its root-owned
policy. Omitting this option leaves script execution unavailable. The Docker
image explicitly enables it for the integration checks.

The trusted service calls the helper with registered user UUID, numeric UID,
a fresh job UUID and an existing project cwd beneath that user's projects root:

```sh
sudo -n -- /opt/bb-control-plane/launcher/helper.py \
  launch-script USER_UUID NUMERIC_UID JOB_UUID PROJECT_CWD < script.mjs
```

This is a private host primitive. It is not a client authentication mechanism or
a new `bb` CLI command. The service must resolve those identity/path values from
verified saved job authority. Tenant code cannot acquire the service account's
sudo permission by knowing these arguments.

Only the operator-configured Node executable and fixed `--input-type=module`
mode are accepted. The helper rejects interpreter arguments and launch-policy
overrides; it has no caller-supplied binary, shell, environment or script-file
path. JavaScript ESM source arrives through stdin after identity selection,
rather than through the supervisor's argv or a shared service script file.

## Process boundary

The new operation reuses the existing helper's immutable UUID/UID mapping,
no-follow directory traversal, numeric UID/GID, cleared supplementary groups,
no-new-privileges and per-job user/PID/mount namespace. HOME/cwd come from the
same protected registry paths as Qwen and workflow jobs. The primary Node heap
flag is 128 MiB; this is not a cgroup limit on all descendant processes.

The script receives only the launcher's base PATH/LANG/HOME/USER/LOGNAME/PWD and
job ID. Unlike the Qwen operation it does not forward OPENAI_API_KEY or
OPENAI_BASE_URL. It does not inherit BB/backend tokens, NODE_OPTIONS or a
service CLI credential. It runs JavaScript with filesystem/process access under
the user's Unix identity, not in the workflow language's QuickJS API.

Ordinary POSIX permissions isolate foreign private HOMEs and the service data
directory. Setting cwd is not a filesystem jail. Scripts can use their user's
other accessible files and system resources; network/cgroup isolation is not
provided by this increment.

## Lease and cancellation

The existing root-owned job lease records supervisor PID/start identity and
user UUID/UID. Stop-before-launch creates a fence, a second concurrent launch
of the same live job is refused, and a foreign identity cannot stop it. The
same helper `stop` operation waits for supervisor cleanup. A missing/dead
supervisor with a remaining lease is unconfirmed cleanup: stop refuses success
and retains that lease, including on repeated attempts. Relaunching over such a
lease is also refused. The supervisor kills
and reaps detached descendants and removes its matching lease. If its service
caller dies, ancestry monitoring also performs cleanup.

Use fresh job IDs. The controller must not infer durable job success from
process start or accept script-written stdout as owner identity. Script stdout,
stderr and exit status are raw transport at this layer. Input/output budgets, deadlines and current-grant rechecks belong in the outer
TypeScript runner described below. Persisted terminal status and restart policy
remain controller responsibilities, not implemented in this primitive.
A controller must not fabricate a Qwen/BB thread ID for a script process.

## Verification

The full Docker deployment runs `check-control-plane-script-jobs.mjs` through a
service-UID Node client and the actual sudo/helper/setpriv/unshare/Node chain.
Both registered users execute ESM source through stdin, import a module from
the owned project cwd and prove private /proc visibility along with UID/GID,
HOME/cwd, no-new-privileges, inability to raise UID, foreign HOME/service database
read denial and absence of injected service/model credentials. Node's
`process.getgroups()` includes the primary GID; the expected set is only that
user's GID, not an empty array.

Three long-running jobs include a detached Node command each: two share the
first user's identity and one belongs to the second user. Foreign stop is
rejected. Stopping one job reaps its actual command while the other two remain
alive. Killing the next service caller reaps its detached command and preserves
the second user's job. Finally all remaining jobs are stopped. Foreign cwd,
interpreter argument injection and launch after a pre-start stop fence reject.

The normal Qwen/workflow/automation/restart/crash scenarios remain enabled. The
new primitive does not change their provider policy, daemon protocol, database
schema or public SDK. Unsupported script configurations remain denied before spawn.

## Bounded TypeScript runner

`apps/server/src/control-plane/automation-script-runner.ts` is a private core
function, not a plugin RPC or tenant submission endpoint. Its caller supplies an
existing automation-run binding and a fresh job UUID to persist before execution.
The runner requires a current automation source binding and derives owner UID,
HOME and project cwd from the verified central registry. It rejects foreign
request principals, disabled/deleted lineage and wrong-purpose bindings before
spawn; no identity, interpreter, cwd, environment or launch-policy overrides are
accepted. Binding creation remains restricted to approved builtin hosts.

Source is nonempty UTF-8 text capped at 256 KiB. The deadline is 1–900000 ms.
Stdout and stderr are separate UTF-8 strings sharing a 1 MiB raw-byte budget;
excess output stops the job and retains only a bounded valid prefix. Invalid or
incomplete UTF-8 fails the job. Output is untrusted data, not a control protocol.
Exit code/signal are reported separately from cancellation, timeout, output-limit
and authority-revocation outcomes. Input travels through stdin; only fixed PATH
and LANG enter the service launcher process.

Authority is checked immediately before launch, every 250 ms while active and
again around completion/cleanup. Changes to saved execution identity are also
rejected. Cancellation and failures call the privileged stop with the original
saved identity/job tuple, even after access revocation. The runner awaits both
the stop acknowledgement and transport close. Even natural exit performs stop
to verify lease cleanup and fence that completed job UUID. A failed/timed-out stop or missing
transport close raises an unconfirmed-cleanup error rather than a terminal
success/cancel result; the caller must retain durable pending cleanup. Cleanup
has a 12-second command deadline and a further 5-second transport-close bound.

Docker integration exercises both owners through this actual core function and
sudo/helper chain: success, nonzero exit, separate streams, a combined output
limit, invalid UTF-8, cancellation, timeout and live source revocation. Detached
commands are checked from the container's outer process namespace after return.
Real-SQLite tests cover pre-spawn authorization and input rejection. The native controller now supplies durable process identity, crash handling and
pending cleanup retries as described below. Personal script definition/output contracts are described below.

## Native managed Automations controller

Builtin Automations uses `runAutomationScript` and `stopAutomationScript` on the
internal background authority facade. These members are unavailable to other
plugins and route through the core runner, never the standalone script runner.
The core runner also requires the bound profile's `full` permission mode; an
accept-edits/approval profile does not authorize arbitrary Node workspace code.
Native create/update reject shell/Python interpreters, scriptFile, custom cwd,
environment overrides, missing Node selection and oversized UTF-8 source.
The existing native Automations RPC, SDK plugin RPC and CLI can create and manage
this supported subset. No public process/command endpoint is added.

Before dispatch the native run stores its approved definition revision and
central automation-run binding. `automation_script_attempts` stores that same
binding UUID as job UUID before process launch. No fake Qwen/thread ID is used.
Completion stores separate stdout/stderr, exit outcome and byte/truncation
metadata in result JSON and the native run output, atomically with terminal
state. Active source edits apply to subsequent runs, not the saved current body.

Individual cancellation persists intent before cleanup and leaves the source
schedule/failure budget intact. Pause/delete fence source admission and stop
script attempts before reporting success; delete waits for cleanup before
removing persistence. Failed cleanup retains a running native run and error
metadata. Subsequent sweeps and controller restarts retry cleanup under saved
ownership even after execution grants disappear. The service loop closes admission, persists cancellation for active scripts and
awaits attachment/cleanup tasks in its finally path. The host still bounds how
long disable/reload waits, but retains storage, SDK cleanup access and artifact
roots while an aborted service is pending. A replacement cannot activate until
service cleanup, admitted RPC invocations, dispose hooks and storage close finish. This is separate from
forced operating-system process termination and the broader shutdown audit.

A restarted controller never relaunches a script attempt whose execution might
already have had side effects. It first stops/fences the saved job UUID, then
settles cancellation or an interrupted failure. This is not resumable JavaScript
memory or exactly-once side effects. A new explicit manual run gets a new UUID.
Current once/cron scheduling, single-flight claims and idempotency use the same
native persistence as agent Automations. Personal metadata/history report executionMode/runMode without source/output.
The personal definition endpoint/editor supports a bounded script descriptor,
and per-run output is fetched separately under current owner/project access.

## Personal script contract

Create uses `{originThreadId,name,script:{source,timeoutMs},trigger,enabled}`.
Existing agent creation uses `prompt` instead. Update uses `expectedRevision`
and changed name/trigger or a complete script descriptor; prompt/script are
mutually exclusive. Mode changes require a new automation. Input is strict;
no identity, path, interpreter, provider/model/tools/MCP or environment overrides
are accepted. The saved origin must grant full-permission execution.

Definition returns a discriminated `executionMode` with `prompt` or `script`.
GET `/control-plane/user/automations/:id/runs/:runId/output` and SDK
`automations.output(id,runId,signal)` return a script result capsule: native status,
nullable completed result, cleanupPending and bounded error. Stdout/stderr share
the 1 MiB raw-byte limit. The server verifies native run/automation identity,
exact central job/source binding and current project access again after RPC.
Malformed/substituted native results fail as upstream contract errors. Result
reads never perform a filesystem read using a caller path.

The personal editor selects agent or Node script, retains drafts across CAS
conflicts, reloads saved source/timeout and shares existing schedule/run/stop/
delete controls. Output is loaded only on demand and rendered as escaped text;
access errors hide cached output. Terminal output is a bounded snapshot, not a
live stdout stream. `bb server access automations` provides script/stdio input,
timeout and output commands; see the machines guide for exact flags.

## Quiescence and pending plugin disposal

Automations closes local create/update/resume/manual/scheduled admission as soon
as its service signal aborts. It rechecks after async binding and re-enable,
rolls back an interrupted re-enable and waits for pending attachment before final
shutdown. A worker born after cancellation is attached to durable cancellation
state and stopped. Script cancellation intent is written before abort so even a
pre-launch cancellation does not consume the failure budget.

The core private background facade also rejects new bind/enable/start/send,
workflow evaluation and script execution while the host is quiescing or that
plugin is disposing. Metadata/current-owner rechecks, disable/remove and stop/
release/archive remain live for trusted cleanup. This gate is host-owned and
not an optional plugin policy. It does not yet fence every full SDK/HTTP thread
or queue entry point.

If an aborted service exceeds the existing host stop timeout, fresh RPC lookup
and replacement activation stay unavailable. Storage and SDK cleanup liveness
are retained until its promise and dispose hooks finish, then storage closes and
cached API handles become stale. A hung trusted service can remain degraded and
retain resources indefinitely; this change does not invent a terminal cleanup
acknowledgement. Process death still uses the persisted job/lease recovery path.
