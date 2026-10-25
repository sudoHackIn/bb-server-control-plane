---
kind: instruction
title: bb Guide — Machines
summary: Command reference for listing and targeting execution machines.
intent: Explain execution-machine discovery and selection from the CLI.
editingNotes: Keep the user-facing noun machine; internal APIs and types use Host.
---

Machine commands

A host is an identity and daemon connection. A machine is a host with a
provider-owned lifecycle. The local host has no machine provider. Every other
host is a machine, including existing machines enrolled with the built-in
`manual` provider (Manual machine setup). Add machines under Settings → Machines
or from the composer machine picker.

One machine runs the bb server. It stores threads, the database, and settings,
and every other machine and app connects to it. Settings → Machines badges it
`server` once there are several persistent machines, and `bb machine list` shows
`server` in its Role column. Keep the server machine on: while it is asleep or
off, nothing can reach bb and running threads may stop. The server machine
cannot be removed.

The server listens on loopback by default. Remote execution machines need
a server access provider: paired bb Connect, or a configured direct URL reachable
from the target, such as a private Tailscale Serve URL. A configured URL alone
does not prove reachability.

  bb machine list                         List persistent machines with role, ID, type,
                                          connection status, and relative last-seen time
    --all                                 Include disposable provider sandboxes
    --json                                Print the raw host list
  bb machine providers                    List installed machine providers
    --json                                Include inputs schemas and policy
  bb machine create --provider <id>       Create a standalone machine
    --key <idempotency-key>               Reuse this creation on retries
    --inputs <JSON>                       Non-secret provider inputs
    --no-wait                             Return the creating host ID immediately
    --json                                Print the created machine as JSON
  bb machine enroll --bootstrap-file <path>
    --bootstrap-env <NAME>                Alternative private bundle source
  bb machine show <id-or-name>            Show machine details
  bb machine rename <id-or-name> <name>   Rename a machine
  bb machine retry-update <id-or-name>    Retry a pending daemon update now
  bb machine reconcile <id-or-name>       Reconcile compute with core’s recorded state
  bb machine suspend <id-or-name>         Suspend a provider-managed machine
  bb machine resume <id-or-name>          Resume a machine (already active is a no-op)
  bb machine retry-cleanup <id-or-name>   Retry failed teardown now
  bb machine remove <id-or-name> [--yes]  Revoke and remove a machine
    --force                               Finish removing a disconnected machine whose
                                          environment cleanup failed; the provider's
                                          removal still runs
  bb machine provider-cli status <machine>
  bb machine provider-cli install <machine> <provider-id>
    --action <install|update>

`bb machine show` includes `threadStorageRootPath` from the latest daemon
session without waking the machine (null before the first session).
`bb machine list --json` includes lifecycle phase, progress, and any suspension
or resume error.

Each machine has a permission limit: the highest permission mode any thread on
that machine can run with. The default is Full Access. A thread that asks for
more resolves down to the limit, and a provider that supports no mode under the
limit cannot run there. Set it in Settings → Machines → the machine → Permission
limit. There is no CLI or SDK command to set it, and a paired machine cannot set
it for any machine, so a sandbox machine can stay at Full Access while your
laptop stays lower. `bb machine list --json` and `bb machine show` report the
current limit.

Standalone create does not create a thread or workspace. Omit inputs to use the
provider defaults; supply JSON when its schema requires additional values. Omit
`--key` to let the server generate one, or supply a stable key for retries.
Creation is durable: `--no-wait` returns the creating host ID immediately;
otherwise the CLI polls that host until active. SIGINT stops following and
exits 130 while creation continues. `bb machine list` includes machines still
being created. Use `bb machine show <host-id>` to inspect progress and
`bb machine remove <host-id>` to cancel and clean up. The SDK provides
`hosts.experimental_create`; pass `wait: false` to receive the creating host and
poll it with `hosts.get`. Aborting a caller signal never cancels the server
operation. A connected daemon does not yet imply an agent-ready checkout and
authenticated provider: thread startup does not install or update agent CLIs or
probe authentication, so use `bb machine provider-cli` for that.

