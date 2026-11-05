# Task sources and Beads polling

A task source binds a saved user, project and immutable published agent version.
The generic polling service owns admission, a durable task journal, checkpoint,
retry delay and current authority. An adapter reads its source and returns a
validated bounded batch of `{id, title, input}` plus an opaque checkpoint.
Native agent runs continue to own execution, results and inspection.

## Adapter boundary

`TaskSourceAdapter.poll` receives the saved source/user/project identity, previous
checkpoint, an abort signal and a managed workspace runner. Adapters are trusted server code registered at startup;
users cannot upload adapters, executable paths, shell arguments or source code.
The kernel has no Beads-specific parsing or task-state logic. Adding another
source requires its adapter, validated configuration and explicit authorization
and credential resolution for that transport. The current executable registry
contains only Beads. The alternate-adapter test verifies reuse of the kernel.

Each adapter owns its transport authentication under the saved user identity.
Beads uses the registered workspace
identity, not a stored bearer token. Credential-based remote adapters are not
implemented by this slice; their encrypted per-user credential integration must
be added with the first remote adapter. No dummy credential is requested or
stored for Beads.

## Beads behavior

The trusted adapter executes `/usr/local/bin/bd --readonly --sandbox ready --json
--limit 0` through the existing managed script supervisor in the project's exact
cwd with the owner's UID/HOME. `.beads` must be a real directory immediately
inside that project. `BEADS_DIR` is pinned to it, preventing accidental discovery
of a parent project's database. Beads owns dependency/ready-work semantics;
exports such as `issues.jsonl` are not treated as its source of truth.

The Docker image pins Beads 1.3.4 and verifies published SHA-256 checksums for
Linux amd64/arm64. For deployment outside Docker, install the same binary at
`/usr/local/bin/bd` and retain the configured managed script launcher. Initialize
the project's Beads database under the registered user before enabling polling.
Existing Beads workspace configuration supplies any database connection state.
The control plane does not automatically initialize, claim, close or sync tasks.

The batch is a complete bounded snapshot of ready work; its checkpoint is a hash
of normalized tasks, not a timestamp cursor. At most 1000 tasks and 1 MiB are
accepted. A larger or malformed response fails the poll without advancing the
checkpoint. Reading the entire bounded snapshot prevents ready tasks becoming
invisible merely because their creation time predates the last poll. Empty
snapshots are valid. The original task ID, title and input are retained before
admission. A repeated ID keeps its original input and run even if later edited,
closed or reopened; this initial policy does not interpret edits as new events.

This is a trigger, not a distributed work-claim protocol. Other Beads consumers
can independently claim or execute a task. Successful agent execution does not
prove the task's acceptance criteria and does not automatically close it. Agents
with appropriate tools or a human may update Beads through their normal workflow.

## Persistence and authority

Each `(sourceId, externalId)` has one durable reservation and a private native
idempotency key `task-source:<reservation UUID>`. Public start requests cannot
choose this prefix. The service stores a complete batch and checkpoint in one
transaction before dispatch. Pending rows are retried before reading more work;
a lost response after native admission reuses its original key and input.
Accepted denotes admission, not successful execution or exactly-once effects.

A source is created paused and has an immutable project, owner, adapter and pinned
version. There is at most one source of each kind in a project, so adding a
second personal subscription does not silently duplicate that project's work.
Management and history require its owner and current project access. Every poll
and admission rechecks enabled user/environment, UID maintenance, project and
profile grants. Reads recheck authority after the adapter returns. Managed
reader processes poll authority while running and use the existing supervisor
stop/cleanup and maintenance leases. The saved reader job ID permits
cleanup before another read, including after restart. After confirmed cleanup a
fresh job ID is saved before launch; stopped supervisor IDs are never reused.

Pausing aborts an in-flight reader and prevents subsequent admissions. Work
already admitted continues, and its acknowledgement is retained. Pending tasks
remain saved for re-enabling. Sources are scanned each second, with at most four
active polls in this single-server process. Each admission pass handles ten tasks;
a poll can drain old pending work and then admit a new batch, at most twenty tasks.
The configured interval is 60–86400 seconds. Errors double the interval, capped
at the greater of one hour and the configured interval; a successful poll resets it. `Poll now` explicitly retries sooner.
The journal and retry schedule survive restart. Multi-process scheduler leases
and automatic migration of sources between owners are outside this contract.

## UI, API, SDK and CLI

The personal Task sources view creates Beads sources, enables/pauses them,
requests a poll and displays status, failures and task history. Result links use
the native read-only inspector. Source errors expose a stable generic reason,
not stderr, credentials or provider diagnostics. Saved task input is not returned
by source history; authorized run inspection owns that view.

The limited API is `/control-plane/user/task-sources`:

- `POST` creates with `{projectId, profileVersionId, kind: "beads", name,
  intervalSeconds}`; the interval defaults to 300.
- `GET ?projectId=...&cursor=...` lists the current user's sources, 20 per page.
- `GET /:id` returns status, checkpoint and next/last poll times.
- `PUT /:id` accepts only `{enabled}`.
- `POST /:id/poll` accepts an empty body; the source must be enabled.
- `GET /:id/history?cursor=...` returns tasks and native run IDs, 20 per page.

The SDK is `createControlPlaneClient(...).taskSources` with create/get/list,
setEnabled/poll/history. CLI equivalents are `bb server access task-sources
create|list|get|enable|disable|poll|history`. Creation takes a project ID,
`--profile-version`, `--name` and optional `--interval`. There is no public
unauthenticated polling endpoint and no new Plugin SDK or daemon wire capability.

Migration `0169_perpetual_gorilla_man` stores sources and their task journal.
