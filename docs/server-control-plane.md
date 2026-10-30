# Shared-server control plane: active feature plan

This is the active backlog. Completed increments, verification records and deployment notes remain in [the implementation history](server-control-plane-history.md). Keep completed work out of this list.

## Product model

- An **agent** is an administrator-published immutable version: prompt, provider/model/reasoning, permissions, tools and MCP. The first agent is a plain Qwen conversation. A later version may use a workflow to execute a task.
- A **run** invokes a pinned agent version for a verified user in an authorized project. Interactive runs use BB threads. Background and workflow runs reuse BB persistence, timelines and results; the control plane stores only bindings for authority, origin and navigation.
- A **trigger** starts a run. Chat and manual background execution come first; schedule, webhook and task-source polling follow. Its saved owner and project determine authority. Event payloads cannot choose them.
- Agents call approved agents or workflows through a server-checked invocation that carries user/project authority, ancestry and execution limits.
- Users see agents, conversations and work. Workflow source and scheduler mechanics are authoring and diagnostic details.
- A run has a user-facing summary and an authorized diagnostic view over the same native records. Administrators retain full visibility; developers and reviewers receive explicit project-scoped diagnostic access, separate from permission to invoke an agent.

## Working baseline

The fork already has published profile versions and grants, certificate users, personal projects, native Qwen conversations and timeline, a personal Agents catalog, workflow persistence/workers, and manual/once/cron automations. The two-user publish-to-chat-to-automation path has been exercised in Docker. These are starting primitives, not backlog items. See the [delivery record](server-control-plane-history.md#current-delivery-goal-complete-user-journey).

P0 is complete: administrators publish a plain Qwen agent with supported
capabilities, and a granted user selects it and chats in the restricted BB
workspace. The pinned profile and tool policy survive later turns and restart.
See [the P0 verification record](control-plane-phase-86-verification.json).

The profile schema currently supports `qwen-server`. Verified prompt policy appends Qwen instructions; it does not replace the full system prompt. Workflow `agent()` can select `profileVersionId` on this server, but that is not yet published-agent composition. Restricted native Qwen nested agents remain denied.

## Delivery rules

Each slice must be independently useful and small enough to test on the running Docker deployment. Ship its limited API, SDK and CLI with its UI. Close a slice after focused tests, a two-user Docker path and a separate commit. Enforce owner/project/profile authority in that slice.

P1 and P2 are complete: a user can run the published agent immediately or
schedule its pinned version in a project without an origin conversation.
Scheduled and manual work share the agent task list and BB result history.
See the [delivery history](server-control-plane-history.md#p2--time-triggers-for-published-agents)
and [P2 verification](control-plane-phase-87-verification.json).

Project workflow execution now has an origin-free path with an explicit pinned
profile, the registered project environment, and scoped history/replay. It remains an
advanced authoring path. Administrators can now publish a private, immutable
workflow revision snapshot as a background agent; users invoke it through the
existing catalog and agent-runs API/SDK/CLI with bounded text input and native
schema-checked JSON output. See [workflow agents](control-plane-workflow-agents.md)
and [P3.2 verification](control-plane-phase-90-verification.json).
See the [P3.1 verification record](control-plane-phase-88-verification.json).

### P3 — Workflow as an agent execution strategy

Goal: an administrator publishes an agent whose background task uses a versioned workflow. Users still invoke an agent.

Managed workflow steps now resolve pinned approved profiles under the saved
user/project authority. Result admission and replay provenance recheck current
step grants, including revocation/regrant after restart. UID maintenance retains
pending results without repeating execution. See the
[step authority verification](control-plane-phase-91-verification.json).

Deliver diagnostics in the following independently testable slices. The first
useful increment is a run tree with links to native child conversations; authoring
and test-run controls follow. Reuse native workflow calls/history and BB timelines.

#### P3.3 — Run inspection and child conversations

- [ ] Keep the ordinary user view focused on the task, meaningful progress, requests for user input, result and bounded failure. For a viewer with diagnostic access, open a detailed view of that same run rather than a copied execution log.
- [ ] Show the workflow's call hierarchy, ordering and parallel work, phases, status and attempts. Every live agent invocation links to its actual BB worker thread. Open its native timeline with recorded prompts/messages, tool calls/results and available file changes, with navigation back to the run. A plain conversation agent opens its single thread directly.
- [ ] Show run and step inputs/outputs, pinned agent/profile/workflow revisions, effective provider/model/reasoning and permissions, timing, contract failures and retry errors. Distinguish live execution from successful-prefix replay; cached calls point to the original work under current read authority and do not imply a new chat or model invocation.

#### P3.4 — Reviewer and developer access

- [ ] Let administrators inspect all runs through their full administrative mode. Add explicit diagnostic grants for developers/reviewers on authorized projects, independent of agent invocation grants. Publishing or developing an agent does not by itself grant access to its users' conversations or production run inputs.
- [ ] Keep inspection read-only. Scope run trees, child threads, tool details, original replay results, artifacts and subscriptions at the backend; independently authorize execution controls. Verify direct foreign-ID reads, grant revocation, role changes and restart with Alice, Bob, a scoped reviewer and an administrator.

#### P3.5 — Developer test runs

- [ ] From an inspected run, create a separate test run with its captured input, a selected draft or published revision and an explicitly authorized test project. Preserve links to the inspected run and exact tested configuration without modifying its history or an immutable published version. Use the selected project's registered UID/HOME/cwd and current permissions.
- [ ] Keep workflow source editing and revision selection in administrative or advanced authoring surfaces. Expose inspection and test-run operations through the limited API, SDK and CLI alongside the UI; verify the publish/invoke/inspect/test journey in Docker.

### P4 — Agent and workflow delegation

Goal: an agent chooses an allowed specialist at runtime; a workflow can invoke that specialist by version.

- [ ] Publish a per-agent allowlist of callable agents and workflows. Expose one server-checked path to workflow steps and a constrained Qwen BB tool/MCP adapter. Prompt text and parentThreadId are not authority.
- [ ] Carry verified ancestry to each child; enforce grants, depth, concurrency and call budgets at admission and resume. Preserve parent/child navigation, cancellation and scoped results.
- [ ] Test direct and workflow-mediated allowed/denied calls, two users, revocation and nested recovery in Docker.

### P5 — More triggers and richer contracts

- [ ] Add webhook delivery with configured owner/project, authenticated source, bounded payload, input mapping, idempotency and visible failures.
- [ ] Add task-source polling with per-user credentials, checkpoint, duplicate handling, backoff and current-grant checks.
- [ ] Add structured input/output, files/artifacts and interactive workflow-backed agents when a concrete use case needs them. Verify scoped history, artifacts and subscriptions.

### P6 — Advanced extension points

- [ ] Decide how centrally installed plugins package agent definitions and UI; keep code installation administrative and grants separate.
- [ ] Add hooks and lifecycle customization only for a demonstrated use case, with explicit authority and failure behavior. Hooks do not gate P0–P5.

## Cross-cutting acceptance for each new path

- Resolve owner, project, pinned version and current grants at actual start, send, tool call, retry and resume. Browser tokens are transport credentials, not durable job authority; plugin or machine identity cannot impersonate a user.
- Scope lists, direct-ID reads, subscriptions, results, artifacts, notifications and UI caches at their data sources. Clear drafts/subscriptions on identity switch or logout.
- Run tenant-authored code and workspace operations under the registered UID, HOME and permitted cwd. Trusted centrally installed plugins are a separate boundary. Deny unowned legacy jobs until explicitly assigned.
- Exercise the path with Alice, Bob and an administrator in Docker, including direct API/CLI/RPC bypass and restart/recovery for persisted work.