Suspend and resume are available only when the machine provider implements
both operations. Suspending interrupts active turns and closes terminals before
saving; interrupted turns are never reported successful, so submit a new turn
after restore. `bb machine suspend` polls until the machine is paused, and
`bb machine resume` waits for the provider restore; resume does not rerun
environment setup. `bb machine reconcile` / `hosts.experimental_reconcile` is an
explicit request, not a timer: for a machine core records as suspended, it runs
the provider's save-and-stop operation, and the CLI polls until completion.
Active machines and lifecycle operations already in progress are left alone.
Retry cleanup is accepted only for a retiring machine whose provider teardown
failed. `bb machine remove --force` / `hosts.delete({ hostId, force: true })`
finishes removing a persistent machine that is disconnected and whose
environment cleanup failed, for example because the computer no longer exists:
it marks the machine's environments destroyed without running their teardown on
the machine (files stay on its disk), then runs the provider's removal and
revokes the machine. It is refused (409) while the machine is connected,
before teardown has failed, or when no environment cleanup is blocking removal;
use retry cleanup then.

Machines installed from Settings run as launchd or systemd services with
`--auto-update`: when the server is upgraded, each daemon updates its private
bb install to match and restarts. A daemon never downgrades. Use Settings →
Machines or `bb machine retry-update` to retry a failed update now. To opt out,
remove `--auto-update` from the launchd plist or systemd user unit and reload
that service; foreground `bb-app host-daemon` runs leave it off unless you pass
`--auto-update`.

Application logs rotate in `logs/server.N.log` and `logs/host-daemon.N.log`
under the selected data directory. Startup errors, crashes, and other output
that bypasses the logger are appended to `logs/server-stdio.log` and
`logs/host-daemon-stdio.log`; a file over 10 MB is renamed to `-stdio.1.log`
when its service starts. Follow them with `tail -F`.

Updates commands

One consolidated view of bb and provider CLI updates across machines — the
CLI counterpart of Settings → Updates.

  bb updates [status]                     Show bb-app and provider CLI update status for
                                          every persistent machine
    --machine <id-or-name>                Limit to one machine (including a sandbox)
    --json                                Print the aggregate as JSON
  bb updates apply                        Run every available provider CLI install/update,
                                          one at a time
    --machine <id-or-name>                Limit to one machine
    --json                                Print per-target results as JSON
  bb updates app [status]                 Show whether bb can update itself, the available
                                          version, and the last result
    --json                                Print the status as JSON
  bb updates app apply                    Download the update and restart bb into it
    --yes                                 Interrupt running threads without asking
    --no-wait                             Return once the update starts
    --json                                Print the final status as JSON
  bb updates app dismiss                  Mark the last update result as seen

`bb updates app apply` also updates a server hosted by the desktop app, restarting
that hosting app through its native updater. It never updates the desktop you
are viewing from unless that desktop hosts this server.

`bb updates apply` covers provider CLIs only. `bb updates app apply` updates
bb itself when it was started from `npx bb-app` (or a global `bb-app`) without
`--no-in-app-updates`: it installs the new version next to the running one and
restarts into it. It does not roll back if the new version fails to start.
Desktop users update through the desktop app's relaunch, and `bb-server` cannot
update itself. Connected daemons follow the server version automatically.

Targeting machines

For source installs, `bb updates` shows the checkout commit and explains manual
Git updates when no update shim is running. It does not compare that checkout
with npm releases. Failed or unavailable release checks show “Latest unknown”;
“Up to date” requires a successful check.

Machine selectors accept either an exact machine ID or an unambiguous machine
name. `--host` is an alias for `--machine`.

  bb thread spawn --project <id> --machine <id-or-name> --prompt "..."
  bb thread spawn --project <id> --new-machine <provider-id> --prompt "..."
    --machine-inputs <json>
  bb project create --name "..." --root <path> --machine <id-or-name>
  bb project source add <projectId> --machine <id-or-name> --path <path>

For thread spawning, machine targeting works with an unmanaged workspace path,
a new managed worktree, or the personal workspace. Do not combine it with an
existing environment ID: the reused environment already selects its machine.
`--new-machine` creates through a machine provider and always needs an explicit
`--environment-provider <id>`; machine providers do not choose an environment.
Use `--environment-inputs <json>` for workspace configuration, separately from
`--machine-inputs <json>`. Machine inputs are persisted and readable by
plugins; never put secrets there. Store credentials in plugin settings and pass
only non-secret configuration or references.

An environment provider that composes its own machine, such as
`modal-sandbox`, chooses that machine:
`bb thread spawn --project <id> --environment-provider modal-sandbox --prompt "..."`
creates the machine, prepares the project checkout, and runs environment setup.
Machine selectors are refused, and `--machine-inputs <json>` configures the
machine (for example `{"preset":"Large","image":"Node 22"}`). Progress and
failures appear in the thread's provisioning details; if cloning fails, the
machine remains available for retry or explicit removal.

