# Isolated Node script launcher primitive

Phase 48 adds a private launcher operation, not personal script automation
support. Native managed Automations still rejects script definitions. The next
stage must add the server-side bounded runner and durable controller lifecycle
before any tenant API, SDK, CLI or UI can submit script jobs.

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
same helper `stop` operation waits for supervisor cleanup. The supervisor kills
and reaps detached descendants and removes its matching lease. If its service
caller dies, ancestry monitoring also performs cleanup.

Use fresh job IDs. The controller must not infer durable job success from
process start or accept script-written stdout as owner identity. Script stdout,
stderr and exit status are raw transport at this layer. Input/output budgets,
deadlines, current-grant rechecks, persisted terminal status and restart policy
belong in the outer server/controller adapter and remain unimplemented here.
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
