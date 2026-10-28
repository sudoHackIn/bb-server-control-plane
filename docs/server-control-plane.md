# Shared-server control plane: active feature plan

This is the active backlog. Completed increments, verification records and deployment notes remain in [the implementation history](server-control-plane-history.md). Keep completed work out of this list.

## Product model

- An **agent** is an administrator-published immutable version: prompt, provider/model/reasoning, permissions, tools and MCP. The first agent is a plain Qwen conversation. A later version may use a workflow to execute a task.
- A **run** invokes a pinned agent version for a verified user in an authorized project. Interactive runs use BB threads. Background and workflow runs reuse BB persistence, timelines and results; the control plane stores only bindings for authority, origin and navigation.
- A **trigger** starts a run. Chat and manual background execution come first; schedule, webhook and task-source polling follow. Its saved owner and project determine authority. Event payloads cannot choose them.
- Agents call approved agents or workflows through a server-checked invocation that carries user/project authority, ancestry and execution limits.
- Users see agents, conversations and work. Workflow source and scheduler mechanics are authoring and diagnostic details.

## Working baseline

The fork already has published profile versions and grants, certificate users, personal projects, native Qwen conversations and timeline, a personal Agents catalog, workflow persistence/workers, and manual/once/cron automations. The two-user publish-to-chat-to-automation path has been exercised in Docker. These are starting primitives, not backlog items. See the [delivery record](server-control-plane-history.md#current-delivery-goal-complete-user-journey).

P0 is complete: administrators publish a plain Qwen agent with supported
capabilities, and a granted user selects it and chats in the restricted BB
workspace. The pinned profile and tool policy survive later turns and restart.
See [the P0 verification record](control-plane-phase-86-verification.json).

The profile schema currently supports `qwen-server`. Verified prompt policy appends Qwen instructions; it does not replace the full system prompt. Workflow `agent()` can select `profileVersionId` on this server, but that is not yet published-agent composition. Restricted native Qwen nested agents remain denied.

## Delivery rules

Each slice must be independently useful and small enough to test on the running Docker deployment. Ship its limited API, SDK and CLI with its UI. Close a slice after focused tests, a two-user Docker path and a separate commit. Enforce owner/project/profile authority in that slice.

### P1 — Manual background run of the same agent

Goal: the user selects the published agent, gives it a task and follows status/result without keeping a chat turn open.

- [x] Add one typed invocation contract: pinned version, verified owner, project, bounded input, source and idempotency key. Reuse BB thread/workflow records; do not duplicate their histories.
- [x] Expose start, list, status, events, result and cancel through limited API, SDK, CLI and agent UI. Text task and result suffice.
- [x] Verify UID/HOME/cwd, cancellation, restart/reconnect, revocation and foreign-ID denial in Docker.

### P2 — Time trigger for a published agent

Goal: schedule the same agent in the same project and see each run beside manual work. Reuse the existing once/cron scheduler.

- [ ] Make the automation target an explicit pinned agent version and input, without requiring an origin conversation or a separate agent prompt. Migrate existing definitions without changing their owner or pinned version.
- [ ] Keep trigger configuration separate from the agent. Define overlap, retries, missed runs and duplicate behavior; do not promise exactly-once external effects.
- [ ] Verify two users' schedules, UID/HOME/cwd, revocation and restart recovery in Docker. Show run status/result in the agent UI.

### P3 — Workflow as an agent execution strategy

Goal: an administrator publishes an agent whose background task uses a versioned workflow. Users still invoke an agent.

- [ ] Bind an approved workflow definition revision to an immutable agent version. Validate bounded input/output. Start with background execution and retain workflow history/replay.
- [ ] Resolve every workflow `agent()` step through a pinned approved profile and the saved user/project authority. Verify child thread/result/replay scope and revocation after restart.
- [ ] Show workflow progress and child work in the agent run detail. Keep source editing in administrator or advanced authoring surfaces.

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