When `--new-machine` or a composed provider needs a project checkout, core
clones the project's Git remote and registers a source on the new machine
before creating the environment. Existing sources are reused, and a completed
checkout whose remote matches is registered instead of cloned again; a
conflicting target is refused. bb owns a checkout it cloned (here or with
`project source add --clone`), so environments in it run `.bb-env-setup.sh`
and `.bb-env-teardown.sh`. The project needs a Git remote and the machine needs
Git access to it. Choosing Personal workspace does not clone a project.
Standalone `bb machine create` does not set up a project source and remains
available until explicitly removed. Machines created for threads retire after
their last live thread is archived when the provider declares them ephemeral.

For project creation and sources, `--root`/`--path` refers to a path on the
selected connected machine. Omit the selector to keep the existing local CLI
machine fallback (normally the server machine). Pass `--clone` to source add
instead of `--path` to clone the project's Git remote there; `--remote-url` and
`--target-path` optionally override the clone inputs.

## Server access

For a shared fork with certificate users enabled, run
`bb server access authorize [--client-name <name>]`, open the printed URL in
your browser and approve with your client certificate. The CLI waits for
approval and saves a private 24-hour user token without printing it. `status`
and `logout` work for user sessions as well. User sessions survive a server
restart until expiry or revocation; their available operations depend on the
server's user API and permissions. A user token cannot access the full BB API.
All `server access` leaf commands accept `--json`. Catalog/project/environment
commands already print JSON by default; login/status/logout select structured
output with that flag. `authorize --json` streams one JSON line for `pending`
(with the browser URL) and one for `authorized`. Tokens and PKCE verifiers are
never printed.

`bb server access environment` inspects your allocated UID/HOME and directory
state. Add `--provision` to create or verify your registered HOME and project
directories. The server selects their identity and paths; this command creates
no BB conversation or project object.

After your environment is provisioned and the local server host is registered,
use `bb server access projects create <slug> --name <name>` to create a project
in your allocated workspace. `projects list [--limit <count>] [--cursor <id>]`
and `projects get <project-id>` expose your current project grants. List limits
are 1–100, default 50; continue using the returned `nextCursor`.
Project creation cannot override your UID, HOME, host or base directory.

`bb server access browser --json` prints the certificate browser sign-in URL.
Open it in your own browser, select your trusted client certificate and submit
the empty sign-in form. The server derives the login from the verified CN;
body identity overrides are rejected. The browser receives a 24-hour HttpOnly,
Secure, SameSite=Strict cookie. No token is returned in the page or URL.
`createControlPlaneClient(...).browserLoginUrl()` returns the same URL.
Successful sign-in redirects to `/control-plane/app`: native sidebar navigation
for personal projects and thread summaries, with paginated limited SDK reads.
The selected conversation uses the native live timeline and expandable tool
details. The native composer starts with an approved agent profile, sends or
queues messages, stops owned work and answers approval/question forms. Existing
conversations keep their pinned profile/model; arbitrary execution overrides
are not enabled by these controls.
Switching browser identities revokes the previous browser credential. Switching
between administrator and personal sign-in retires the opposite browser session.
PKCE-issued CLI/plugin credentials remain separate.

`bb server access bootstrap --json` and the personal SDK's `bootstrap()` read
identity, capabilities and the first project/thread/profile navigation pages.
Each page contains at most 50 records and an independent `nextCursor`; continue
through the corresponding list command. Reads use current project/profile
grants and thread ownership. The personal screen can load compiled static assets;
the full administrative UI, raw BB API and WebSocket remain closed. Browser
writes require a matching Origin;
invalid explicit Bearer credentials never fall back to a cookie. Sign-in/out
responses request browser cache/storage clearing; approved plugin persistence
and rendered personal chat remain separate integration stages.

`bb server access browser-context --json` and the personal SDK's
`browserContext()` read the current UI mode (`standalone`, `anonymous`, `admin`
or `user`). Authenticated modes include the verified identity and a noncredential
`cacheEpoch` tied to the current session. It stays stable across a personal
server restart and changes on a fresh sign-in. The built-in web entry checks it
before loading the native application or reading account caches.

Core web caches/drafts and recordings are scoped to identity plus session epoch.
Identity/session changes unmount the application, cancel native queries, close
the native socket and reload through the entry gate. Background/returning pages
are hidden until their identity is revalidated. Same-origin application requests
assert their expected identity/session through `x-bb-client-identity` and
`x-bb-client-session`; existing credentials
still determine authority. Standalone BB keeps its preexisting local settings.
Personal chat controls and legacy plugin-owned persistence remain separate stages.

