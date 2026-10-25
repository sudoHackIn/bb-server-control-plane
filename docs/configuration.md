# Configuration

## Shared-server administrative access (fork)

Managed Qwen execution additionally requires Linux unprivileged user/PID/mount namespaces. The fixed launcher preserves the registered numeric UID/GID and mounts a separate proc view per job, failing closed if namespace setup is denied. Docker must use the [derived seccomp profile and proc-mount options](../deploy/control-plane/security/README.md); no privileged container or `CAP_SYS_ADMIN` is needed. This does not replace HOME/project filesystem permissions.

This fork loads administrative access settings from a private `control-plane.json` in the server data directory. Set `BB_CONTROL_PLANE_REQUIRED=1` on shared deployments so a missing file prevents startup. Values other than `0` and `1` are rejected. Invalid or publicly readable configuration never falls back to anonymous access. Without the file and without the required flag, upstream single-user behavior is preserved. See [setup and feature status](server-control-plane.md).

The optional `runtime` object contains absolute `daemonEntrypoint` and `cliDirectory` paths. Configure both with `scripts/configure-control-plane.ts --daemon-entrypoint <host-daemon/dist/control-plane.js> --cli-directory <cli/dist>` alongside the certificate-user options. The server supervises one local daemon with the stable host ID in its private data directory. It bootstraps only a machine-scoped credential through stdin and serves a private Unix socket for registered Qwen thread contexts. The managed daemon disables its local HTTP API and auto-update; it shuts down when its parent channel closes. Standard external-daemon behavior is unchanged when `runtime` is absent. For a private CA, provide `NODE_EXTRA_CA_CERTS` to the server so its managed child can verify the HTTPS listener. The Qwen Server plugin is packaged but disabled by default; an administrator enables it through normal plugin management.

Configure the file with `pnpm exec tsx scripts/configure-control-plane.ts --data-dir <path> --origin <https-origin> --login <name>`, supplying the password through private stdin. The browser login is `/control-plane/login`. CLI administrators use `bb server access login --login <name> --password-stdin`, then normal commands. CLI sessions are stored per origin in private `~/.bb/server-access/*.json`; they last one day and are revoked by logout or server restart. They must never be supplied to tenant agents.

Optional `users` configuration enables direct HTTPS certificate authorization: `usersRoot`, `firstUid`, `lastUid` and `tls: { keyFile, certFile, clientCaFile }`. The setup script accepts `--users-root`, `--first-uid` (default 200000), `--last-uid` (default 299999), `--tls-key`, `--tls-cert` and `--client-ca`; supply all paths together. TLS paths must be absolute regular files owned by the service user, and the private key must have no group/other permissions. The server validates the client certificate against that CA and uses its CN as the user login. Forwarded identity headers are ignored. TLS termination must reach this listener directly or through TLS passthrough for certificate approval.

`bb server access authorize [--client-name <name>]` prints a browser URL, waits for certificate approval, exchanges PKCE and saves a 24-hour opaque user token without printing it. `status` and `logout` support both user and administrator sessions. User tokens persist in the shared BB database as hashes, survive server restarts until expiry and stop working when the user is disabled. `bb server access environment [--provision]` inspects or creates/verifies the user's HOME and project directories through a fixed privileged helper. Supported numeric UIDs are 200000–299999; no agent Unix accounts are created. The helper policy must match `usersRoot`, and the filesystem must support POSIX ACLs. Persist the user directories and `/var/lib/bb-agent-launcher` manifests together with the BB database. The personal thread API remains a later stage.

After environment provisioning and local host registration, `bb server access projects create <slug> --name <name>` creates a native BB project below the user's project directory. `projects list [--limit 1..100] [--cursor <nextCursor>]` and `projects get <project-id>` expose only current grants with valid native source bindings. User-supplied identity/path/host overrides are rejected. Project ownership and grants live in the shared BB database; personal conversations use `bb server access threads` with an approved profile version.

Approved profile definitions, immutable versions, availability and user grants are stored in the same BB database. `bb server access profiles list|get|versions` reads the user's permitted enabled records; administrators add `--admin` for all records and use `create|publish|grant|revoke|enable|disable|access` to manage them. Create/publish take definition JSON on `--definition-stdin`, never executable command/environment overrides or credentials. See `bb guide machines` and [profile integration status](server-control-plane.md#tenth-increment-approved-profile-catalog). A catalog record alone is not execution authority: native threads must be bound to approved versions, current grants must remain valid and the provider must support and enforce every selected setting.

Managed thread creation additionally requires `controlPlaneProfileVersionId` on the native HTTP/SDK request, or `bb thread spawn --profile-version <version-id>`. This pins an authorized enabled version with ownership before thread creation notifications. Dispatch and the private Qwen resolver recheck current profile grants and availability; later publications never upgrade an existing thread. Migration 0151 preserves older unbound rows for history and denies their execution. The Qwen Server provider enforces a native subset through root-owned per-job settings: fixed model/reasoning, appended prompt and exact native tool allowlist. Unsupported MCP transports, safe mode and caller model overrides fail before launch. Native permission mode must match the profile. The installer pins the reviewed stock CLI artifact; a corporate fork requires its own review. Arbitrary MCP transports, restricted native subagents and the personal thread API remain pending. `QWEN_SERVER_MODEL` is no longer an execution override.

Managed BB plugin tools require both `mcpServers: ["bb"]` and an exact `bb:<registered-tool-name>` profile tool entry. Current grants are rechecked at every daemon tool invocation. Qwen Server connects only the built-in delegated `bb` MCP adapter after context validation. Missing or unsupported tool names fail before launch; arbitrary stdio/HTTP MCP servers remain unsupported. The adapter rechecks current context and uses the native BB tool route, which checks grants again before invocation. User-principal plugin SDK calls require a scoped adapter and currently fail explicitly, including HTTP and realtime. Trusted administrative/service plugin SDK calls remain available. Managed `update_environment_directory` is denied until it can validate registered projects; `bb_workflow_run` is denied until tenant scripts have a verified UID execution adapter.

Qwen Server supports `full` (`yolo`), `accept-edits` (automatic canonical project edits plus BB approval for other operations) and native Qwen `auto` (classifier with BB manual fallback). These are approval policies inside the existing Unix identity, not an added filesystem jail. HOME permission/auto-allow rules are cleared by protected policy. Requests retain native tool/turn IDs, offer only one-time decisions, expire after at most five minutes and recheck current grants after approval. Administrative integrations use the existing `threads.interactions` SDK and `bb thread interactions list|approve|deny`; user-scoped endpoints remain pending.

The packaged `npx bb-app` flow stores persistent package settings under
`~/.bb/config.json`, provider environment values under `~/.bb/env.json`, and
client SSH target mappings under `~/.bb/client.json`.

Use `bb-app config` for non-secret bb settings and `bb-app env` for provider
credentials and provider-specific environment:

```bash
npx bb-app config set BB_APP_URL https://<machine>.<tailnet>.ts.net
npx bb-app config list
npx bb-app config unset BB_APP_URL
npx bb-app config refresh
npx bb-app env set OPENAI_API_KEY <key>
npx bb-app env list
npx bb-app env unset OPENAI_API_KEY
```

`bb-app config list` shows non-secret values. `bb-app env list` redacts every
value and only shows whether a key is set. When targeting a non-default
running instance, pass the same `--data-dir` and `--server-port` to
`bb-app config` or `bb-app env` so they write the right file and refresh the
right server.

Launcher status output is plain when stdout is redirected, including in CI.
Set `FORCE_COLOR=1` to request color or `NO_COLOR=1` to disable it; `NO_COLOR`
takes precedence. In-place progress updates require a stdout TTY.

## Repository worktree hooks

Commit `.bb-env-setup.sh` when a managed worktree needs repository setup.
Commit `.bb-env-teardown.sh` when bb must release external resources before it
removes that worktree. See [Worktrees, setup scripts, and teardown
scripts](worktrees.md) for the lifecycle, environment, timeout, and failure
contracts.

## Precedence

Configuration is resolved in this order:

1. Explicit launcher flags, such as `--data-dir`, `--server-port`, or
   `--server-bind-host`.
2. Persistent `bb-app config`, `bb-app env`, and client values.
3. Ambient shell environment.
4. Built-in defaults.

