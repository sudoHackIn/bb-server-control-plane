# Managed workspace execution

Increment 59 moves native daemon workspace operations for a registered project
from the common service identity to its saved numeric UID, HOME and cwd. Qwen,
workflow evaluators and automation scripts have separate existing launch paths;
isolating those processes alone did not isolate daemon-side Git.

## Authority and routing

The private context socket accepts `POST /workspace/resolve` with exactly
`{ "cwd": "/absolute/registered/project" }`. The server derives the project,
user UUID and numeric UID from SQLite. A caller cannot provide an identity,
executable or environment. The registered environment must be ready, the project
and user enabled, and the owner must retain an execution grant. The existing
project lookup also checks source and host bindings.

Only an exact canonical registered project root resolves to managed execution.
Unknown paths beneath any registered HOME or projects root are denied, including
unregistered subdirectories. Revoked or deleted managed projects never fall back
to service-account execution. Paths outside these registered namespaces retain
ordinary operator behavior. This is an internal service boundary, not a new
public user endpoint.

`RuntimeManager` receives a workspace provisioner that delegates all
`HostWorkspace` methods to the fixed worker: inspection, branch/default branch,
HEAD, local/shared snapshots, additional write roots, status, diff, file patches
and commit. `project.inspect`, `host.inspect_git_source`,
`host.list_branch_options` and `host.read_workspace_agent_context` use that same
worker for registered roots. Existing result schemas validate the replies.

A cold managed project creates native manual environment metadata at the exact
registered cwd. Native attachment then performs inspection under the registered
UID. It bypasses the central project-checkout callback, whose Git would otherwise
run in the service process. Existing operator environments retain their provider
placement behavior. Generic service-account setup/teardown refuses both the
registered HOME and its sibling projects root.

## Worker and process lifetime

Each operation launches the root-owned, SHA-256-pinned Node artifact through the
fixed privileged helper. The helper derives HOME and checks the UUID/UID/cwd
binding; no system passwd user or broad sudo command is required. The existing
PID/user/mount namespace supervisor waits for and reaps descendants. Workspace
workers receive a clean environment without service or model credentials. Git
configuration and hooks run under the same user identity as the workspace.

Operations serialize per cwd, including separate proxy instances, and share the
daemon's existing VCS admission budget (up to six workers). Each worker retains
HostWorkspace's own Git scheduling; this is not a host-wide six-Git-process cap.
Authority is checked before queued
execution, every 250 ms while running, and before returning a result. Authority
HTTP requests have an absolute two-second deadline. The operation deadline is
30 seconds after admission. Cancellation, revocation, output overflow and timeout
request acknowledged helper cleanup. An unconfirmed cleanup blocks further local
operations for that cwd; the root-owned lease also prevents another workspace
operation on that cwd until cleanup is confirmed.

IPC accepts at most 128 KiB of UTF-8 input and 16 MiB of combined stdout/stderr.
Input is validated and serialized before spawning; streamed byte chunks are
concatenated before UTF-8 decoding. The worker uses a 128 MiB old-space limit.
These bounds are not a total host memory quota or a network boundary. Existing
native commit behavior, including its `noVerify` option, is preserved.

Git operations are not transactions with permission revocation. A completed
filesystem change is not rolled back when the final authority check refuses its
result. Polling limits detection delay; it does not promise exactly-once effects
or instantaneous revocation. The deployment test holds a commit hook before its
commit point to demonstrate active cancellation and unchanged HEAD.

## Installation and compatibility

Build through the normal dependency graph:

```sh
pnpm exec turbo run build --filter=@bb/host-daemon
```

Install `apps/host-daemon/dist/workspace-worker.mjs` at the immutable root-owned
`/opt/bb-control-plane/workspace-worker.mjs`. Add
`--workspace-worker /opt/bb-control-plane/workspace-worker.mjs` to the existing
root launcher installation command, alongside its Qwen/workflow/script options.
The installer records the artifact path and SHA-256 in its root-owned policy;
updating the artifact requires rerunning installation. The checked-in Dockerfile
and image builder perform these steps. Server and daemon must be upgraded
together: host protocol 254 includes this private execution contract and does
not accept protocol 253 as compatible. Plugin SDK remains 0.6.80; no public SDK
member, CLI command or database migration is added.

## Evidence and remaining boundaries

Real migrated-SQLite tests cover exact roots, two owners, current grants,
disabled/deleted subjects, strict private socket requests and identity injection.
Daemon tests cover refused/unavailable authority and a real Git commit with a
large Cyrillic message split across IPC byte boundaries. Contract tests reject
unsupported commands and identity/executable injection.

The Docker lab performs native status/diff/commit for two registered UIDs. A
real `prepare-commit-msg` hook records UID/GID/HOME/cwd and verifies denial of
another user's HOME/project and the service database. A detached descendant must
first write a heartbeat, then stop after operation cleanup. Revocation during a
held commit prevents that commit, Bob remains available, and regrant permits a
subsequent commit. Native Git identity and HEAD survive restart. See
[the verification record](control-plane-phase-59-verification.json).

This covers the registered native workspace path, not arbitrary centrally
installed plugin code, every custom provider callback or legacy provider-owned
workspace recovery. Those remain part of the machine/action audit. The daemon,
root helper and centrally installed plugins remain trusted for their assigned
runtimes. The deployment uses stock Qwen with a deterministic local model backend;
it does not verify the corporate certificate SDK. Composite background, project
MCP, reusable agent and wider UI acceptance requirements remain open.