`bb server access profiles list [--limit <count>] [--cursor <id>]` lists your
permitted agent profiles. `profiles get <profile-id> [--version <version-id>]`
reads the latest enabled or specified enabled version. `profiles versions
<profile-id> [--limit <count>] [--cursor <version-number>]` lists enabled version
metadata newest first. Lists default to 50 and accept 1–100; use `nextCursor`.
No profile grant exposes the full BB API or starts an agent by itself.

Administrators add `--admin` to profile list/get/versions to include disabled
records. `profiles create <slug> --name <name> --definition-stdin` creates a
profile with version 1; `profiles publish <profile-id> --definition-stdin`
publishes another immutable version. Supply JSON with `prompt`,
`providerId: "qwen-server"`, `model`, `reasoningLevel`, `permissionMode`, unique
`tools` and `mcpServers` identifier arrays. These contain policy data, not secret
values, environment overrides or executable MCP commands. Publishing does not
modify earlier versions. Execution binding and enforcement remain a separate
server integration stage.

Managed native thread creation requires `bb thread spawn --profile-version
<version-id>` (SDK/native HTTP field `controlPlaneProfileVersionId`) with a
currently granted, enabled profile and version. The server stores that exact
version atomically with thread ownership and rechecks it on actual dispatch and
resume. New publications do not upgrade existing threads. A legacy unbound
thread remains historical data but cannot execute. Qwen Server applies the native profile subset through protected per-job
settings: fixed model/reasoning, appended prompt and exact native tool allowlist.
Unsupported MCP transports, safe mode and model overrides fail before launch.
Native permission mode must match the bound profile. Personal clients use `bb server access threads`; raw native thread commands
remain administrative on the shared server. The installer pins the reviewed stock CLI artifact;
a corporate fork requires separate verification.

Qwen Server accepts `--permission-mode full|accept-edits|auto` only when it
matches the profile. Project edits can be accepted automatically; other asks
use the native `threads.interactions` SDK and `bb thread interactions
list|approve|deny` in administrative integrations. The transport retains native
tool IDs, expires pending asks and rechecks current grants after approval.
Personal approval endpoints are available under `server access threads interactions`;
restricted native subagent adapters remain pending.
These modes do not add a filesystem jail to the numeric-UID execution boundary.

`bb server access threads start <project-id> --profile-version <version-id>
--message <text>` starts your conversation with the exact approved profile.
Use `--message-stdin` for piped text; it is mutually exclusive with `--message`.
The service chooses UID, HOME, host and cwd from your registered project.
`threads list [--project <id>] [--limit 1..100] [--cursor <id>]` and `threads get
<thread-id>` return only your current project access and thread ownership.
`threads profile <thread-id>` / `threads.profile(id, signal)` reads the pinned
profile version, subject to current profile grants. Publishing a newer profile
version does not silently replace the version of an existing conversation.
Revocation denies this configuration read and subsequent sends; authorized
history and stopping remain available.

`threads send <thread-id> --message <text>` continues the pinned native session;
active turns queue the message. Steering and execution-option overrides are
not supported. `threads stop <thread-id>` can stop your job after its profile
grant is revoked, while current project access is still required.

`threads events <thread-id> [--after <sequence>] [--limit 1..200]` reads a page
of persisted native events in sequence order, exclusive of `after` (default 0).
Continue using `cursor` while `hasMore`; this command is not a live stream.
`threads stream <thread-id> [--after <sequence>] [--json]` opens a personal
live SSE subscription and prints JSON lines. It replays canonical persisted
`event` rows after the exclusive cursor, sends the native BB `thread-timeline`
snapshot and subsequent native `realtime` updates, then remains open. `ready`
marks completion of the initial replay. Track the last consumed `event.seq`;
after disconnect, invoke the command again with that `--after` value. A fresh
native timeline snapshot accompanies reconnection; live frames are not durable
sequence IDs. This is replay, not exactly-once delivery. Ctrl-C stops the local
subscription without stopping the remote thread. `threads timeline <thread-id>`
reads the native latest 20-segment snapshot with deferred content.
Pass both `--before-anchor-id <cursor>` and `--before-anchor-seq <sequence>`
from `timelinePage.olderCursor` to load earlier messages. The SDK equivalent is
`threads.olderTimeline(id, cursor, signal)`; the latest `timeline(id, signal)`
signature stays unchanged.

