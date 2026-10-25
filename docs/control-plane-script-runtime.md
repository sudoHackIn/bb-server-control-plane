# Isolated Node script launcher primitive

Phase 48 adds the private launcher and phase 49 adds its bounded TypeScript
runner. Native managed Automations still rejects script definitions. Durable
controller lifecycle and explicit personal API/SDK/CLI/UI contracts remain
required before tenants can submit script jobs.

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
schema or public SDK. Native script definitions remain denied until their
managed runner/controller integration is complete.

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
Real-SQLite tests cover pre-spawn authorization and input rejection. Persisting
script process identity, controller crash recovery, pending cleanup retries and
the public script definition/history contract are subsequent work. This runner
alone does not make managed script Automations available.
