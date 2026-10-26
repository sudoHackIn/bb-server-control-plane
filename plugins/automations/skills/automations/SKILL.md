---
name: automations
description: "Schedule or manage recurring and one-shot BB agent or script automations."
---

# Automations

An automation is a scheduled task. When due it runs in one of two modes:

agent Spawn a thread or re-prompt a target thread with a configured prompt.
script Run a stored server-side script and capture stdout/stderr/exit.

In standalone/full administrative BB, use the top-level `bb automation`
command. Personal shared-server clients use `bb server access automations`
as described below.

Pass `--project` explicitly for native automation commands. Limited personal
creation derives its project from the origin and accepts no project override. Inside a thread, automations are stamped origin `agent` and record the creating thread automatically. Automation-spawned threads cannot create automations.

Personal supports automations with `--project proj_personal`. Use `bb project list --include-personal --json` to include it in discovery; an empty default project list does not mean Personal is unavailable.

On the managed shared server, agent definitions require an owned origin thread
and exactly its approved provider/model/reasoning/permission profile. Invoke
creation from that BB thread, or use administrative native RPC with
`createdByThreadId`. Only project-default or that origin's reused environment
is supported. Script mode, arbitrary host/worktree targets, target-thread
re-prompting and service-tier overrides are rejected until their isolated paths
are implemented. Managed pause also blocks manual run and stops descendants.
Completed idle runtimes are released; owned history and Qwen session resume
remain available. The personal automation UI is a later stage; personal
reads and mutations use the limited API described below. User credentials do not grant the
native CLI/RPC administrative API.

On a managed shared server, queued runs wait while project access is being
updated. Scheduled automations keep their due time during that pause. After access
is restored, execution checks the current permissions again.

Choosing a mode:

Use `script` when the output is fully determined by code: watchdogs, threshold alerts, health checks, heartbeats, and API pollers with a fixed output shape. Scripts run on the bb server. New standard-project scripts use the server-host project source when one exists; Personal and projects without one run in the plugin's shared script storage directory. Existing scripts without a saved policy also run there. Use `--working-directory automation-storage|project|<absolute-server-path>` to select the policy. Script automations do not have an environment field and do not accept environment flags.

Design the script to print nothing when there is nothing to report: an exit-0 run with empty stdout/stderr, or a last non-empty line of `{"wakeAgent": false}`, is recorded as a skipped silent tick. Any other output is captured; non-zero exit or timeout is recorded as a failed run.

Use `agent` when the run needs reasoning: summarize a feed, pick interesting items, draft a human-friendly message, or branch on content.

Creating:

```bash
bb automation create --project <id> --name "..." [schedule flags] [mode flags]
```

For creation flags and mode-specific defaults, read
[references/creation.md](references/creation.md).

Read `references/script-runtime.md` before you use a script file, depend on
injected variables, or diagnose retries, timeouts, restarts, and silent runs.

Managing:

```bash
bb automation list --project <id>
bb automation list --target-thread <threadId>
bb automation show <automationId> --project <id>
bb automation update <automationId> --project <id> [--name <name>] [schedule flags] [complete execution flags | partial agent update flags]
bb automation pause <automationId> --project <id>
bb automation resume <automationId> --project <id>
bb automation run <automationId> --project <id> [--idempotency-key <key>]
bb automation runs <automationId> --project <id> [--limit <count>] [--output <runId>]
bb automation delete <automationId> --project <id> --yes
```

`list --target-thread` returns automations in any project that re-prompt that
thread; the thread's Info tab shows the same list. It does not include
automations the thread merely created.

For partial updates, mode replacement, execution targets, or damaged records,
read [references/updates.md](references/updates.md). Every command supports `--json`.

`bb automation <command> --help` prints that command's exact arguments, options,
accepted values, and rules. Unknown commands, unknown options, and stray
arguments are rejected rather than ignored, and a failure under `--json` also
prints a `{"ok":false,"error":{"code","message","hint"}}` envelope on stdout.

## Personal shared-server reads

A personal server credential uses `bb server access automations list/get/history`
through the limited API, rather than native plugin RPC. Lists are owner-filtered
and accept `--project`, `--cursor` and `--limit` (maximum 50). History accepts
its own opaque `--cursor` and `--limit` (maximum 100). Agent output remains in
its owned thread; these read projections omit execution configuration and output.
Personal management uses the limited commands below; the personal automation
UI is not yet exposed.

The managed builtin `controlPlaneAutomationReads` RPC accepts at most 50 `ids`
and reads existing definitions through owner predicates. It omits incomplete
reservations; personal clients page through empty pages while `nextCursor` is
present. It is unavailable in standalone mode. Personal clients use the limited
SDK/CLI rather than selecting or calling this RPC directly.

## Limited management commands

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
The personal automation workspace and wider background admission/recovery audit
remain subsequent work; managed script execution is still unavailable.

## Personal browser

The personal BB Automations section uses the same limited management API and
SDK/CLI documented above. Create from an owned conversation, choose a once or
cron/timezone schedule, edit with revision checks, pause/resume, run, stop a run,
open its conversation or confirm source deletion. The editor retains rejected
drafts; Reload saved automation explicitly loads the latest revision. Selection
survives page reload and history refreshes every five seconds. Read failures
hide content. Execution access is required for creates/edits/resume/manual runs;
cleanup remains available to the owner. Native administrative RPC remains closed.