`threads timeline-details <thread-id> --turn <id> --from <sequence>
--to <sequence> [--item <id>] [--cursor <cursor>]` expands the row's native
turn range, optionally a tool/reasoning item, and pages using `olderCursor`.
The SDK equivalent is `threads.timelineDetails(id, input, signal)`.
These reads recheck ownership and current project grants; cursor fields never
grant access to a different thread. Personal native timeline rendering uses
these same readers for deferred content and prefetching. Administrative native
rendering retains its existing transport.

The transport authenticates in the request header, never the URL. It checks
current project access and token validity before every frame and at least once
per second while idle. Profile revocation preserves authorized history reads.
Per-user stream limits and bounded buffers close slow clients; reconnect from
the last consumed persisted sequence. User access does not enable the raw BB
WebSocket API, global subscriptions or terminal sessions.

`threads result <thread-id>` returns current status and latest assistant text,
not an immutable run snapshot. `threads interactions list <thread-id>` lists
native interactions. `interactions approve|deny <thread-id> <interaction-id>`
submits one-time approval or denial. `interactions resolve <thread-id>
<interaction-id> --response-stdin` accepts native approval or user-answer JSON.
No personal endpoint resolves plugin extension forms yet. New execution,
messages and interaction resolutions recheck the current profile grant;
revocation preserves authorized history reads. All leaf commands accept `--json`.

Delegated BB tools reserve `mcpServers: ["bb"]` plus exact `bb:<tool-name>`
profile entries. The server rechecks current grants before plugin invocation.
Qwen Server connects its own `bb` adapter after context validation, rechecks
permissions on MCP requests and forwards through the guarded native tool route.
Missing tools and arbitrary stdio/HTTP MCP transports fail explicitly.
User plugin SDK calls require a scoped adapter; the full private SDK is not
available to user-principal code. Managed `update_environment_directory` remains
disabled pending registered-project validation. Managed `bb_workflow_run` is
also blocked until tenant scripts use the registered UID execution adapter.

`profiles grant <profile-id> <user-id>` and `profiles revoke <profile-id>
<user-id>` change a registered user's access to that profile's enabled versions.
`profiles access <profile-id> [--limit <count>] [--cursor <id>]` lists its grants.
`profiles enable <profile-id>` and `profiles disable <profile-id>` change the
whole profile's availability; add `--version <version-id>` to affect only one
version. Users cannot read disabled or ungranted records, including known IDs;
administrative management requires an administrative session.

On a protected deployment of the server-control-plane fork, administrators sign
in with `bb server access login --login <name> --password-stdin`, supplying the
password from private stdin. `bb server access status` shows the current login;
`bb server access logout` revokes it. Sessions are private files under
`~/.bb/server-access`, bound to the server origin, and expire after one day or a
server restart. Do not supply administrative sessions to agent processes.
Shared deployments must set `BB_CONTROL_PLANE_REQUIRED=1`; a private
`control-plane.json` in the server data directory configures the public HTTPS
origin and administrator password hash. Without configuration and without the
required flag, upstream single-user behavior is preserved.

The fork can supervise one local daemon when private `control-plane.json`
contains `runtime.daemonEntrypoint` (the built host-daemon `control-plane.js`)
and `runtime.cliDirectory` (the built CLI directory). Both are absolute paths;
certificate users must also be configured. This mode keeps the host identity
in the server data directory, uses private machine bootstrap and a Unix socket
for Qwen execution context, and disables the daemon's local HTTP API. For a
private server CA, start the server with `NODE_EXTRA_CA_CERTS`. Administrators
enable the bundled Qwen Server provider through normal plugin management;
packaging the provider does not authorize arbitrary user workspaces.

Managed Qwen jobs require Linux unprivileged user/PID/mount namespaces in addition
to registered UID/GID and HOME permissions. Each job mounts its own proc view;
namespace setup failure rejects the launch. Docker execution requires the derived
seccomp profile and proc-mount options described in the fork deployment guide.
No privileged container or `CAP_SYS_ADMIN` is required.

Set Machines → Server URL reachable by machines, or run `bb settings general
machineServerUrl https://bb.example.com`. An unset value uses BB_EXTERNAL_URL.
Set Default machine access with
`bb settings general defaultMachineAccess direct` or `connect`; `null` uses
the first registered access provider, or direct when none is registered. An
unpaired provider reports setup required. `bb settings show --json` includes
fresh provider availability and the effective selection; failed or timed-out
checks report unavailable. Machines use this access for ongoing runtime
requests, including account-pool endpoints. A machine on bb connect access holds
a getbb.app machine credential that `bb machine remove` revokes; if that
revocation fails, revoke the machine in the getbb.app dashboard.