For the packaged app, prefer `bb-app config`, `bb-app env`, and launcher flags
over shell variables. Source-development commands still load `.env` files
(see [Source Development](#source-development)).

After `bb-app config` writes `~/.bb/config.json` or `bb-app env` writes
`~/.bb/env.json`, it asks the running local server to reload. If bb is not
running, the new values apply on the next start. If you edit either file by
hand, run `npx bb-app config refresh` to apply it to a running server.

The live reload applies the `BB_APP_URL` config key, `customModels`,
`sharedSkillRoots`, and provider env values. `BB_APP_URL` stored with
`bb-app env` instead of `bb-app config` is startup-only.

These entries are startup-only:

- `BB_APP_SURFACE`, `BB_APP_URL` (when set through `bb-app env`),
  `BB_DATA_DIR`, `BB_DEV_APP_PORT`, and `BB_EXTERNAL_URL`
- `BB_HOST_DAEMON_PORT` and `BB_INHERITED_SKILLS_ROOTS`
- `BB_CONNECT_GATE_KEYS_URL`, `BB_LOG_LEVEL`,
  `BB_MANAGED_DEV_BUILTIN_PLUGIN_HOT_RELOAD`, `BB_MARKETPLACE_URL`,
  `BB_PERF_DIAGNOSTICS`, `BB_POSTHOG_API_KEY`, and `BB_TELEMETRY`
- `BB_SERVER_BIND_HOST`, `BB_SERVER_PORT`, and all `BB_FF_*` feature flags

Setting or unsetting one still reloads any other pending changes, but running
processes keep their current values until a full launcher restart
(`bb-app stop && bb-app start`) or a desktop app restart. In particular,
changing or unsetting `BB_SERVER_BIND_HOST` does not close an existing
`0.0.0.0` listener until that restart. `bb-app config refresh` names any
startup-only keys present in `config.json` or `env.json`.

## Stopping A Running bb

A running `bb-app start` writes `<dataDir>/bb-app-runtime.json` (launcher
process id, server URL, version, start time, and launch mode) and removes it on
exit. Do not edit it. `npx bb-app stop` uses it to stop the bb that owns the
data directory; pass the same `--data-dir` you started with when it is not the
default `~/.bb/`. The macOS desktop app uses it to offer stopping a bb it did
not start. Both verify the recorded process is a bb launcher before signalling
it, so a stale file cannot stop an unrelated process.

## The bb Command On PATH

Settings → General → Command line has an **Install** button that installs the
bb CLI for use outside bb: it puts the `bb` command on your PATH, so you, a
script, or an agent running outside bb (such as Claude Code or Codex) can
control bb with `bb thread list` and every other CLI command. Threads in bb
already have `bb` on their PATH and need nothing. **Remove** takes it off again. Nothing changes your PATH until
you choose Install. The CLI equivalent is `bb settings cli-command` (show),
`bb settings cli-command install`, and `bb settings cli-command remove`; the
SDK methods are `system.experimental_cliCommand()`,
`system.experimental_installCliCommand()`, and
`system.experimental_removeCliCommand()`, over
`GET /api/v1/system/cli-command` and `POST .../install` and `.../remove`.

- Every start of an installed bb (`npx bb-app` or the desktop app) writes a
  small launcher to `<dataDir>/bin/bb` (`bb.cmd` on Windows). It runs the bb
  CLI of the install that started last, with that install's own Node runtime,
  so the desktop app needs no separate Node. After bb moves or updates, start
  it once to refresh the launcher. Source checkouts (`pnpm start`, `pnpm dev`)
  write no launcher and do not show the setting.
- Install acts on the computer that runs the bb server. On macOS and Linux it
  links the launcher into the first usable folder of `/opt/homebrew/bin` and
  `/usr/local/bin` (macOS only), `~/.local/bin`, and `~/bin`, preferring one
  already on your PATH. If the folder is not on your PATH, the setting says so.
  On Windows it appends `<dataDir>\bin` to your user PATH.
- bb never replaces another `bb`. If one already comes first on your PATH
  (for example a global `npm install -g bb-app`, the `~/.local/bin/bb` a bb
  machine install added, or Babashka), the setting names it and Install is
  refused with `409 cli_command_blocked`.
- Remove deletes only links that point at a bb launcher, or the
  `<dataDir>\bin` PATH entry on Windows.
- Machine credentials cannot install or remove the command.

`BB_CLI_LAUNCHER` is an internal path the launcher passes to its server child;
do not set it yourself.

## In-App Updates

In-app updates are on when you start bb with `npx bb-app start` (or a global
`bb-app`) or with `pnpm start` from a source checkout. bb runs under a small
update shim, so Settings → Updates and `bb updates app apply` can update bb
without a terminal. Pass `--no-in-app-updates` to turn them off: bb then starts
without the shim and Settings → Updates shows the npm upgrade command for
release installs. `--in-app-updates`, which earlier releases needed, is still
accepted and changes nothing. Source checkouts show their
Git revision, or a labeled build version when unavailable, and are never compared
with npm releases. Without the update shim, no freshness indicator is shown.
Failed checks report “Latest unknown”; release checks can be retried in the UI,
with `sdk.system.version({ force: true })`, or by rerunning `bb updates`.
`GET /api/v1/system/version` and `sdk.system.version()` expose nullable
`installKind` (`desktop`, `npm`, or `source`) and `currentCommit` fields.

- **npm installs** download the release into
  `<dataDir>/app-versions/<version>/` and restart into it. The shim runs
  whichever is newer, that install or the launched `npx` copy; `--bundled`
  always runs the launched copy. bb keeps the running and previous versions.
  Stable installs follow the `latest` dist-tag and nightly builds `nightly`.
- **Source checkouts** update only from a clean `main` that fast-forwards to
  `origin/main`; bb fast-forwards, runs `pnpm install --frozen-lockfile`,
  rebuilds, and restarts.

bb does not roll back an update; a version that fails to start runs again on
the next start, and an older release may not open a database the new version
migrated. The outcome is recorded in `<dataDir>/bb-app-update.json` (do not
edit it). Only one launcher manages updates for a data directory; a second
`bb-app start` on it runs with in-app updates off. `pnpm dev`, `bb-server`, and a standalone
`bb-host-daemon` do not offer in-app updates. `BB_APP_UPDATE_MODE`,
`BB_APP_INSTALL_KIND`, `BB_APP_SOURCE_ORIGIN`, and `BB_APP_SOURCE_COMMIT` are
internal markers the launcher passes to its server child; do not set them. See
`bb guide machines` for the `bb updates` commands.

Settings → Updates shows the **Server** row for both standalone servers and servers
hosted by the desktop app. **Update** downloads the release and restarts the
server, using the hosting desktop's native updater when applicable. It asks
before interrupting running threads and checks again when the download finishes.
A separate **Desktop** row appears when the viewing desktop needs attention and
is not the desktop hosting the server. The same server update is available with
`bb updates app apply` and `sdk.system.applyAppUpdate`.

Desktop update capability is an additive `desktopUpdateSupported: true` field in
`SystemAppUpdateStatus`. The legacy `support` value remains
`{ kind: "unsupported", reason: "desktop" }`, so previously shipped clients can
still parse the response and keep their existing desktop update path. New clients
use the capability to offer the shared server controls. If an updater request
fails, confirmed support is retained and installation is blocked until a retry
succeeds. Desktop/server IPC stays within the bundled process tree and does not
change the host-daemon protocol.

## Common Keys

| Key                            | Set with                                           | When to set             | Used for                                                                                                                                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BB_APP_URL`                   | `bb-app config`                                    | Optional for remote use | Human-facing app URL used for generated links, allowed browser origins, and the allowed DNS hostname for requests. Leave empty for local-only use. Live when set with `bb-app config`.                                                                                     |
| `BB_EXTERNAL_URL`              | `bb-app env`, or environment                       | Startup-only            | Internet-facing HTTPS base URL for generated public links; the fallback for `machineServerUrl`.                                                                                                                                                                            |
| `BB_MARKETPLACE_URL`           | `bb-app env`, or environment                       | Startup-only testing    | Manifest URL of the reserved `bb-community` marketplace. Default `https://getbb.app/marketplace/v2/marketplace.json` (falls back to v1 on 404); a custom URL is requested without fallback. Changes only `bb-community`.                                                   |
| `BB_CONNECT_GATE_KEYS_URL`     | `bb-app env`, or environment                       | Startup-only testing    | Public key set the bb connect next tunnel ingress verifies gate assertions with. Default `https://getbb.app/.well-known/bb-connect-gate-keys.json`. See [connect-next.md](connect-next.md).                                                                                |
| `BB_SERVER_URL`                | `bb-app config`                                    | Remote CLI/host use     | Server targeted by the standalone `bb` CLI and `host-daemon` commands on this machine. Defaults to `http://127.0.0.1:38886`. It does not change where `npx bb-app` binds.                                                                                                  |
| `BB_SERVER_BIND_HOST`          | `bb-app env`, environment, or `--server-bind-host` | Startup-only            | Server listener host: `127.0.0.1` (default) or `0.0.0.0`. Not a `bb-app config` key. See [Startup Flags](#startup-flags).                                                                                                                                                  |
| `BB_SERVER_PORT`               | `bb-app env`, environment, or `--server-port`      | Startup-only            | HTTP listener port. Defaults to `38886`.                                                                                                                                                                                                                                   |
| `BB_HOST_DAEMON_PORT`          | `bb-app env`, environment, or `--host-daemon-port` | Startup-only            | Local host-daemon API port. Defaults to `38887`.                                                                                                                                                                                                                           |
| `BB_LOG_LEVEL`                 | `bb-app config`                                    | Startup-only debugging  | `trace`, `debug`, `info`, `warn`, `error`, or `fatal`.                                                                                                                                                                                                                     |
| `BB_TELEMETRY`                 | `bb-app env`, or environment                       | Startup-only            | `false` always disables anonymous usage telemetry, overriding the `telemetryEnabled` setting.                                                                                                                                                                              |
| `BB_SKIP_ONBOARDING`           | Environment                                        | Startup-only            | Default false. `1` marks first-run setup completed at startup when it is not yet, so the setup screen is skipped. Settings → General can still replay it. `pnpm dev`, `pnpm start:worktree`, and `pnpm desktop:worktree` default it to `1`; an explicit `0` retains setup. |
| `BB_PERF_DIAGNOSTICS`          | `bb-app env`, environment, or `--perf-diagnostics` | Startup-only            | Default false. Permits the `performanceDiagnostics` experiment; see [Experiments](#experiments).                                                                                                                                                                           |
| `BB_CLI_ERROR_LOG`             | Environment of the `bb` process                    | Optional                | `0` stops the CLI recording failed invocations (command path, error code, no argument values) to `<dataDir>/logs/cli-errors.jsonl`. See `bb guide overview`.                                                                                                               |
| `BB_ACCOUNT_POOL_PARENT_URL`   | Set automatically by a parent bb server            | Nested bb servers       | Account Pooler hub of the bb server whose thread launched this one. When present the Account Pooler plugin is enabled on first run and proxies to that parent; `bb pool parent isolate` opts out. Not a `bb-app config` key.                                               |
| `BB_ACCOUNT_POOL_PARENT_TOKEN` | Set automatically by a parent bb server            | Nested bb servers       | Machine token this nested server presents to the parent hub. Both parent variables must be well formed or proxying stays off.                                                                                                                                              |

BB accepts request hosts that are `localhost`, IP addresses (including LAN and
Tailscale IPs), or the hostname in `BB_APP_URL`. For a custom DNS name or
reverse proxy, set `BB_APP_URL` (for example `https://bb.example.com`) before
connecting, including from the CLI or SDK; a matching `Host`/`Origin` or
`X-Forwarded-Host` cannot authorize an unconfigured name. A proxy can preserve
the configured host or forward to localhost. bb connect needs no additional
configuration.

## General settings

`idleProviderSessionTimeoutMinutes` (default `30`) sets how long an agent can sit idle after its last turn before every machine stops its provider process to free memory. Allowed values are `0` (ASAP), `5`, `10`, `30`, and `60`. Use Settings → Providers → Configuration → Release idle agent sessions, `bb settings general idleProviderSessionTimeoutMinutes 5`, or SDK `system.updateGeneralSettings({ ...config.generalSettings, idleProviderSessionTimeoutMinutes: 5 })`. Read `config` with `system.config()` or inspect the value with `bb settings show`. Changes apply live and on reconnect. Machines check every five minutes, so release can take up to five minutes beyond the timeout. Only restorable sessions without active, pending, or background work are eligible; threads keep their history and resume on the next message. Manual `bb thread stop` still works. This is not a memory or loaded-process limit.

Server-wide preferences, stored in the bb database and applied live to every
client. Set them in Settings, with `bb settings general <key> <value>`, or with
SDK `system.updateGeneralSettings`, which takes the full settings object (read
the current `generalSettings` and change one key). See `bb guide customization`
for the command surface.

| Key                                                                        | Default                             | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `showDiagnosticEvents`                                                     | `false` in all builds               | Settings → General → Privacy & diagnostics → Show diagnostic events. Shows provider environment resolution and raw provider events bb does not yet understand in the timeline. Warnings, errors, and model fallback stay visible. Hidden diagnostics do not count toward timeline event or byte limits.                                                                                                                                                                                                                                        |
| `steerActiveThreadOnEnter`                                                 | `true`                              | Settings → General → Default thread followup behavior, when no typeahead suggestion is active. `true` ("Steer"): Enter sends to the agent during its current run and Mod+Enter queues the message until the agent stops; `false` ("Queue") swaps them. Installs with saved settings or work from before the setting were migrated once to `false`.                                                                                                                                                                                             |
| `confirmThreadArchive`                                                     | `true`                              | Settings → General → Thread archive confirmation. `false` archives a thread and its children in the app without a confirmation popup; the toast still offers Undo. CLI and SDK archives never prompt.                                                                                                                                                                                                                                                                                                                                          |
| `showGitChanges`                                                           | `true`                              | Settings → General → Show Git changes and Commit button. `false` hides the untracked, uncommitted, and committed file summary and expanded file list above every thread composer, that shelf's pull-request status and actions, and the Commit action in the thread header and overflow menu. Thread relationships and workspace warnings stay visible.                                                                                                                                                                                        |
| `keepHistoryAfterContextClear`                                             | `false`                             | Settings → General → Show messages from before a context clear. When `false`, a thread's timeline, conversation outline, and message lookup start at its latest `Context cleared` boundary; `true` keeps earlier messages, which load on scroll and appear in the outline and `bb thread log --message`. Clearing always starts a fresh provider conversation and resets the context meter.                                                                                                                                                    |
| `summarizeShellCommands`                                                   | `true`                              | Settings → General → Summarize shell commands. `true` titles a shell command that runs `ls`, `find`, `grep`, `rg`, `cat`, `head`, `tail`, `nl`, or `sed -n` with a summary such as `Searched for X`, and the row does not expand. `false` titles every shell command row with its command (`Running …`, `Ran …`), expands it to the command and its output, and counts it as a command in step summaries. Native read and search tool rows keep their titles.                                                                                  |
| `streamerMode`                                                             | `false`                             | Settings → General. Hides every `customModels` entry from the web and mobile pickers, `bb provider models`, and `sdk.providers.models`, for example before a screen share. Entries stay in `config.json`; a thread that names a hidden model still runs, and default model resolution keeps the full list, so a provider whose only models are custom still starts. A composer whose stored selection is hidden falls back to the provider default and records it on the next send; reselect the custom model after turning streamer mode off. |
| `allowFastServiceTier`                                                     | `true`                              | Settings → Providers. `false` hides the service tier control and runs every new turn at the default tier, including explicit requests for another tier (`fast`, Codex `ultrafast`, or any tier a provider lists), automations, and queued messages. Completed turns and project defaults saved while off keep the default tier.                                                                                                                                                                                                                |
| `managedBranchPrefix`                                                      | `bb/`                               | Settings → General → New branch prefix. Prefix for branches bb creates for worktrees and new checkout branches (`bb/fix-login-flow-thr_ab12cd34ef`); empty for none. At most 64 characters and must start a valid git branch name (no space or leading `-`). Existing branches and worktrees keep their names.                                                                                                                                                                                                                                 |
| `providerOrder`                                                            | `[]`                                | Settings → Providers (move a provider up or down). JSON list of provider ids that lead the picker, such as `'["claude-code","codex"]'`; unlisted ids follow in plugin install order and unknown ids are ignored.                                                                                                                                                                                                                                                                                                                               |
| `defaultProviderId`                                                        | `null`                              | Settings → Providers. Provider for new threads when neither caller nor project chose one; `null` means the first available provider in picker order.                                                                                                                                                                                                                                                                                                                                                                                           |
| `telemetryEnabled`                                                         | `true`                              | Settings → General → Privacy & diagnostics → Share anonymous usage data. Takes effect immediately; `BB_TELEMETRY=false` overrides it.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `earlyAdopter`                                                             | `false`                             | Settings → Experiments → Become an early adopter. Turns on experiments marked Early adopter unless you set them yourself; see [Experiments](#experiments).                                                                                                                                                                                                                                                                                                                                                                                     |
| `machineServerUrl`, `defaultMachineAccess`, `machineGitCredentialsEnabled` | See [Multi-machine](#multi-machine) | Machine access and credential forwarding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Terminal clipboard.** Settings → General → Terminals → Copy on select
(`terminalCopyOnSelect`, default `true`) copies completed terminal selections
exactly and shows a "Selection copied" notification. Selections in messages,
files, and prompt editors are unchanged. Disable it with
`bb settings general terminalCopyOnSelect off` or SDK
`system.updateGeneralSettings`, preserving the other general settings.
The server persists it across windows and restarts; older clients that omit it
preserve the saved value. Explicit Copy/Paste remain available when it is off.
On Linux browsers with native primary-selection support, middle-click focuses
the terminal and pastes the primary selection independently of this setting.
Unsupported browsers never substitute unrelated regular clipboard contents.

Older clients that omit `showGitChanges`, `keepHistoryAfterContextClear`,
`summarizeShellCommands`, or `earlyAdopter` preserve the saved value. For older SDK callers, the
general-settings API still accepts and returns `showUnhandledProviderEvents` as
a deprecated alias of `showDiagnosticEvents`, and an existing value is
preserved; when a read-modify-write payload contains conflicting values, the one
changed from the saved setting wins. Codex memory and native subagents live on
the Codex provider plugin; Claude Code's options are under
[Claude Code provider](#claude-code-provider).

**Composer keys.** The prompt box uses plain-text editing; Markdown delimiters
stay visible. Outside an open typeahead menu, Shift+Enter inserts a newline. On
coarse-pointer touch devices, the software-keyboard Return inserts a newline
and the submit button sends; iPadOS WebKit keeps the Enter and Command+Enter
shortcuts for a connected Magic Keyboard.

**Completed turn display.** The "Collapse finished turns" switches in Settings
→ Providers store `providerCompletedTurnDisplay`, a map of provider id to
`collapse` (finished work folds into one "Worked for" row and the final answer
stays visible) or `flat` (every step stays visible, as while the turn ran). A
provider without an entry uses its registration's `completedTurnDisplay`
default: Claude Code is `flat`, other first-party providers `collapse`. It
applies to existing threads, the outline, and `bb thread log`. Set it with
`bb settings completed-turns <provider-id> <collapse|flat|default>`, where
`default` removes the entry; `bb settings completed-turns` lists every
provider's current display.

**Setup guide.** A new install opens a first-run setup guide (connect an agent,
add projects, pick plugins, set up devices). `onboardingCompletedAt` records
when it was finished or skipped; `bb settings replay-onboarding`, or Settings →
General → Setup guide, clears it so the guide shows again. The projects step
lists what `bb project discover` and
`bb.sdk.hosts.experimental_discoverRepos({ hostId })` return.

**Anonymous usage telemetry.** PostHog events carry a random install id, app
version, install kind, platform, OS release, architecture, and Node version.
The server sends `app_started`, `telemetry_disabled`, `thread_created`,
`user_message_sent`, `turn_finished`, and `plugin_installed`. The app reports setup-guide and
first-send events through `POST /api/v1/system/telemetry/events`
(`sdk.system.experimental_recordTelemetryEvent`): `onboarding_started`,
`onboarding_step_reached`, `onboarding_step_completed`,
`onboarding_step_skipped`, `onboarding_finished`, `onboarding_agent_state`,
`onboarding_sign_in`, and `new_thread_submit` (started, accepted, or failed).
The route accepts only these events with fixed enums and booleans: no provider
ids, account details, prompts, project or file names, terminal output, error
messages, or session ids. Sign-in `exited` means the command exited before
readiness was observed, not that authentication succeeded; `new_thread_submit`
`accepted` means the thread was created, not that the provider answered.
By default (`BB_FF_INITIATOR_TELEMETRY=false` turns it off), `thread_created` and `user_message_sent` also carry
`initiator`: `user`, `agent`, `automation` (started by the automations
plugin), `plugin` (any other plugin), or `system` (bb's own retries and follow-ups). Sends from a plugin carry its ID (the plugin SDK adds `originPluginId`), so automation
runs into an existing thread report `automation`. `bb thread spawn` run inside a thread
sends that thread as `senderThreadId`; the new thread reports `agent` when the sender has a
turn running, and `user` otherwise.

`turn_finished` sends only `outcome` (`succeeded`, `failed`, or `stopped`),
`error_category` (`none`, `auth`, `billing`, `rate_limit`, `limit_reached`,
`provider_unavailable`, `start_failed`, `process_exited`, `host_lost`, or `other`),
`provider` (a shipped built-in provider ID, otherwise `other`), and
`install_turn_number`, in addition to the standard event properties. The stored
per-install number increments atomically on each enabled finish. It pauses while
telemetry is off and resumes at the next number when enabled again.

## AI services

Thread titles (and the branch names built from them), commit messages, and
voice transcripts come from AI services that plugins register. Each task
(`thread-title`, `commit-message`, `voice`) is `automatic` (default), `off`,
or a service id; set it in Settings → AI services or with
`bb settings ai-services set <task> <value> [--plugin <plugin-id>]` (see
`bb guide customization`). Automatic tries bb cloud (the `bb-ai` plugin, for a
signed-in bb account) first, then every other registered service supporting
the task in lexicographic order of plugin id and service id; unavailable
services and failed requests fall through. A picked service is used alone; if
it fails, titles fall back to the start of the prompt and commits to
`bb: automated commit`. `bb ai off|on` turns bb cloud off and on; see the
`bb-cloud-ai` skill.

The removed `BB_INFERENCE`, `BB_INFERENCE_FALLBACK`, and `BB_TRANSCRIPTION`
keys are ignored with a warning in `~/.bb/config.json`, and `bb-app config set`
refuses them.

bb accepts voice recordings up to 25 MB; a service may set a lower limit, and
Codex transcribes up to 20 MB and bb cloud up to 10 MB. With a ChatGPT
subscription login, Codex transcription can be blocked by Cloudflare bot
protection on some networks; run `codex login --with-api-key` on the primary
machine or pick another voice service.

Open microphone preferences by right-clicking the composer microphone, pressing
Shift+F10 while it is focused, or clicking the Microphone control in Settings →
Voice Input; desktop uses an anchored popover and mobile a drawer. Preferences
are available only while idle; the recording row contains only cancel, stop,
and send. Opening preferences starts a local microphone preview with the
recording waveform and a list of inputs; the preview is not saved or
transcribed, and closing preferences releases it.

The microphone preference is client-local: localStorage
`bb.voiceInput.audioInputDeviceId` holds the selected browser `MediaDevices`
device id. Select System default to follow system microphone changes; the
choice does not change which service transcribes. Recording tries the
preferred device, then the system default, then other available inputs for
missing or unreadable devices; permission denials do not trigger fallback. A
disconnect during recording switches the input into the same recorder,
preserving audio captured before the disconnect. A reconnected preferred
microphone is used again from the next recording; it does not interrupt the
current fallback recording.

A missing preferred microphone alone does not block recording or show a
warning. Capture failures, interrupted input, or no available inputs after
access was granted show a decorative warning badge on the idle microphone;
clicking it then opens preferences. During capture, five seconds of
near-silent audio produces a warning in the open preview or an accessible
status in the recording row. Silence warnings clear when audio returns and
never stop recording or switch microphones automatically.

## Themes

`bb theme` controls CSS-variable overrides for the app palette and typography
(see `bb guide customization`). Custom themes live at
`<bb-data-dir>/theme/<name>/theme.css`, with optional `pierre-dark.json` and
`pierre-light.json` code themes.

The typography tokens are mode-independent and belong in the `:root, .light`
block:

- `--font-sans` controls app UI and body text.
- `--font-mono` controls code blocks, diffs, file paths, and previews.
- `--font-serif` controls serif prose.
- `--font-terminal` controls the integrated terminal's font family.

Always end font stacks with a generic fallback such as `sans-serif` or
`monospace`. The complete theme token reference is in the bb-cli skill's
`references/theming.md`.

## Keyboard Shortcuts

Settings → Keyboard, `bb settings keyboard set|reset`, and SDK
`system.updateKeyboardSettings` store per-command overrides in the server
database, applied live to every window, including desktop menu accelerators.
Reset removes an override so future releases can update the default; `disabled`
unbinds a command. Overrides may be scoped to `mac`, `windows`, or `linux`. Plugin
commands bind as `plugin:<plugin-id>/<command-id>`. See
`bb guide customization` for scoping and plugin-binding rules.

`showKeyboardHints` (default `true`; `bb settings keyboard hints <true|false>`)
shows delayed shortcut badges while the modifier is held; shortcuts work
either way.

`Mod` means Command on macOS and Control on Windows/Linux. Numbered thread and
pane shortcuts follow Slack's browser-safe convention: web uses
`Control+1…9` on macOS and `Ctrl+Shift+1…9` on Windows/Linux, while desktop
uses `Mod+1…9`. The web aliases leave native browser `Mod+1…9` tab switching
untouched. Previous and next thread use `Mod+Shift+[/]` on desktop and
`Control+Shift+[/]` on the web; they follow the sidebar order.

`history.back` / `history.forward` (Go back / Go forward) do the same thing
as the sidebar's back and forward arrows: they move through the pages opened
in the current window, like browser history. They use `Mod+[` / `Mod+]` on
desktop and the web; in the browser, bb handles the key instead of the
browser's own Back while it has somewhere to go. At either end the desktop app
does nothing, while the web app leaves the key to the browser's own Back or
Forward. The commands appear in the command palette only when there is
somewhere to go, and they don't run while the in-app browser has focus.
Hovering an arrow shows its current shortcut.

On macOS, `panel.previousTab` / `panel.nextTab` default to
`Command+Control+ArrowLeft/Right` (cycling visible right-panel tabs and each
pane's New tab button), `panel.previousNewTabItem` / `panel.nextNewTabItem`
to `Command+Control+ArrowUp/Down` (on a New tab page), and
`pane.focus.left|right|up|down` to `Command+Control+Shift+Arrow…` (spatial
chat-pane focus). These start unassigned on Windows/Linux to preserve native
Control-arrow editing. `pane.focus.previous` / `pane.focus.next` and
`panel.fullScreen.toggle` start unassigned.

| Area      | Command                                      | Default                     | Availability             |
| --------- | -------------------------------------------- | --------------------------- | ------------------------ |
| Palette   | Quick palette                                | `Mod+Shift+P`               | All clients              |
| Window    | Back to app (from Settings, Plugins, Skills) | `Escape`                    | All clients              |
| Threads   | New thread                                   | `Mod+N` / `Mod+Shift+O`     | Desktop / web            |
| Threads   | Search threads                               | `Mod+K`                     | All clients              |
| Threads   | Rename focused thread                        | Unassigned                  | Thread view              |
| Threads   | Archive focused thread                       | Unassigned                  | Thread view              |
| Threads   | Previous / next thread                       | Surface defaults above      | Desktop / web            |
| Threads   | Open visible thread 1–9                      | Platform defaults above     | Web / desktop            |
| Layout    | Previous / next chat pane                    | Unassigned                  | While split              |
| Layout    | Focus chat pane 1–8                          | Platform defaults above     | Split (web / desktop)    |
| Layout    | Maximize / restore chat pane                 | `Mod+Shift+E`               | While split              |
| Layout    | Close focused chat pane                      | `Mod+Shift+X`               | While split              |
| Layout    | Toggle sidebar                               | `Mod+\`                     | All clients              |
| Window    | New window                                   | `Mod+Shift+N`               | Desktop                  |
| Window    | Find in window                               | `Mod+F`                     | Desktop                  |
| Window    | Settings                                     | `Mod+,`                     | All clients              |
| Window    | Open data directory                          | Unassigned                  | Desktop                  |
| Window    | Open local logs                              | Unassigned                  | Desktop                  |
| Window    | Show all notifications                       | Unassigned                  | All clients              |
| Plugins   | Turn plugin safe mode on / off               | Unassigned                  | All clients              |
| Panel     | New tab / close tab / toggle                 | `Mod+T` / `Mod+W` / `Mod+J` | All clients              |
| Panel     | Reopen closed tab                            | `Mod+Shift+T`               | Desktop                  |
| Workspace | Quick open file / toggle diff                | `Mod+P` / `Mod+D`           | All clients              |
| Workspace | Open terminal                                | `Mod+Shift+Enter`           | All clients              |
| Workspace | Open in preferred app                        | `Mod+O`                     | All clients              |
| Composer  | Focus composer                               | `Mod+Shift+C`               | All clients              |
| Composer  | Toggle model picker                          | `Mod+Shift+M`               | All clients              |
| Composer  | Cycle model forward / backward               | `Alt+M` / `Alt+Shift+M`     | All clients              |
| Composer  | Cycle provider forward / backward            | `Alt+P` / `Alt+Shift+P`     | All clients              |
| Composer  | Cycle reasoning effort forward / backward    | `Alt+T` / `Alt+Shift+T`     | All clients              |
| Browser   | Focus location / reload / find in page       | `Mod+L` / `Mod+R` / `Mod+F` | Desktop embedded browser |
| Questions | Choose visible answer 1–9                    | `1` … `9`                   | While a question is open |

Cycle shortcuts act only from the active composer or an open picker; other
editable controls keep their Option-composed input. Reasoning cycles through
the current model's supported efforts from low to high.

## Client SSH Targets

`~/.bb/client.json` is local to the machine showing the UI; the remote server
does not read it. It maps a server and work host to an SSH target (the value
that works after `ssh`, such as `devbox`, `user@devbox`, or a `Host` entry in
`~/.ssh/config`) so the local helper can open remote paths in local editors and
terminals. Without a helper, local editor actions are unavailable.

```bash
npx bb-app client ssh-target set https://bb.example.test devbox --host-id host_abc
npx bb-app client ssh-target list
npx bb-app client ssh-target remove https://bb.example.test --host-id host_abc
```

Use `--host-id` (from `bb machine list`) when the server has more than one
machine. Without it, `set` auto-selects the single machine and `remove` removes
every mapping for that server.

```json
{
  "servers": {
    "https://bb.example.test": {
      "hosts": {
        "host_abc": {
          "sshAuthority": "devbox"
        }
      }
    }
  }
}
```

## Provider availability

The core `disabledProviderIds` list disables individual providers by id. Change
it from a provider row's menu in Settings → Providers, `bb provider
disable|enable <id>`, or `sdk.providers.setEnabled`; a general-settings save
cannot change it. A disabled provider is hidden from pickers and
`bb provider list`, and new turns, sessions, queued messages, and automations
on it are rejected; its plugin, sibling providers, CLI, and threads are kept.
Enable removes the id, restoring automatic discovery, and enables the
supplying plugin if needed. Uninstalling a plugin forgets its providers'
disabled state. See `bb guide providers`.

## Custom ACP Agents

Add your own ACP agent through the ACP providers plugin's `customAgents`
setting, a JSON array, in Settings → Plugins → ACP providers or:

```bash
bb plugin config provider-acp set customAgents '[
  {"id": "amp", "displayName": "Amp", "command": "amp", "args": ["acp"]}
]'
```

Each entry needs `id` (lowercase letters, digits, and dashes), `displayName`,
and `command`. bb derives the provider id `acp-<id>`, which never changes once
a thread has used it. `cursor` is reserved; an entry with an id bb lists only
where the agent is installed (`opencode`, `omp`, `grok`, `hermes-agent`)
replaces the shipped agent and keeps its `nativeSkillRoots` unless it sets its
own. Optional fields: `args`, `env`, `cwd`, `modelCli` (CLI model listing and
selection), `reasoningCli` (launch-time reasoning flags), `nativeReasoning`
(ACP `session/set_config_option` reasoning), `nativeSkillRoots`
(`{"user": [...], "project": [...]}` relative paths; an entry is a path or
`{"path": ..., "recursive": true, "ancestors": true}`), `permissionCli`
(permission-mode launch flags), `supportsManualCompaction` (bb hides
`/compact` otherwise), `providerUsage`, and `dialect` (`cursor`, `opencode`,
`omp`, or `grok`).

Changes apply immediately, with no restart. A custom agent's command is local
code execution and only works with a co-located daemon. The `customAcpAgents`
key in `config.json` is no longer read. Known agents, OpenCode launch settings,
and OpenCode Go usage are covered by the `acp-provider` skill.

Agents from the official ACP registry can be added in the same settings
section or with `bb acp registry`, `bb acp add <agent-id>`, and
`bb acp remove <agent-id>`. An added agent is a `customAgents` entry running
the registry's `npx` or `uvx` package on the thread's host.

## Custom Models

Register extra picker models with top-level `customModels` in
`~/.bb/config.json`, for a model the provider accepts but does not list. There
is no set/unset CLI: edit the JSON, then run `npx bb-app config refresh` or
restart bb. `bb-app config list` prints the entries.

```json
{
  "customModels": [
    { "providerId": "claude-code", "model": "claude-example-preview" },
    {
      "providerId": "acp-my-agent",
      "model": "my-proxy/my-model",
      "displayName": "My Proxy Model"
    }
  ]
}
```

`providerId` accepts `codex`, `claude-code`, `pi`, `acp-cursor`, or any
`acp-*` provider id. `displayName` is optional. bb skips an invalid entry with
a warning. Entries appear after the provider's own catalog in the model picker
and `bb provider models`; the provider catalog wins on an id collision, and
`streamerMode` hides them. An entry only makes the id selectable:
`claude-code` and `codex` accept unlisted ids, an ACP agent can reject one at
session start, and OpenCode rejects ids outside its own catalog, so add
OpenCode models (and default agents) to the OpenCode config instead.

## Agent Instructions

bb appends user-level and workspace-level instructions to every
provider-backed thread's system prompt when a provider session starts:

- `<dataDir>/AGENTS.md` for defaults across projects.
- `<workspace>/.bb/AGENTS.md` for repo-specific guidance.

When both exist, the data-dir file comes first. An empty or whitespace-only
file is treated as absent. bb injects these itself, so they apply to every
provider; provider-native files such as a repo-root `AGENTS.md` or `CLAUDE.md`
remain separate. See `bb guide agent-configuration`.

## Skills

User-level skills live under `<dataDir>/skills/<name>/SKILL.md` (usually
`~/.bb/skills`). Project skills live under
`<workspace>/.bb/skills/<name>/SKILL.md`. Enabled plugins contribute
`skills/<name>/SKILL.md` (relocatable with the manifest's `bb.skills` field).
Project skills override user skills, which override plugin skills, by name.

All skill discovery uses the shared skills index. User roots, skill directories,
and `SKILL.md` entries may be symlinks. Project skills and Markdown commands may
follow links only within their workspace (or the repository boundary for an
ancestor root). Traversal resolves real paths and stops cycles. Each recursive
skill root reads at most 1,000 folders and each command root at most 1,000
entries; files inside skill folders do not count. Supporting files in an
injected skill tree must remain ordinary files and directories; linking the root
or `SKILL.md` is supported.

`bb skill list`, the SDK, and the Skills page collapse registrations that share a
name and identical `SKILL.md` bytes, preferring provider-neutral and user-wide
registrations. Different contents with the same name, and identical contents under
different names, remain distinct. Previously issued registration IDs still address
their original registration. Linked registrations are read-only in bb. Runtime
catalogs collapse skills with the same name and identical trees, and Claude Code
omits injected copies already visible under the same name in its native user or
project roots. Selected Codex skills are sent as structured skill inputs with the
path from Codex's active catalog, matched by catalog name or skill directory name,
for both starting and steering a turn; a selected skill missing from that
catalog is sent as plain text only.

Top-level `sharedSkillRoots` in `~/.bb/config.json` adds one provider-neutral
skill collection: `{"user": [...], "project": [...]}` relative paths, resolved
from the home directory and the workspace. bb indexes them read-only and
injects selected skills into every provider; bb user and project skills win on
a name collision. Apply edits with `npx bb-app config refresh`.

bb also indexes each provider's native skill roots for that provider's `/`
menu, the Skills page, and `bb skill list`. The shipped provider plugins
declare:

| Provider     | User roots                                                                                               | Project roots                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Codex        | `~/.agents/skills`, `$CODEX_HOME/skills`                                                                 | `.agents/skills` from the repository root to the current directory, plus `.codex/skills`                     |
| Claude Code  | `$CLAUDE_CONFIG_DIR/skills` or `~/.claude/skills`, plus enabled plugin skills                            | `.claude/skills` from the repository root to the current directory, plus enabled plugin skills               |
| Pi           | `~/.pi/agent/skills`, `~/.agents/skills`                                                                 | `.pi/skills` in the workspace; `.agents/skills` from the repository root to the current directory            |
| Cursor       | `~/.cursor/skills`, `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`                            | The same four roots in the workspace                                                                         |
| OpenCode     | `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`                                      | `.opencode/skills`, `.claude/skills`, and `.agents/skills` from the repository root to the current directory |
| omp          | The active `~/.omp/.../agent` roots and supported Pi, Agents, Claude, Codex, and OpenCode roots          | `.omp/skills` and the supported compatibility roots from the repository root to the current directory        |
| Grok Build   | `$GROK_HOME/skills` or `~/.grok/skills`, plus `~/.agents/skills`, `~/.claude/skills`, `~/.cursor/skills` | The same four roots from the repository root to the current directory                                        |
| Hermes Agent | `$HERMES_HOME/skills` or `~/.hermes/skills`                                                              | None                                                                                                         |

OpenCode also uses `$OPENCODE_CONFIG_DIR/skills`. Pi and omp use
`$PI_CODING_AGENT_DIR`; omp selects its profile with `$OMP_PROFILE` or
`$PI_PROFILE`. Cursor and Hermes roots are scanned recursively, and Pi finds
skills at any depth under its roots. Pi settings
and packages, omp's `skills.customDirectories`, Hermes' `skills.external_dirs`,
and Grok's `[skills].paths` in `config.toml` add paths; Grok also reads enabled
Grok and Claude-compatible plugin skills.

## Multi-machine

Multi-machine execution lets this server dispatch work to host daemons on
other machines; it is independent of browser access (Tailscale, bb connect).
Add, rename, and remove machines in Settings → Machines; see
`bb guide machines` for the CLI.

**Permission ceiling.** Each machine has `maxPermissionMode` (default `full`).
Every thread on that machine is resolved down to the ceiling, and a provider
that supports no mode under it is refused there. Only an owner session sets it,
on the machine's page in Settings → Machines; it is deliberately absent from
the SDK and CLI, and machine credentials cannot change it. Read it with
`bb machine list --json`.

**Machine server access.** `machineServerUrl` (Settings → Machines → Server URL
reachable by machines; HTTP or HTTPS without embedded credentials) falls back
to `BB_EXTERNAL_URL` when unset. `defaultMachineAccess` selects the access
provider; unset selects bb connect, and `direct` (Manual) uses your own URL.
An explicit provider must be installed and available. Set them with
`bb settings general machineServerUrl <url-or-null>` and
`bb settings general defaultMachineAccess <provider-id-or-null>`.

**Daemon updates.** Machines install the host package from the owning server
(falling back to npm only when the server has no package route) under the
machine's bb data directory, so enrollment needs no `sudo`. Installed services
run with `--auto-update`: daemons follow newer server protocols, never
downgrade, and retry failures with backoff from 5 seconds to 5 minutes. Remove
the flag from the launchd plist or systemd user unit and reload the service to
opt out.

### Machine installer

`BB_DATA_DIR` on the installer selects the machine's state directory instead of
`~/.bb-machines/<server-host>`. Enrollment refuses the default `~/.bb` unless its
`host-id` already names this machine.

On Linux the installer installs a persistent systemd user service, retrying with
the runtime path from `loginctl` when the user bus is unavailable and failing
before enrollment if it still cannot reach it. In containers and on machines
without systemd as init it runs a detached daemon instead. Set
`BB_INSTALL_SKIP_SERVICE=1` on the installer command only when running without a
service is intentional; nothing then restarts the daemon after a reboot.

The installer writes these `config.json` fields; they are managed by bb, not
user knobs. Do not copy, edit, or commit them, and re-add the machine instead of
changing them:

- `serverUrl`: the server this machine belongs to.
- `serverHeaders`: private request headers from the access provider, passed to
  the daemon and its bundled `bb` CLI through `BB_SERVER_HEADERS` (a JSON
  string map) for enrollment, HTTP, WebSocket, and proxy requests.
- `machineCredential` and `connectMachineId`: the legacy bb connect form;
  `machineCredential` is sent as the `x-bb-connect-machine` header.

These secret fields are omitted from `bb-app config list`.

The Settings → Machines installer assigns each standalone daemon a stable local
API port, persisted in the machine data directory; its command accepts
`--host-daemon-port <port>` when an explicit port is needed.

### Machine environment

Settings → Environment variables (scope All projects or one project) and
Project settings → Advanced settings edit encrypted environment variables for
machines. Global values sync into every host daemon, including the primary
host. Project values follow the project across machines and worktrees and are
passed only to operations core runs for that project: agent turns, source
clones, setup/teardown hooks, and new terminals. Plugin host calls receive
global values only.

Precedence: built-in credentials, then global variables, then project
variables; agent-provider contributions win over all of them. An empty string
is an explicit override; deleting a project override restores the inherited
value. Existing terminals keep their launch environment, and agent turns pick
up changes on their next turn.

Values are encrypted with the key in `<dataDir>/machine-environment-key`; back
it up with the database. Names and notes are public metadata, and settings
APIs never return values. CLI: `bb machine env list|set|unset [--project <id>]`
(set reads the value from stdin); SDK: `sdk.system.machineEnvironment` and the
matching `sdk.projects` methods. See `bb guide machines`.

**GitHub credential forwarding.** `machineGitCredentialsEnabled` (default
`true`; the automatic GH_TOKEN switch in Settings → Environment variables)
forwards the server's `gh` login to non-primary hosts as `GH_TOKEN`, a Git
credential helper and SSH URL rewrites for github.com, and author/committer
identity, without installing helper files or global Git config. The primary
host keeps its local Git authentication; a server without a local host daemon
has no primary host, so every machine receives the token. An explicit global or
project `GH_TOKEN` overrides the built-in token. Changes apply to new turns,
setup commands, and terminals.

## Sidebar preferences

Core sidebar and Info panel layout preferences live in a server-side keyed registry shared by every
window, device, and the CLI. Each key has a typed schema, a default, and a
revision; a write that names a stale revision gets `409
ui_preference_conflict`. Read and write them with `bb settings ui
list|get|set|reset` or `sdk.system.uiPreferences` (see
`bb guide customization`).

| Key                           | Value                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sidebar.threadListProvider`  | Plugin key or `__automatic__` (default): the first installed thread list plugin other than the bundled `thread-list/thread-list`, else the bundled one |
| `sidebar.navigationProvider`  | Plugin key or `__automatic__` (default): the first navigation from a plugin other than the bundled Navigation plugin, else its `navigation/rail`       |
| `sidebar.pluginPanelOrder`    | Navigation destination order                                                                                                                           |
| `sidebar.visiblePluginPanels` | Navigation destinations shown, or `null` for every destination                                                                                         |
| `sidebar.footerOrder`         | Footer action order                                                                                                                                    |
| `sidebar.hiddenFooterItems`   | Footer actions moved into More                                                                                                                         |
| `infoPanel.collapsedSections` | Collapsed thread Info panel sections (`commits`, `uncommittedChanges`, `childThreads`, `forks`, `threadStorage`, or `<pluginId>/<sectionId>`)          |

A legacy `__builtin__` thread list selection resolves to the bundled plugin.
Footer IDs are `builtin:settings` (top list layout only), `builtin:mobile`,
`builtin:report-bug`, and
`plugin:<encoded pluginId>/<encoded registrationId>`; unknown and
disabled-plugin IDs are retained, and new actions default to visible. The
footer can also be edited from its More menu or Settings → Appearance → Sidebar
footer.

The bundled Navigation plugin draws the navigation. Its default layout,
`navigation/rail`, is a vertical rail on the left edge of the sidebar that holds Home (the last thread),
the visible destinations (Plugins, Skills, plugin panels), More (hidden
destinations and Customize navigation), and Settings at the bottom. New thread sits
in the sidebar header and cannot be hidden from the rail. The list beside the rail swaps
between the thread list, Plugins, Skills, and Settings; collapsing the sidebar
leaves only the rail. On narrow windows and phones the rail sits inside the
drawer. In the macOS desktop app, wide windows add a title bar with the window
controls, Back and Forward, and the sidebar toggle.

With `sidebar.navigationProvider` set to `navigation/top-list` (Settings →
Appearance → Navigation), there is no rail. The visible destinations, New
thread among them, and More (hidden destinations and Customize navigation) are
labeled rows above the thread list, with plugin panel badges at the end of
their row. New thread can be reordered and hidden like any other row.
Settings is a footer action, and the Settings, Plugins, and Skills lists start
with a Back to app row. Collapsing hides the whole sidebar, and the macOS
desktop app keeps the window controls over the sidebar instead of a separate
title bar. A navigation plugin gets the rail or list layout its registration
declares, and a list navigation can bring its own controls beside the sidebar
toggle; legacy `__builtin__` and `navigation/navigation` read as
`__automatic__`. Disabling the Navigation plugin with no other navigation
plugin installed leaves the list layout with no destinations; Settings stays
in the footer.

The layout keys `sidebar.organizationMode`, `sidebar.threadGrouping.environment`,
`sidebar.chronologicalSort`, `sidebar.sortDirection`, the three section-order
keys, and `sidebar.hiddenGroups` are legacy: the
bundled Thread list plugin copies non-default values once and then keeps its
own preferences ([Thread list plugin](#thread-list-plugin)).

Sidebar width and open state stay in each browser tab or desktop window; a new
window starts from the most recent choice in that browser. The command
palette's Active/Archived filter is browser-local and has no CLI/SDK setting.

## Experiments

Experimental surfaces are changed in Settings → Experiments or with
`bb settings experiment <key> <true|false>`. All experiments start off.
bb stores only the experiments you set; the others follow the shipped default.

The `earlyAdopter` general setting (the Become an early adopter banner on
Settings → Experiments, `bb settings general earlyAdopter on`) switches the
shipped default to the early adopter default: experiments marked Early adopter
(currently `timelinePush`, `compactExpiredCache`, and `sidebarMultiSelect`) turn on, and the rest stay
off. An experiment you set yourself keeps your value either way.
`/system/config` and `sdk.system.config()` return the resolved values in
`experiments`.

- `changelogPreview` shows the latest release notes as a dismissible card on
  Settings → Updates.
- `compactExpiredCache` (on for early adopters) reports `compactionOfferAt` on a thread's context
  usage (timeline `contextWindowUsage` and `bb thread context`) once the
  provider has reported a prompt-cache lifetime, the provider supports manual
  compaction, and the context holds at least 100k tokens. After that time the
  composer shows a Compact chip beside the context meter; while it is on, the
  next send passes `compactFirst` so the server runs `/compact` and queues the
  message behind it. Clicking the chip keeps the full history for that one
  send.
- `serverMove` enables Move server here in Settings → Machines,
  `bb server move`, `bb server export`, and old server copy deletion; while off
  those routes return 403 `server_move_experiment_disabled` (status and cancel
  stay available). See `bb guide machines`.
- `performanceDiagnostics` turns on server performance diagnostics: slow
  database, API, and event-loop logging, periodic performance samples, and
  continuous V8 CPU profiles written every 30 seconds to
  `<dataDir>/logs/performance/`. Profiles are kept for 12 hours with a 1 GB
  total cap (oldest first), and a profile over 12 MiB is discarded. It needs
  startup permission from `BB_PERF_DIAGNOSTICS=1` or the launcher flag
  `--perf-diagnostics` (`pnpm start`, `pnpm start:worktree`, `bb-app`), which
  requires a restart; without it the toggle is hidden and cannot start
  collection. The experiment itself applies live; turning it off restores
  normal logging and flushes the in-flight profile, keeping saved files. See
  [diagnostics](debugging-and-qa.md#opt-in-server-performance-diagnostics).
- `sidebarMultiSelect` (on for early adopters) lets the built-in thread list
  select several threads: Cmd/Ctrl+Shift-click toggles a row (starting from the
  open thread), Shift-click selects the visible range from the last clicked row,
  and a plain click, Cmd/Ctrl-click, Escape, or a click outside the sidebar
  clears the selection.
  Right-clicking a selected row offers Mark read/unread, Pin/Unpin, Move to
  section, and Archive for the whole selection. Dragging a selected row moves
  every selected thread onto a section, under a thread, or into Pinned, or drops
  them onto a composer as one mention per thread. Cmd/Ctrl-click still opens a
  thread in a split. Plugins read it with
  `experimental_useExperiment("sidebarMultiSelect")`.
- `timelinePush` makes an open thread view subscribe to its latest timeline
  window over the WebSocket (`thread-timeline` subscription target); the server
  pushes the full window once, then row deltas after new events, instead of the
  client refetching the latest window after every update. A missed push falls
  back to the delta request used when it is off. Open views follow a toggle
  live.

## Thread Timeline Window

`BB_FF_TIMELINE_WINDOW_EVENT_BUDGET` (default 1500) guides how many
conversation groups a timeline page selects and caps the content leaves it
returns. It is a server-start operator setting, not a hard limit on query
bytes, events, or CPU: one large turn can need substantially more work. Pages
target 4 MiB of rendered rows. The API and SDK contract is in
[timeline-pagination.md](timeline-pagination.md).

Timeline builds slower than 150 ms log `Thread timeline build blocked the event
loop`, and event-loop stalls over 500 ms log `Event loop stalled`, both at
`info`.

## Plugins

Plugins are on by default. Builtin plugins ship with bb; the official plugins
(GitHub, Docs, Memory, Tasks) ship bundled in the app, install from that copy
without network access, and update with bb releases. See `bb guide plugins` for
installing, sources, updates, and marketplaces, and the `bb-plugin-authoring`
skill for manifests and `engines` ranges. Plugins are full-trust code running
inside the bb server process.

Plugin state lives under the data dir:

```
<dataDir>/plugins/<id>/data.db     Per-plugin SQLite database
<dataDir>/plugins/<id>/secrets/    Secret settings and the plugin HTTP token
<dataDir>/plugins/<id>/logs/       bb.log output (plugin.log, JSONL, rotated
                                   at 5MB; read with `bb plugin logs <id>`)
<dataDir>/plugins/git/, npm/       Managed installs for git:/npm: sources
<dataDir>/marketplaces/staging/    Throwaway checkouts for git: marketplace
                                   refreshes
<dataDir>/skills-generated/        Server-generated skills (the
                                   plugin-commands skill)
```

Marketplace catalogs live in the bb database. The reserved `bb-community`
marketplace comes from `BB_MARKETPLACE_URL`. A `git:` marketplace reads
`marketplace.json` from the repository root, or from the directory saved with
`bb marketplace add --subdirectory <relative-path>`. The server checks installed
plugins for updates every 6 hours but never applies them.

Plugin settings are changed on the plugin's page under Settings → Installed
plugins, with `bb plugin config <id> set <key> <value>`, or with SDK
`plugins.updateSettings({ pluginId, values })`. Running plugins receive changes
live.

### Multi-plugin repositories

An optional `.bb/plugins.json` collection manifest at a repository root
indexes several plugins, each a directory with its own `package.json` and `bb`
manifest:

```json
{
  "$schema": "https://getbb.app/schemas/plugins.schema.json",
  "schemaVersion": 1,
  "name": "acme-plugins",
  "plugins": [
    { "name": "notes", "source": "./plugins/notes" },
    { "name": "status", "source": "./plugins/status" }
  ]
}
```

The file is strict: `schemaVersion` must be `1`, names match
`^[a-z0-9][a-z0-9-]*$`, unknown fields and duplicate names are rejected, and
each `source` is a repository-relative directory starting with `./` (absolute
paths, `..`, empty segments, and the repository root are refused). An invalid
file is rejected whole. It is an index only and never overrides a plugin's
identity, branding, entry points, or engine ranges. Select an entry with
`bb plugin install … --plugin <name>`.

### BB guide

BB guide is installed and enabled by default. Its boolean settings, all
default `true`, are `introduction` (the BB introduction), `skills` (all four
bundled skills), and `bbCli`, `pluginAuthoring`, `skillCreator`, and
`submitPlugin` (individual skills). They apply the next time agent
configuration is assembled. Disabling the plugin removes its introduction and
skills.

### Claude Code provider

| Setting            | Default | Effect                                                                                                                                                                                                                                                                |
| ------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disable1MContext` | `false` | Sets `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` (`0` when off).                                                                                                                                                                                                               |
| `chromeEnabled`    | `false` | Starts Claude Code with `--chrome` for Claude in Chrome tools, which bb otherwise leaves off even when the interactive `claude` CLI enables them; the host needs the extension and a claude.ai login (API-key sessions stay off).                                     |
| `artifactsEnabled` | `false` | Sets `CLAUDE_CODE_ARTIFACT=1` so Claude Code loads its Artifact tools (read, publish, and edit claude.ai artifacts), which it withholds from SDK sessions by default; when off, bb leaves any inherited value alone. Claude may publish private pages without asking. |
| `sandboxEnabled`   | `true`  | Runs Bash in Claude Code's sandbox in Accept Edits and Approve for me modes; `false` uses Claude Code's own approvals and sandbox settings.                                                                                                                           |

Set them with `bb plugin config provider-claude-code set <key> <value>`. A
change restarts the thread's Claude process before its next turn, keeping the
conversation. Memory, native subagents, and the Workflow tool are toggled on
the provider's page in Settings → Providers (see `bb guide providers`).

Two host-daemon environment variables reach the Claude Code bridge:
`BB_CLAUDE_CODE_EXECUTABLE` picks the `claude` binary, and
`CLAUDE_CODE_OAUTH_TOKEN` authenticates a machine with no interactive login,
such as a CI runner (mint it with `claude setup-token`). See the
`claude-code-provider` skill.

### Account Pooler [Experimental]

The builtin Account Pooler plugin pools Claude and Codex accounts behind the bb
server. It is disabled on fresh installations (`bb plugin enable
account-pool`), except that a nested server with `BB_ACCOUNT_POOL_PARENT_URL`
enables it. Account tokens and per-machine hub tokens are 0600 files under
`<dataDir>/plugins/account-pool/secrets/accounts/`.

| Setting                    | Default                                 | Effect                                                                                     |
| -------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `switchThreshold`          | `0.98`                                  | Shared or model-family quota fraction at which an account stops receiving matching traffic |
| `anthropicUpstreamBaseUrl` | `https://api.anthropic.com`             | Upstream for Claude traffic; only for tests and QA with a fake upstream                    |
| `codexUpstreamBaseUrl`     | `https://chatgpt.com/backend-api/codex` | Upstream for Codex traffic; only for tests and QA with a fake upstream                     |

Inspect and change them with `bb pool config` and
`bb pool config set <key> <value>`. Values stored through `bb.settings` by
older builds are not migrated. Provider routing is persisted per provider and
defaults on; `bb pool routing <claude|codex> --off` stops it. See the
`account-pool` skill for accounts, ordering, and routing.

### Concurrency limit

The builtin Concurrency limit plugin caps running threads. The overall limit is
unlimited by default; each host defaults to Auto (one thread per available
processor), a blank host field restores Auto, and `0` pauses new work for that
scope. Configure it on its autosaving plugin page or with
`bb concurrency-limit status|global|host`; see the `concurrency-limit` skill.

### Keep Awake

The builtin Keep Awake plugin prevents idle system sleep on selected macOS and
Windows hosts while bb runs; on macOS it runs
`/usr/bin/caffeinate -i -w <worker-pid>`. Closing the lid or choosing Sleep
still sleeps the machine. Its settings are an enable switch and an
all-or-selected host list, set on its autosaving plugin page or with
`bb keep-awake status|enable|disable` and `bb keep-awake hosts all|<host-id>...`
(each accepts `--json`).

### Push notifications

The builtin Push notifications plugin's `mobileEnabled`, `webEnabled`, and
`desktopEnabled` booleans default to `true`. `expoPushUrl` (default
`https://exp.host/--/api/v2/push/send`) is the relay URL, read on every send.
`defaultLevel` (default `all`) and `childLevel` (default `input-only`) set
top-level and child thread levels. Set them with
`bb plugin config push-notifications set <key> <value>`. Web and desktop
notifications need an open bb tab or window, HTTPS or localhost, and
per-device permission; the plugin's settings page offers permission and test
controls. See the `push-notifications` skill for levels, devices, and
`bb push-notifications test|thread`.

### Storage & retention

The bundled Storage & retention plugin is disabled by default
(`bb plugin enable bb--storage-retention`). Configure it in its sidebar panel,
where every setting saves immediately, or with `bb storage retention`, which
previews until `--save --yes`. It keeps its policy and latest run in its own
storage; there are no general app settings for retention.

| Setting                                              | Default | Flag                                                                          |
| ---------------------------------------------------- | ------- | ----------------------------------------------------------------------------- |
| Archive after / delete after                         | Never   | `--archive-after <days\|never>`, `--delete-after <days\|never>` (1–3650 days) |
| Delete thread storage on archive                     | Off     | `--delete-storage-on-archive <true\|false>`                                   |
| Delete development data when its checkout is removed | Off     | `--delete-dev-data-on-checkout-removal <true\|false>`                         |

Archive eligibility uses each affected member's `updatedAt`; deletion requires
every lifecycle member to have been archived past the cutoff. The plugin uses
the SDK thread listing and archive/delete APIs, accepting changes between
inspection and mutation, and disabling it stops retention without losing the
saved policy. Development-data cleanup stores no removal history in the core
database. The plugin owns the disk scanner, cached reports, classification,
and host-worker file operations behind `bb storage usage` and the cleanup
commands; background cleanup started from the page survives navigation and
reconnects. See the
[plugin skill](../plugins/storage-retention/skills/storage-retention/SKILL.md).

### Ask User Question plugin

The builtin Ask User Question plugin keeps an unanswered question card open for
30 minutes by default. When it expires, the agent receives a timeout result and
the card closes. Choose `1 hour`, `4 hours`, `8 hours`, `24 hours`, `3 days`, or
`7 days` under the plugin settings, or configure it from the CLI:

```bash
bb plugin config ask-user-question set questionTimeout "24 hours"
```

The setting applies to questions asked after it changes. A server restart still
closes every open card.

### Provider retry plugin

The builtin Provider retry plugin is enabled on fresh installations. It queues
a retry after Codex and Claude Code subscription-window limits that report a
reset time, and retries provider overloads with backoff. `maximumWait`
(`6 hours` default, `24 hours`, or `No limit`) skips scheduling resets beyond
that horizon:

```bash
bb plugin config provider-retry set maximumWait "24 hours"
```

Disable it with `bb plugin disable provider-retry`. See the `provider-retry`
skill.

### Workflows plugin

The builtin Workflows plugin is disabled on fresh installations
(`bb plugin enable workflows`). Its settings are bounded integers:

| Key                    |    Default |       Allowed range | Behavior                                               |
| ---------------------- | ---------: | ------------------: | ------------------------------------------------------ |
| `maxActiveRuns`        |        `4` |            `1`–`32` | Concurrent runs across the plugin; changes apply live. |
| `maxConcurrentAgents`  |        `8` |            `1`–`64` | Concurrent agent calls within one run.                 |
| `maxAgentCalls`        |      `100` |          `1`–`1000` | Total agent calls within one run.                      |
| `totalRunTimeoutMs`    | `86400000` | `60000`–`604800000` | Maximum total run duration in milliseconds.            |
| `retentionDays`        |        `7` |          `1`–`3650` | Days to retain completed workflow data.                |
| `maxNotificationBytes` |    `16384` |     `1024`–`262144` | Maximum UTF-8 size of a completion notification.       |

The settings other than `maxActiveRuns` are snapshotted into each new run. See
the `workflows` skill.

### Thread list plugin

The bundled Thread list plugin owns the sidebar thread list layout, synced to
every window. Change it from the list header's Organize and Filter menus, a
row's Customize actions, or `bb thread-list prefs get|set|reset <key>`
(`set` takes JSON; a bare word is a string). See the `thread-list` skill.

| Key                   | Default                           | Values                                                                                                                                      |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizationMode`    | `chronological`                   | `project`, `chronological` (Custom), or `machine`                                                                                           |
| `environmentGrouping` | `auto`                            | `true` collapses sibling threads sharing a worktree into one row, `false` never does, `auto` groups except in `chronological`               |
| `groupByReadStatus`   | `false`                           | Lists unread threads above the rest; exclusive with environment grouping                                                                    |
| `chronologicalSort`   | `updated`                         | Sort field for `chronological`                                                                                                              |
| `sortDirection`       | `default`                         | `default`, `ascending`, or `descending`                                                                                                     |
| `sectionOrder`        | `["pinned","projects","threads"]` | Top-level order by project; `manualSectionOrder` and `machineSectionOrder` cover the other modes                                            |
| `hiddenGroups`        | `[]`                              | Groups moved into More: `threads`, `project:<id>`, `section:<id>`, `machine:<hostId>` (`machine:no-machine`); `set` replaces the whole list |
| `threadLifecycles`    | `["active"]`                      | `["active"]`, `["archived"]`, or both; empty and duplicate values are rejected                                                              |
| `rowActions`          | `["bb--core/archive"]`            | Up to three thread action keys in display order; see below                                                                                  |
| `showProviderIcons`   | `false`                           | Shows the provider icon before each thread title                                                                                            |
| `collapsed*`          | `[]`                              | Collapsed sections, projects, threads, environments, custom sections, and machines                                                          |

`rowActions` keys are `bb--core/<id>` (`split`, `newThreadInEnvironment`,
`copyLink`, `read`, `pin`, `rename`, `archive`, `delete`), `thread-list/move`,
or a plugin's `<pluginId>/<actionId>`. Bare legacy ids and `core/<id>` keys
migrate to current keys. A key whose action is hidden for a row, or whose
plugin is not installed, is skipped on that row.

### Connect and bb account

Remote access makes this server reachable at `https://<handle>.getbb.app` once
it is signed in to a getbb.app account. The builtin bb account plugin holds the
server credential in its plugin KV (in `bb.db`); the builtin connect plugin
holds the tunnel while the server runs. See the `bb-account` skill for signing
in and the `share-server-links` skill for `bb connect` and port shares.

| Connect setting          | Default | Effect                                                                                                                 |
| ------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `remoteAccess`           | `true`  | The Remote access switch; `false` closes the tunnel and machine shares without signing out. Also `bb connect off\|on`. |
| `sendRemoteInstructions` | `true`  | "Tell agents about remote access"; `false` suppresses Connect's remote-use agent message without disabling sharing.    |

`bb plugin disable connect` cuts off all remote access. `--server` and
`--base-url` on `bb connect` and `bb account login` accept only
`https://getbb.app` and `https://vibecodethis.site` (plus
`http://bb.localhost:<port>` in a development build).

Settings → Mobile links the iOS TestFlight and Android APK downloads and pairs
the bb mobile app (`bb connect machine-code`, see `bb guide machines`). Mobile
builds, the optional `GOOGLE_SERVICES_JSON` Firebase config, and publishing
are documented in [`apps/mobile/README.md`](../apps/mobile/README.md).

### Connect next (beta)

The builtin connect-next plugin is disabled by default. Enabled
(`bb plugin enable bb--connect-next`) and switched on, it also makes this server
reachable at `https://<label>.next.getbb.app` through the Fly gate, next to
its connect address. The domain follows the bb account: `next.<host of the
account's base URL>` (`next.vibecodethis.site` on staging). While it is on,
every enrolled machine's daemon also serves the ports shared from it with
`bb connect expose <port> --host <machine>` at
`https://<machine-label>--<port>.next.getbb.app`, downloading `frpc` into
`<daemon data dir>/connect-next/frp/`. See the `connect-next` skill and
[`connect-next.md`](connect-next.md).

| Connect next setting | Default | Effect                                                                      |
| -------------------- | ------- | --------------------------------------------------------------------------- |
| `enabled`            | `true`  | "Reach this bb at its next address (beta)". Also `bb connect-next on\|off`. |

| Variable                 | Effect                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `BB_CONNECT_FRPC`        | Path of an `frpc` binary to run instead of the frp 0.71.0 release the plugin (or a host daemon) downloads and verifies.           |
| `BB_CONNECT_NEXT_SERVER` | `ws://host:port` or `wss://host:port` of the frp server to dial instead of `wss://tunnel.<next domain>` derived from the account. |

### Modal machines

The Modal sandbox plugin creates machines on Modal. Its settings:
`tokenId` and `tokenSecret` (secret; a Modal API token), `appName` (default
`bb-sandboxes`), and `idleMinutes` (default 15; `0` disables idle suspension,
maximum 1440). Sandboxes run for at most Modal's 24-hour sandbox lifetime.
Without a size preset, a new machine reserves 1 CPU and 2 GiB. The plugin page
also holds named image definitions (the bundled Standard Dockerfile, extra
Dockerfiles, or Modal image IDs) and CPU/memory presets; a saved image applies
to the next new machine. See the `modal-sandboxes` skill.

### Browser Automation

The Browser Automation plugin installs its pinned `dev-browser` release on
first use on each browser host, under the plugin's host storage directory; it
never modifies the user's global npm installation. See the
`browser-automation` skill and `plugins/browser-automation/README.md`. For
isolated development smoke tests only, `DEV_BROWSER_SMOKE_BINARY` and
`DEV_BROWSER_SMOKE_CHROME` select absolute binary and Chrome paths.

### MCP server

The bundled MCP server plugin is disabled by default; enable it with
`bb plugin enable bb--mcp`. It serves a Model Context Protocol endpoint at
`/mcp` on the bb connect address and at `/api/v1/plugins/bb--mcp/http/mcp` on
loopback (`bb mcp status` prints both). Remote apps sign in through the bb
account, and an approved app can run any `bb` command; `bb mcp clients` lists
them and `bb mcp revoke <grant-id>` disconnects one. The loopback address needs
no sign-in and has the same trust as the local `bb` CLI. See the `mcp` skill.

## Desktop browser cookie discovery

The desktop app discovers Chromium and Firefox cookie stores of registered web
browsers with no setting. On Linux, an absolute `XDG_CONFIG_HOME` in the
desktop process environment replaces `~/.config` for discovery (relative values
are ignored), and Flatpak and Snap data directories are also searched. See
`bb guide browser` for the import commands.

## Startup Flags

Use launcher flags for per-run startup details:

```bash
npx bb-app --data-dir ~/.bb-test --server-port 48886 --host-daemon-port 48887
```

The server listens on `127.0.0.1` by default. Set
`--server-bind-host 0.0.0.0` (or `BB_SERVER_BIND_HOST=0.0.0.0`) only when a
trusted network boundary must reach the listener directly: the public API is
unauthenticated and permits command execution and file reads. The only
accepted bind hosts are `127.0.0.1` and `0.0.0.0` (IPv4 only); containers must
also publish the port. With wildcard binding the startup `Server listening`
and `app` lines show `http://0.0.0.0:<port>`.

The data directory holds all bb-managed state: the SQLite database, logs, host
identity, thread storage, custom themes, and plugins. It defaults to `~/.bb/`
for the packaged app. Use `--data-dir` for fully isolated instances.

Other launcher flags: `--no-in-app-updates` ([In-App Updates](#in-app-updates))
and `--perf-diagnostics` ([Experiments](#experiments)).

## Source Development

`pnpm mobile:apk:dev` builds the standalone Android development app, **bb dev**,
with orange icons and package `app.getbb.mobile.dev`. Output is
`apps/mobile/build-output/bb-dev.apk`; append `-- x86_64` for an Intel emulator.
The build command sets `BB_MOBILE_VARIANT=dev` for Expo configuration. Direct
Expo commands accept `BB_MOBILE_VARIANT=production` (the default) or `dev`;
other values fail validation. The dev variant omits production Firebase and
HTTPS app-link registration. See [mobile build instructions](../apps/mobile/README.md#android-local-apk-and-verification).

For source development only, `pnpm dev`, `pnpm start:worktree`,
`pnpm start:worktree-remote`, and `pnpm start` load the repo-root
[dotenv-cli](https://github.com/entropitor/dotenv-cli) cascade. Add a repo-root
`.env` only to override the defaults above.

- `pnpm dev` loads `.env`, `.env.local`, `.env.development`, and
  `.env.development.local`, then overrides `BB_DATA_DIR`, the server URL and
  port, the host-daemon port, and the Vite port with values derived from the
  checkout path. The data directory is `~/.bb-dev/<checkout-instance>/`, where
  the instance id is the sanitized checkout path relative to your home
  directory plus a short hash. The server and Vite bind to loopback; an
  explicit `BB_DEV_APP_HOST` overrides the Vite listener, and remote HTTP dev
  through it also needs `BB_SERVER_BIND_HOST=0.0.0.0` for realtime updates.
  It defaults `BB_SKIP_ONBOARDING` to `1`, so new instances skip the first-run
  setup screen; set `BB_SKIP_ONBOARDING=0` to retain setup or replay it from Settings.
- `pnpm start:worktree` loads the same cascade and checkout-specific data
  directory and ports, builds production artifacts, and serves the bundle from
  the main server (no Vite or hot reload). Telemetry stays disabled and
  first-run setup is skipped, as with `pnpm dev`. Its data
  directory, ports, inherited skills, listener host, and telemetry policy take
  precedence over that instance's `config.json` or `env.json`.
- `pnpm start:worktree-remote` does the same but binds the main server to
  `0.0.0.0`; protect the port with a trusted network boundary.
- `pnpm start` loads `.env`, `.env.local`, `.env.production`, and
  `.env.production.local`, and uses the packaged launcher policy with build
  outputs from `apps/app`, `apps/server`, and `apps/host-daemon`.
- `--dryrun` on `pnpm start` or `pnpm start:worktree` prepares through Turbo,
  prints the resolved ports and paths, and exits without starting services or
  migrating data. See [Prepared Worktree
  Restarts](debugging-and-qa.md#prepared-worktree-restarts).

`pnpm dev` injects `BB_DEV_CONNECT_BASE_URL=http://bb.localhost:<worktree-cloud-port>`
(`pnpm dev --staging` injects `https://vibecodethis.site`). With
`NODE_ENV=development`, the bb account plugin uses it as the sign-in default
and the connect plugin for its signed-out dashboard link. It is
launcher-managed, not a `bb-app config` setting, and packaged builds keep
`https://getbb.app`.

`pnpm bb`, `pnpm bb:dev`, and `pnpm reset` wrap `@bb/scripts` and force
`NODE_ENV` to the intended mode. `pnpm reset` and `pnpm reset:dev` clear
bb-managed state in a data directory, not provider credentials.

`BB_PROVIDER_BRIDGE_RECORD_DIR=<dir>` in the host daemon's environment records
every provider bridge's wire traffic as NDJSON under
`<dir>/<providerId>/<threadId>/`; it is off by default and never reaches a
provider child. Recordings can contain secrets; redact them with
`scripts/provider-recordings/redact.mjs` before sharing. See
[provider-bridge-protocol.md](provider-bridge-protocol.md) and
[debugging-and-qa.md](debugging-and-qa.md).

App production builds cache React Compiler output at
`<git-common-dir>/bb-cache/react-compiler`; it has no configuration and can be
deleted while no build runs.

Desktop Settings → Server → **Show This Mac** (or **Show This Computer** off macOS)
defaults to checked and is disabled while This Mac/Computer is selected.
Unchecking hides the built-in server from server choices
while another server is active and alternatives exist. It stays listed when
active or when it is the only choice. This setting does not stop the local
runtime or change the active server.

The desktop stores `showBuiltinServer: false` in `<userData>/server-target.json`;
missing means shown, and saving the default omits the field. Other top-level
metadata is preserved. This is a desktop-local preference, with no server
settings CLI/SDK endpoint. Builds with tolerant readers ignore the field and
may drop it on save; older strict readers can reject the whole file, so keep a
backup before rolling back to a build predating the tolerant-reader fix #5286.

Personal thread execution is exposed through `/control-plane/user/threads` and
`createControlPlaneClient(...).threads`, using the same opaque user credential
as project access. Start accepts only project ID, approved profile-version ID,
message and optional title. No UID/HOME/cwd/environment/provider/model override
is accepted. Send queues during an active turn; stop, paged events, current
result and native approval/question resolution are scoped to persisted ownership
and current project access. New actions also require the current profile grant.
The SDK's `threads.events` reads persisted event pages, not a live stream.
`threads.result` reports the latest assistant text and current status.

Native project-checkout provisioning gets a private, temporary SDK read scope:
only `GET /api/v1/environments` for the server-selected exact host/path and
registered project. The query rechecks current project authority and filters in
SQL. This does not grant a user token access to that native endpoint or enable
other private plugin SDK operations. See [personal thread API verification](server-control-plane.md#sixteenth-increment-personal-thread-api-sdk-and-cli).

The centrally installed `concurrency-limit` message-dispatch hook has a separate
private read scope for native running-thread IDs and host IDs, needed for shared
capacity accounting. That scope exists only during that exact hook callback,
requires current thread/profile/project authority, and accepts no query options
or mutations. Other hooks/plugins do not receive it. Neither internal scope
changes the user's HTTP permissions or grants access to conversations/content.

Personal `threads.stream(id, {after, signal})` now returns an async iterator of
persisted events and live native BB realtime frames over authenticated SSE.
`threads.timeline(id)` reads the same native latest-window projection (20
segments, deferred content). The user CLI exposes `threads stream` as JSON lines
and `threads timeline` as JSON. Reconnect explicitly from the last consumed
persisted event sequence. Tokens belong only in authorization headers, never
stream URLs. User streams are limited to four per user and 64 per server, use
bounded queues, and release native hub subscriptions on cancellation, revocation
or transport failure. Native BB WebSocket access remains administrative.

Browser users open `/control-plane/user/login` over the configured client-CA TLS
listener and submit the empty certificate sign-in form with a matching Origin.
The verified client certificate CN selects the registry identity. The response
sets a 24-hour HttpOnly/Secure/SameSite=Strict cookie and redirects to
`/control-plane/app`, the personal navigation screen. Cookie-authenticated
mutations require the configured Origin;
explicit invalid Authorization headers never fall back to cookies. Browser role
switches retire the previous credential, including the opposite administrative
or personal browser session. Login/logout responses emit `Clear-Site-Data` for
cache/storage. Core caches use the identity/session scope described below;
approved plugin cache integration remains pending. This header alone is not
proof of complete native UI isolation.

The personal SDK's `browserLoginUrl()` and `bb server access browser --json`
return the certificate login URL. `bootstrap()` / `server access bootstrap`
read source-filtered identity, project/thread/profile pages and capabilities.
Each navigation page is bounded to 50 with a separate list cursor. The personal
web entry reuses native sidebar components to browse accessible projects and
owned thread summaries, with additional pages fetched through this same SDK.
It loads a separate personal module without administrative bootstrap, arbitrary
plugin frontends, settings, terminals or a right workspace panel. The built-in
Composer renderer is included statically and uses personal transports. The selected thread
uses the native message/activity timeline, bottom-anchored scrolling, SSE updates,
older history and deferred tool details through owner-scoped routes. The native
composer starts conversations with an approved profile, sends or queues messages,
stops owned jobs and answers native approval/question forms. Existing threads
keep their pinned profile version; these controls do not accept execution
overrides or arbitrary model/tool changes. Authenticated
users can read compiled static assets; this does not enable the full BB API,
raw WebSocket or plugin installation. Browser cookies and PKCE CLI/plugin tokens
share the existing hashed-session table and server-side revocation checks.

The native web entry now reads `/control-plane/browser-context` before importing
application state. The SDK's `browserContext()` and CLI `server access
browser-context --json` expose the same mode/identity metadata. Authenticated
responses include a session-bound noncredential `cacheEpoch`; personal epochs
remain stable across BB restart. A fresh sign-in gets a fresh cache namespace,
even for the same login. The marker and namespaced storage are client cache
coordination, not authorization credentials.

Core local/session storage, prompt/question drafts, cached sidebars, workspace
state and voice recordings use the verified identity/session namespace. Old
namespaces and legacy core data are cleared before application startup. Native
query/socket cleanup and page visibility/focus/history checks protect account
transitions. Same-origin frontend requests bind `x-bb-client-identity` to the
verified actor; `x-bb-client-session` also asserts the verified cache epoch. The backend rejects a mismatch with current credentials. The
header supports percent-encoded UTF-8. Administrator login/logout also request
browser cache/storage clearing. The first standalone boot preserves legacy local
settings. First-party/third-party plugin code that directly uses raw browser
storage is not migrated by this increment; personal plugin frontend loading
remains closed until its scoped adapter is implemented.

Personal history is available through `threads.olderTimeline(id, cursor, signal)`
and `threads.timelineDetails(id, input, signal)` on the control-plane SDK.
`bb server access threads timeline <id> --before-anchor-id <cursor>
--before-anchor-seq <sequence>` loads an earlier page; both fields are required.
`threads timeline-details <id> --turn <id> --from <sequence> --to <sequence>
[--item <id>] [--cursor <cursor>]` expands a turn or a specific tool/reasoning
item. Requests are bounded, reject unknown execution fields and recheck current
ownership/project access before native history reads. The UI resnapshots after
a lost delta baseline or connection, discards disconnected private rows, and
uses fresh authorization before displaying history again.

`threads.profile(id, signal)` / `bb server access threads profile <id>` reads the
thread's pinned execution profile while current profile grants permit it. It
resolves the persisted version, including when a newer version has been
published. Missing/revoked profiles disable sending in the personal composer;
authorized history and stopping remain available. Drafts use the existing
identity/session-scoped BB storage and clear only after confirmed delivery when
the current draft still matches the submitted snapshot. Duplicate local submits
are latched; leaving the view aborts requests and prevents late responses from
selecting an old conversation. An uncertain transport result retains the draft
and does not promise that the server rejected delivery.

The personal composer does not use the global mention/command catalogs or
resolve pasted thread links through the unrestricted API. Rich text entry and
native submit/stop behavior are reused; scoped autocomplete,
attachments and broader approved plugin frontend support remain open work.

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

The production personal-browser check runs with
`pnpm exec turbo run test:control-plane-browser --filter=@bb/server`.
It uses the pinned development-only Playwright Core and an installed Chrome
(default channel `chrome`; `BB_TEST_BROWSER_CHANNEL` can select another installed
Chromium channel). No browser binary or Playwright is added to the runtime image.
The task builds the real fork and uses separate nonpersistent contexts with the
fixture's temporary client certificates, kept in memory. It does not install a CA
or use the operator's normal browser profile.

Unlike the default network-isolated deployment test, this browser variant
publishes only `127.0.0.1:8080:8080` from a disposable Docker container; that host
port must be free. The read-only root, temporary data/volumes, registered UID/HOME
launcher, namespace/seccomp checks and deterministic local model backend remain.
The browser variant is not a network-isolation test. Native Qwen executes real
commands; model replies come from the local OpenAI-compatible fixture rather
than a corporate authentication endpoint. The default deployment task still
uses `--network none` and publishes no ports.

`BB_CONTROL_PLANE_BROWSER_ARTIFACTS=/absolute/private/directory` optionally saves
a conversation screenshot and bounded failure diagnostics without tokens or
certificate material. Browser contexts, Chrome and the disposable container are
closed at teardown. macOS execution sandboxes may require allowing the separate
headless browser process; this does not require changing system certificate trust.

On shared control-plane servers, the builtin Workflows plugin now records each
managed run's owner and immutable authority binding in its existing SQLite
history. Its native readers and resume/stop operations scope user access; old
unassigned history remains administrative. This does not open personal workflow
APIs. Managed pure computation workflows now use a fixed evaluator process under
the registered UID/HOME/cwd. Managed `agent()` now dispatches controlled BB worker
threads with the originating approved immutable profile, or an explicitly
selected approved version via `agent(prompt, {profileVersionId: "<uuid>"})`.
Explicit model/provider/reasoning overrides must match the selected profile.
The server rechecks current parent/profile authority before replay and dispatch;
standalone servers reject the profile option. Nested `workflow()` supports
inline, named and project-confined file sources in the same isolated evaluator.
Children share agent accounting and cancellation, with one child level. Their
own invocation and VM concurrency ceilings equal `maxAgentCalls` and
`maxConcurrentAgents` respectively. File resolution uses descriptor-relative
Linux opens without symlink traversal and reads at most 512 KiB. Standalone
Workflows execution is unchanged. See
[background execution integration](control-plane-background-execution.md).

The Docker image installs the workflow evaluator automatically. For a Linux host
without Docker, build the portable artifact with
`pnpm exec turbo run build:control-plane-workflow-evaluator --filter=@bb/server`,
copy `apps/server/.control-plane-runtime/workflow-evaluator.mjs` to a root-owned
immutable path (normally `/opt/bb-control-plane/workflow-evaluator.mjs`), and pass
`--workflow-evaluator <absolute-path>` to the existing root launcher installer
alongside `--service-user`, `--users-root` and the node/Qwen configuration. The
installer pins the artifact SHA-256; deploying a new artifact requires rerunning
the installer. All parent directories must be root-owned and not writable by
other users. The launcher accepts no per-request evaluator command or Node flags.

Mapped Workflows worker threads now retain an internal authority binding in the
shared database. Both the worker's approved profile and the source workflow's
current grants must permit execution. Cancelling the source prevents subsequent
sends/resumes and stops pending or running mapped workers through a service-scoped
monitor. These references are assigned internally; the personal thread API does
not accept binding/UID/HOME/environment overrides. Personal workflow controls,
complete crash/retry recovery and notifications remain unfinished. The
managed `agent()` bridge now uses the scoped worker adapter, persists native calls
and results, and fences cancellation during worker creation. Completed-call
replay includes the immutable profile version.

Managed Workflows startup now discovers bound workers through the scoped core
facade and repairs cleanup after history retention. The plugin database retains
parent binding IDs independently of workflow run rows. Current owner/project
access filters worker cursor pages before limits. Startup includes archived
workers to repair a missing acknowledgement; maintenance excludes them. A
normal server restart requeues interrupted runs, reuses successful call results
and replaces interrupted worker attempts after rechecking authority. Pending
side effects may run again; this is not exactly-once execution.

The default Docker acceptance test also verifies workflow recovery after shared
server `SIGKILL`, including interpreter/Qwen process death, successful-prefix
replay and an execution-profile grant revoked while BB is offline. Its test-only
inner/outer watchdogs are 360/390 seconds because it now also verifies repeated
provider failures, cancellation and grant revocation during backoff. Browser-mode
uses 390/420 seconds. Production run deadlines are unchanged.

Managed workflow agents now preserve terminal worker/provider errors through
the scoped reader. The existing controller retries qualifying transient failures
with bounded backoff and a fresh worker attempt; authorization, permanent model/
configuration and exhausted structured-output failures take precedence over
transient wording. Each attempt re-enters canonical owner/profile admission.
Structured-result corrections reuse the worker and native session, with at most
two corrective turns. A native completion cursor prevents duplicate repairs
while polling an idle worker. Stock Qwen can perform its own internal retries:
the Docker external-retry proof injects an error in an already-open response
stream, rather than assuming every HTTP 503 leaves the harness immediately.

Managed message and queue creation also recheck current execution authority in
their write transaction, after asynchronous preparation. Revocation therefore
cannot admit a new corrective/user message or queue entry using an earlier
approval. Workflow cancellation and profile revocation during external backoff
prevent another worker attempt; transient exhaustion remains bounded to two
external retries. Stock harness retry delays are independent.

Managed workflow completion notices use the saved run owner and origin with
current execution grants. Native agent-only messages and central acceptance
receipts commit atomically. A retry after a lost plugin acknowledgement does not
append a second request; this is acceptance deduplication, not exactly-once model
or tool execution. Revoked/cancelled authority abandons the notice. Transient
preparation failures keep the plugin's persisted notification backoff. This
internal integration adds no public administration endpoint or configuration.

The limited personal workflow API is `/control-plane/user/workflows`: GET lists
owned runs, POST starts an inline script in an owned origin thread; GET
`/:id`, `/:id/result` and `/:id/history` read native state, and POST `/:id/stop`
cancels it. Enable the builtin Workflows plugin administratively first. The
adapter requires builtin provenance and uses its normal RPC lifecycle under the
verified user principal; it never forwards a user-selected plugin or method.
Both personal Bearer credentials and matching-origin browser sessions use the
existing access boundary. The unrestricted BB/plugin APIs remain administrative.

`createControlPlaneClient(...).workflows` and `bb server access workflows`
provide these operations. Scripts are limited to 512 KiB of UTF-8; arguments are
JSON bounded to 128 KiB, 32 levels and 10,000 values. Start permits only
`originThreadId`, `script`, `args` and `resumeRunId`. Project, model/profile,
UID/HOME/cwd and execution grants come from the managed origin and approved DSL
worker profiles. No caller-supplied owner, environment or launcher fields are
accepted. CLI `--file` reads a client-local file. See `bb guide machines` for
pagination, replay and history/result semantics. The personal UI exposes the same
run operations through the Workflows button in a selected project/conversation.
Saved personal definitions are available as described below; schedules and a
dedicated workflow progress stream remain pending.

Workflow HTTP bodies have a separate 4 MiB envelope limit so JSON escaping does
not reduce the advertised source/argument bounds. The wildcard covers the root
and nested workflow routes. Oversized streams are rejected before parsing;
invalid JSON remains a 400 response. This bound does not increase native script,
argument, result, process or execution budgets.

Shared-server control-plane bodies are bounded before parsing and mutation:

| Interface                                                            | HTTP body limit |
| -------------------------------------------------------------------- | --------------- |
| Administrative login, JSON or form                                   | 8 KiB           |
| Certificate/PKCE flow start, approval and exchange                   | 4 KiB           |
| Personal project creation                                            | 4 KiB           |
| Administrative profile create/version/enable/access                  | 1 MiB           |
| Personal thread start/send/resolve/stop                              | 1 MiB           |
| Environment provisioning, certificate browser login and both logouts | 1 KiB           |
| Personal workflow routes                                             | 4 MiB           |

A body-limit rejection returns JSON `payload_too_large` with HTTP 413 and
`Connection: close`, so another request does not follow an unread oversized
body on that socket. Both Content-Length and streamed/chunked requests
use the same budgets. JSON syntax errors remain 400, and form parsing retains
its original Content-Type after the bounded read. Duplicate form fields are
rejected instead of choosing one value.

Thread/workflow stop and both logout actions accept an empty body or `{}`;
additional fields are rejected before stopping work or revoking a session.
Certificate browser sign-in continues to require an empty body. These changes
add no configuration override, CLI option or Plugin SDK member. The budgets
cover the existing control-plane body-consuming actions; they do not constitute
a complete audit of native BB APIs, daemon RPC or all request metadata.

The personal Workflows screen occupies the main workspace and keeps the native
left project/thread sidebar. It uses only the limited SDK client: project-scoped
run pagination, selected status/result/agent-call history, cancellation, inline
source/JSON start and terminal-run replay. Open an owned conversation with
execution access to start; project-only/read-only views can inspect existing
runs. Replay requires supplied source and arguments and uses native successful
prefix replay. Source drafts are component memory, reset when leaving the view
or changing project/conversation, and are never stored in browser persistence.

`?view=workflows` on an authorized project/conversation path opens this screen,
including after reload; selecting a particular run is local to the current view.
Queries refresh every two seconds while active and are disposed when the screen
unmounts. A read/access failure hides cached details/results/history and offers
an explicit refresh. This is polling through the existing limited API, without
opening a general plugin frontend or adding a new workflow streaming protocol.

Before closing a rejected control-plane upload, the body middleware discards
remaining bytes with an 8 MiB drain budget and a 500 ms deadline. It then cancels
an unfinished stream. This avoids resetting normal finite uploads while the
client is still writing, without parsing or dispatching oversized input or
waiting indefinitely for stalled/endless bodies. Accepted bytes are buffered
only up to the route's existing body budget before the action is called.

Personal workflow definitions use `/control-plane/user/workflow-definitions`:
GET lists owned summaries, POST creates from `originThreadId`, `script` and default
`args`. GET `/:id?revision=N` reads a version; PUT `/:id` takes `expectedRevision`,
replacement `script` and `args`. POST `/:id/run` requires exact `revision` and
optional argument override; POST `/:id/enabled` takes `enabled`; DELETE `/:id`
tombstones the authority. All body routes retain the 4 MiB envelope and tighter
source/argument limits. Owner/project/origin/profile/launcher overrides are not
accepted. SDK and CLI discovery are in `bb guide machines`.

The builtin plugin adds native SQLite definition/head and immutable-version
tables. One stable central `workflow-definition` binding governs every version
and derived run; a run copies exact source/arguments and binds that source as its
ancestor. The binding's revision 1 identifies the stable authority, while the
native revision identifies immutable code/defaults. They are distinct counters.
Native and central persistence use fail-closed reservation: central authority is
reserved first, native insertion commits in one transaction, and a failed insert
retires the reservation. A crash before native insertion can leave a binding with
no definition, which cannot execute and is skipped by native list/get.
Disable/delete commit the central execution fence without a second mutable
native enabled/deleted flag. Versions and run snapshots remain stored. Saving
changes does not silently rebind origin/project/profile or interrupt older runs;
current execution grants still apply when a particular revision is run.

Replay of a definition-derived run inherits its stable source binding, including
when requested through the ordinary inline workflow start/resume API. It cannot
strip or replace that ancestry to reuse a disabled/deleted definition's cached
prefix. The previous run may be terminal/cancelled; its saved source authority
still has to permit the new execution. Creating a separate new inline run remains
subject to the ordinary current profile/project permissions.

Administrators can use the authenticated native SDK `plugins.callRpc` or
`bb plugin rpc call workflows <method> --input-file <json-path> --json` for these
same handlers. `controlPlaneDefinitionInventory` accepts
`{"cursor":null,"limit":50}` and optional `projectId`, returns summaries with
`ownerUserId` and `nextCursor`, and respects a user principal if invoked under one.
`controlPlaneDefinitionGet` takes `id` and optional `revision`;
`controlPlaneDefinitionRun` takes `id`, exact `revision` and optional `args`.
Enabled/update/remove handlers use the corresponding ID-based contracts above.
Raw native RPC requires administrative access; personal clients use the limited
API. Administrative run dispatch adopts the saved owner and rechecks that user's
profile/project/source grants. It cannot bypass a disabled source. A logged-out
user's API token remains rejected while an authorized administrative dispatch can
run the still-enabled saved job under that user.

In the full administrative BB, open Workflows → Workflow definitions
(`/plugins/workflows/definitions`). The native panel lists saved owners and
projects, filters and pages metadata, creates from a project/origin thread,
loads current or historical revisions, saves new revisions, runs the loaded
saved revision, enables/disables and deletes definitions. It uses these same
native SDK/RPC handlers. Owner, profile, UID, HOME and cwd are derived by the
server; no owner selector or execution-identity override is accepted. Run ignores
unsaved editor changes and uses the selected saved defaults. Saving uses the
loaded revision as its compare-and-swap expectation, so stale edits fail rather
than overwrite a concurrent version. Enable/disable preserves that editing
revision and draft. Refresh failures hide cached metadata and the editor;
unmount disposes outstanding reads. The personal UI does not load this plugin
frontend or gain native RPC access. Legacy assignment remains later work.

## Managed shared-server automations

In configured shared-server mode, the builtin controller uses saved owner
and source authority for agent automations. Creation requires
`createdByThreadId` in the selected managed project. The native CLI supplies it
from the invoking BB thread; SDK callers use
`plugins.callRpc({pluginId:"automations",method:"automations_create",input,...})`
and administrators can use `bb plugin rpc call automations <method>
--input-file <json-path> --json`. Existing list/show/update/pause/resume/run/runs/
delete commands and native UI management use those same handlers.

Provider/model/reasoning/permission values must match the origin's approved
pinned profile. Environment must be `project-default` or reuse that exact
origin environment. Arbitrary host/worktree targets, target-thread re-prompting,
service-tier overrides and script execution are rejected in managed mode;
standalone BB retains its existing modes. There is no caller-supplied owner,
UID, HOME, cwd or server credential. The kernel selects them from saved authority.

Definitions have a stable central binding and immutable native revisions;
each claimed run captures its revision/execution before dispatch. Manual runs
retain native idempotency and single-flight behavior. Cron/timezone and once
triggers retain native due-time/retry policy, with owner/grant checks before
claim and actual dispatch. Explicit pause fences descendants and blocks manual
run; a consumed once trigger stops scheduling without revoking its history.
Completed idle agent processes are released while preserving their threads,
source authority and Qwen session history. A new active turn is retained.

Native user-principal list/get/mutations/history require personal ownership and
current project access, including shared projects. Full administrative native
RPC can manage registered owners and inspect legacy history; unassigned legacy
objects are disabled at startup and cannot execute until explicitly assigned.
The personal automation UI and isolated script execution remain later stages;
limited reads and management operations are described below. Browser tokens are not stored with jobs.

## Personal automation reads

The limited `/control-plane/user/automations` API supports authenticated GET
list, `/:id` and `/:id/history` requests. SDK clients use
`createControlPlaneClient(...).automations.list/get/history`; CLI clients use:

```sh
bb server access automations list --project <project-id> --limit 20 --json
bb server access automations get <automation-id> --json
bb server access automations history <automation-id> --limit 20 --json
```

Lists accept `--cursor` from `nextCursor`, with at most 50 definitions per page.
History uses a separate opaque `--cursor`, with at most 100 runs per page.
Ownership and current project access are checked before invoking the fixed
builtin controller and again after awaiting its response. Shared project access
does not expose another user's personal automations. Replies use `no-store`.

These projections contain schedules, state, origin and execution thread IDs;
they omit execution configuration, prompts, script paths and run output.
Read agent output through the owned thread API. The full administrative/native management surfaces remain available. Personal
management operations are described below; the personal automation workspace
is subsequent work. Native RPC and unsupported mutation URLs remain closed.

## Personal automation management

Personal certificate/bearer sessions can create and manage agent automations
through the limited API and `createControlPlaneClient(...).automations` SDK.
The server derives project, provider/model/reasoning/permission settings and
execution identity from the owned origin thread's approved pinned profile.
The client supplies a name, prompt, cron/timezone or once trigger and enabled
state; it cannot override owner, UID, HOME, cwd, environment, tools or MCP.

```sh
bb server access automations create <origin-thread-id> --name Digest --prompt-stdin --cron '0 9 * * *' --timezone Europe/Moscow --json
bb server access automations definition <automation-id> --json
bb server access automations update <automation-id> --revision 1 --prompt-stdin --json
bb server access automations pause <automation-id> --json
bb server access automations resume <automation-id> --json
bb server access automations run <automation-id> --idempotency-key daily-manual --json
bb server access automations stop <automation-id> <run-id> --json
bb server access automations delete <automation-id> --json
```

Use `--at <ISO-time-or-Unix-ms>` instead of `--cron` for a once trigger.
`--timezone` requires `--cron` and otherwise defaults to UTC. Creation requires
`--name`, a prompt (`--prompt` or `--prompt-stdin`) and exactly one trigger;
`--disabled` creates a paused source. Editing requires the saved `--revision`
and at least one changed name, prompt or trigger. Native immutable versions
are committed with the configuration change; stale revisions return 409.
Pause/resume leave the definition revision unchanged. A consumed once trigger
must receive a future trigger before it can be resumed.

Metadata list/get retain their field shape and omit the prompt. The owner-only
`definition` method/GET `/:id/definition` returns the editable prompt and current
revision. Create/update return metadata with the resulting revision. New run
readers must understand the terminal `cancelled` status.

HTTP writes are POST `/control-plane/user/automations`, PUT/DELETE `/:id`, POST
`/:id/pause`, `/:id/resume`, `/:id/run` and `/:id/runs/:runId/stop`. Creation
accepts `originThreadId,name,prompt,trigger,enabled`; editing accepts
`expectedRevision` and changed `name,prompt,trigger`. Manual run accepts only
an optional `idempotencyKey`. Delete, pause, resume and stop require an empty
body; queries cannot override identity or execution context. JSON bodies have
a 1 MiB transport budget and prompts a 128 KiB UTF-8 budget.

Individual stop fences only the selected run. Its cancellation intent is saved
before process cleanup; until cleanup succeeds the run stays running and the
single-flight guard stays in force. A pending cleanup returns 409 and the sweep
retries saved requests, including after controller restart. A successful stop
records `cancelled` without changing enabled/next-run/failure-budget state.
Already terminal runs return `stopped:false`. A worker still being attached
returns 409; retry once attached or pause the whole source to fence dispatch.
Pause fences all descendants, while delete tombstones authority and removes
native definition/version/run records. Existing owned BB conversations retain
their history; source-fenced workers cannot resume execution.

All operations use the same builtin controller and shared kernel as native
management. Unknown/native RPC routes stay closed to personal credentials.
The personal automation workspace uses this limited API. The wider background
admission/recovery audit remains open; managed script execution is unavailable.

## Personal automation workspace

In the personal BB browser, open a project/conversation and choose Automations.
The native left navigation remains available. New automation uses the current
conversation's approved profile. Set a one-time local date/time or choose
Recurring and supply a cron expression with its explicit timezone. A paused
source can be created with Enable automation unchecked.

Select a definition to edit its name, prompt or schedule, pause/resume, run it
manually, or inspect paginated run history. Open origin conversation and Open run
conversation return to the owned native conversation. Automation selection is
kept in the URL across reload. Progress refreshes every five seconds.

Saving checks the loaded revision. Polling does not replace unsaved input;
Reload saved automation explicitly discards the draft and loads the latest
version. A failed save retains the draft. Stop run waits for server cleanup;
when attachment or cleanup is pending, refresh and retry. Delete automation
requires an inline confirmation and stops active jobs while retaining their
conversations. Cleanup actions remain available after execution access is lost,
while new runs, edits and resume require execution permission. Read denial hides
cached definition content and history. The full administrative API and plugin
frontends remain closed to this application.

## Private managed script launcher

The control-plane helper installer supports optional `--script-runtime node-esm`.
It enables private `launch-script USER_UUID NUMERIC_UID JOB_UUID PROJECT_CWD`
execution with JavaScript ESM source on stdin, under the registered UID/HOME/cwd
and existing process supervisor. Interpreter arguments and environment overrides
are rejected; Qwen model credentials are not passed to scripts. The Docker lab
enables this primitive. Managed Automations and personal APIs still reject script
definitions pending their bounded server runner and durable lifecycle integration.
See `docs/control-plane-script-runtime.md` for installation, limits and checks.