Remote access through getbb.app comes from the bundled bb account and Connect
plugins: `bb account login|status|logout` signs this server in (bb-account
skill), and `bb connect status|on|off|expose|unexpose|unexpose-all|shares`
serves it at `<handle>.getbb.app` and shares HTTP ports from any enrolled host
(share-server-links skill). `bb connect servers` lists every bb on the account.
`bb connect machine-code` mints a one-time, 10-minute code that pairs the bb
mobile app (also shown under Settings → Mobile → Add mobile device); `--json`
prints `{code, serverUrl, apex, expiresAt}`. Without an installed bb, pair a
dashboard code with `npx -p bb-app@latest bb connect --code <code>`.

## Move the server

Moving the server is experimental and off by default. Turn on the `serverMove`
experiment in Settings → Experiments or with
`bb settings experiment serverMove true`; until then Settings → Machines hides
Move server here, and `bb server move`, `bb server export`, and deleting an old
server copy from the server are refused with `server_move_experiment_disabled`.

Agents must not move a server, abandon a move, or unlock an old copy without
the user's explicit confirmation in the conversation. Run `--check`, show the
user the checklist, and wait for their confirmation; don't pass `--yes` to skip
the confirmation on their behalf.

A move copies the server's data (database, settings, plugin data, attachments)
to another persistent machine, points every machine and app at it, and keeps the
old computer running as a regular machine. Worktrees, thread storage, and
checkouts stay on the machines that own them.

  bb server move --to <id-or-name>        Stop all work and move the server
    --check                               Print the checklist and stop
    --address <url>                       New server address (direct setups)
    --archive-existing-data               Move bb server data on the target aside
    --yes                                 Skip the confirmation
    --json                                Print the final move status
  bb server move status                   Show the steps, or the last move
  bb server move cancel                   Cancel before the switch starts
    --yes                                 Abandon a move that needs recovery without asking
  bb server export --out <file>           Export a running server
  bb server import <file>                 Install an export on this computer
    --data-dir <dir>                      Target data directory
  bb server unlock                        Let this computer's old copy start again
    --force                               Skip the new-server health check
  bb server allow-connect                 Turn bb connect and bb account on for an imported copy
  bb server delete-old-copy               Delete the old copy a move left here
  bb server install-machine-service       Keep this computer connected after a move

`--check` exits nonzero while a blocker remains. With bb connect, machines and
apps keep the same URL. A direct-address server needs `--address`: the URL every
machine and app will use to reach the new server. Existing bb server data on the
target is archived to `<dir>.before-move-<date>` only with
`--archive-existing-data`; it is never merged. SIGINT stops following while the
move continues. Failure or cancellation before the switch leaves the server
where it was. The SDK equivalents are `sdk.experimental_server.checkMove`,
`startMove`, `moveStatus`, `cancelMove`, and `export`.

`bb server move` exits 0 once moved and 1 when the move fails or is cancelled.
When the target never confirms that it took over, the move waits in
`recovery_required`: the old server stays up and read-only, and bb finishes the
move on its own once the target answers. `bb server move` and
`bb server move status` exit 2 in that state and name the exits:
`bb server move cancel` abandons the move and keeps the server here (it asks
first, since abandoning while the target took over leaves two servers; `--yes`
skips the question), and `bb server unlock` recovers an old copy that stopped.

`bb server export` writes a gzip archive to a 0600 file. The archive is not
encrypted and holds the server's credentials and plugin secrets, so keep it
private. `bb server import` works offline: it refuses a data directory that has
`bb.db` or a running bb and an export made by a newer bb or with the
`serverMove` experiment off. Rerunning an interrupted import rolls it back
first (`--json` reports `rolledBackInterruptedImport: true`). An imported
server starts with bb connect and bb account off so it can't take the original
server's tunnel or account; stop the original server, then run
`bb server allow-connect` to turn them on at the next start.

After a move, bb on the old computer refuses to start the old server and runs as
a regular machine. `bb server delete-old-copy` deletes the server files left
behind and keeps that lock. The desktop app installs the persistent machine
service itself; after a move from `bb-app`, or to retry, run
`bb server install-machine-service` (macOS and Linux; needs Node.js 22.19 or
newer on the PATH). `bb server unlock` is a last resort: everything since the
move is lost on that copy, it refuses while the new server still answers unless
`--force` is passed, and it refuses while the machine service is installed.
`unlock`, `delete-old-copy`, `allow-connect`, and `install-machine-service`
act on `BB_DATA_DIR` or `~/.bb` unless `--data-dir <dir>` is passed.

## Local daemon lifecycle

Reconnect a disconnected machine whose server access or host key was revoked
or became stale, without changing its BB host ID:

  bb machine reconnect <id-or-name>       Print a short-lived reconnect command and wait for reconnection
                                          (refused for a connected machine)
    --json                                Print the command and expiry without waiting

Run the printed command on the affected machine; if it fails, run it again. The
machine re-enrolls with a new host key and server access and restarts its
daemon service. Environments, workspaces, and thread associations are kept. The
command reuses the data directory the daemon last reported (an explicit
`BB_DATA_DIR` takes precedence) and refuses a directory that does not hold this
machine. The server's own machine cannot be reconnected this way.

`install-machine.sh --start|--stop|--uninstall --host-id <id>` starts, stops, or
removes an owned local installation; optional `--server-url <url>` and
`--data-dir <path>` (or `BB_DATA_DIR`) assert the expected installation, and a
mismatch refuses the operation. Stop and uninstall succeed when no matching
installation exists; start requires one. They refuse the default BB data
directory. `install-machine.sh --adopt --data-dir <path>` installs the service
for a directory that is already enrolled. These are local primitives:
`bb machine remove` asks the server to remove the provider resource, and
`bb machine suspend` invokes provider suspension.

## Enroll a preinstalled machine

`bb machine enroll --bootstrap-file <path>` or `bb machine enroll --bootstrap-env <NAME>` consumes a private enrollment bundle prepared by core. Supply exactly one source. The environment variable is removed from the CLI process after reading it; files remain under the caller's ownership. Neither command prints the bundle or credentials.

The CLI refuses another host or server identity in the selected machine directory. Repeating enrollment with the same persisted identity succeeds, including after the original bundle expired. Machine data defaults to `~/.bb-machines/<server-host>`; `BB_DATA_DIR` can select another isolated machine directory, but enrollment refuses the default `~/.bb` directory unless its `host-id` already names this machine.

The installer accepts `--bootstrap-env <NAME>` and installs a private CLI at `~/.local/bin/bb` without replacing an existing path; non-login transports can use `command -v bb` with `~/.local/bin/bb` as a fallback. On a systemd host whose user bus is unreachable, installation fails before enrolling; containers and machines without systemd as init run a detached daemon. `BB_INSTALL_SKIP_SERVICE=1` leaves a detached daemon that does not start after reboot.

## Existing machines

`bb machine create --provider manual` waits for a private enrollment command,
prints it once with its expiry, and follows the host until the daemon connects.
Run that command on the target machine; it installs bb if needed. The CLI
prints a command for macOS and Linux and a PowerShell command for Windows.
Treat it as a credential. It cannot be renewed and does not survive a server
restart: after it expires, remove the machine and create it again (the app
offers Generate new command). Server access is resolved through the selected
default access provider. `--no-wait` returns the creating host ID.

On Windows, the command installs under
`%USERPROFILE%\.bb-machines\<server-host>`, starts the daemon at sign-in, and
needs Node.js 22.19 or newer on PATH. Manage it with
`node <machine-dir>\install-machine-windows.mjs --stop|--start|--uninstall --host-id <id>`.

Use `bb machine show <host-id>` to recover progress and
`bb machine remove <host-id>` to cancel and revoke enrollment/access. Stopping
the CLI or closing the dialog only stops following; creation continues.
Manual machines never idle-suspend or automatically retire and do not expose
suspend/resume. Removing one revokes its server access without executing on the
machine. Run the original installer with `--uninstall --host-id <host-id>` on that box, with its
original `BB_DATA_DIR` if explicitly configured, to remove its installation.

## Machine environment

  bb machine env list [--project <id>] [--json]
  bb machine env set NAME [--project <id>] [--note text] [--json]
  bb machine env unset NAME [--project <id>] [--json]

`set` reads the value from stdin, removing one trailing newline; values are
never accepted in argv and never returned by list or set. List masks all values,
includes built-in GitHub health, and for project scope includes inherited
global rows. Set and unset update one variable atomically. SDK:
`system.machineEnvironment()` and `system.replaceMachineEnvironment({ variables })`;
replacement is atomic, so pass every row to retain, using `value: null` for an
unchanged saved secret. Settings → Environment variables (and Project settings →
Advanced settings for one project) edits the same variables; saved secrets can be
replaced but never revealed.

Omit `--project` for global variables. Project overrides follow the project
across machines and worktrees, including the primary host, and override global
values. Empty strings override; unset restores inheritance. User variables
override built-in values on every connected host; agent-provider variables win
over them for agent turns. All values are encrypted at rest.

Changes apply to the next agent turn, new terminals and commands (including git
and gh operations), and repository setup, which receives freshly resolved values
on each run. Existing processes, terminals, and cached provider runtimes keep
their launch environment until recreated. Removing an override restores the
daemon's original value. Runtime output is forwarded as-is, so commands and
providers can print these values.

The server's gh login provides GitHub credentials, Git HTTPS and SSH access,
and commit identity to non-primary hosts. The primary host uses its local Git
authentication unless a user supplies an explicit global or project GH_TOKEN.
The built-in GH_TOKEN row reports logged in, not logged in, or overridden; a
custom GH_TOKEN overrides it. No credentials are installed in images or global
Git config. `bb settings general machineGitCredentialsEnabled false` (the
automatic GH_TOKEN switch in Settings → Environment variables) stops forwarding
the server's gh credentials; `true` enables it again. This does not log the
server out or suppress an explicit custom GH_TOKEN.

Personal browser links use `/projects/<project-id>/threads/<thread-id>#msg=<sequence>`;
project pages use `/projects/<project-id>` and `/threads/<thread-id>` also resolves
an owned conversation. Native copy-message links use these same routes. The
browser fetches selected objects through the personal API, including when they
are outside the currently loaded sidebar page. Certificate login returns only
to validated same-origin personal shell paths; a shell response grants no access
to a thread. Foreign or mismatched project/thread links cannot display history or
send messages. Browser Back/Forward follows URL selection.

`bb server access threads link <thread-id> [--message <sequence>] --json` prints
`{ "url": "..." }` without opening a browser. The personal SDK equivalent is
`threads.browserUrl(id, { messageSeq, signal })`. Both first read the current
authorized thread to obtain its actual project, and never put credentials in URLs.

### Personal workflow runs on a shared server

After certificate sign-in, `bb server access workflows` uses the limited personal
API. The administrator must enable the builtin Workflows plugin. A personal
credential does not grant the unrestricted `bb workflows` command or plugin RPC.

```bash
bb server access workflows start <origin-thread-id> --file ./review.js --args '{"branch":"main"}' --json
bb server access workflows list --project <project-id> --limit 20 --json
bb server access workflows get <run-id> --json
bb server access workflows result <run-id> --json
bb server access workflows history <run-id> --after -1 --limit 20 --json
bb server access workflows stop <run-id> --json
```

Choose one source input: `--script <source>`, `--script-stdin`, or `--file <path>`.
The file is read on the client and uploaded as source; it is not a server path.
Scripts are limited to 512 KiB. `--args` is bounded JSON, at most 128 KiB,
32 levels and 10,000 values. `start --resume <run-id>` replays an owned terminal
run's unchanged prefix using the supplied source. The server derives project,
UID, HOME, cwd and approved profile from the owned origin thread. Source scripts
can select other approved immutable worker profiles with the existing DSL.

Lists contain personal runs, including within shared projects. Continue with
`--cursor <nextCursor>` until it is null; a page can be empty when native run
history has been pruned. History's numeric `nextCursor` is used as `--after`.
Result responses distinguish `available: false` from a JSON null result.
Current project access is required for reads and cancellation. Losing an
execution-profile grant prevents new starts, while authorized history and
cancellation remain available. Cancelling disables the saved run authority.

With `createControlPlaneClient`, use `workflows.start({originThreadId, script,
args?, resumeRunId?})`, `list({projectId?, cursor?, limit?, signal?})`, `get(id,
signal?)`, `result(id, signal?)`, `history(id, {after?, limit?, signal?})` and
`stop(id, signal?)`. Start accepts an optional second AbortSignal. These methods
also work with a personal browser cookie on the matching origin. Definitions,
schedules, workflow UI and dedicated progress subscriptions remain separate
shared-server work; a started workflow continues independently of its browser
session under current saved execution grants.
The workflow HTTP envelope is separately limited to 4 MiB, allowing for JSON
escaping; the tighter source and argument limits still apply.
