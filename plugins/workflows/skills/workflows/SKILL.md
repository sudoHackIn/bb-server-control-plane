---
name: workflows
description: "Author or run durable BB workflows when the user requests workflow execution or multi-agent orchestration."
---

# BB workflows

Use a workflow when the user explicitly asks for multi-agent orchestration.
Ordinary tasks do not authorize a workflow run.

A workflow puts deterministic control flow around normal BB worker threads. The
script can fan out work, pipeline stages, verify results, and return structured
data. Worker threads retain normal workspace tools and permissions.

The plugin is disabled on fresh installations; `bb plugin enable workflows`
turns it on. `bb workflows` commands must run from a BB project thread.

## Start safely

1. Inspect the task and repository before you choose the work list.
2. Confirm the provider, model, and reasoning tuple from the live catalog.
3. Write the smallest workflow that gives the requested coverage.
4. Validate the exact source before execution.
5. Start the background run.
6. Emit the returned workflow preview directive exactly once.
7. Use compact status for progress and paged history for details.

Check an explicit model selection with:

```sh
bb provider list --environment "$BB_ENVIRONMENT_ID" --json
bb provider models <provider-id> --environment "$BB_ENVIRONMENT_ID" --json
```

Do not guess model identifiers or partial selection tuples.

## Read only the required detail

- Read references/authoring.md when you write or change workflow source,
  schemas, agent options, or nested workflows.
- Read references/orchestration.md when you design pipelines, barriers,
  verification, panels, loops, or other quality controls.
- Read references/runs.md when you validate, start, inspect, stop, or resume a
  workflow, or change the plugin's run limits.

## Minimal source

Every script starts with a literal meta object:

```js
export const meta = {
  name: "review-change",
  description: "Review a change and verify the findings",
  phases: [{ title: "Review" }, { title: "Verify" }],
};
const results = await pipeline(
  args.items,
  (item) => agent("Review " + item, { phase: "Review" }),
  (review, item) =>
    agent("Verify this review for " + item + ":\n" + review, {
      phase: "Verify",
    }),
);
return results;
```

Workflow source is JavaScript, not TypeScript. The script has no filesystem,
shell, network, import, clock, or random access. Worker agents can use their
normal tools.

Use pipeline for independent multi-stage items. Use a parallel barrier only
when the next stage needs all prior results.

Use an agent schema when later stages need reliable structured data. A
structured worker must return its value through the workflow result tool.

## Execute

Validate and run with the same source selector:

```sh
bb workflows validate --file .bb/workflows/review-change.js
bb workflows run --file .bb/workflows/review-change.js --args '{"items":[]}'
```

The agent tool accepts script, scriptPath, or name. The CLI accepts --script,
--file, or --name.

After a successful agent-tool call, copy its previewDirective into the
assistant response as one standalone line. Do not edit or repeat it.

Use bb workflows status for compact progress. Redirect bounded history pages
into BB_THREAD_STORAGE before inspection because history can contain full
prompts and results.

## Quality check

- The user explicitly requested workflow orchestration.
- The source passes bb workflows validate.
- Every explicit provider tuple exists in the live catalog.
- Each phase name matches its meta entry.
- Independent items use pipeline without an unnecessary barrier.
- Bounded coverage logs what it omits.
- Structured consumers receive schema-validated results.
- The final response uses status or inspected history, not assumptions.

## Shared-server control-plane fork

Managed workflows inherit the originating thread's approved immutable profile.
Use `agent(prompt, {profileVersionId: "<approved-version-uuid>"})` to select
another immutable profile available to the user. Obtain version IDs from the
personal profile catalog (`bb server access profiles list/get`). The child uses
that profile's model, tools, MCP and permissions. Explicit provider/model/reasoning
must match the selected profile. Rights to both the parent and selected profile
are checked before replay and native execution. This option requires a shared
control-plane server; standalone runs reject it. Catalog availability alone does not grant permission. Completed-call
replay is also tied to the immutable profile version.

The managed evaluator supports `agent()`, JSON results, phase/log and normal
pipeline/parallel helpers and one level of nested `workflow()`. Children share
agent quotas, replay ordering, owner authority and cancellation. Named sources
come from `.bb/workflows/<name>.js`; `scriptPath` stays within the project.
Files are read inside the UID-isolated evaluator, with no symlink traversal.
Managed child invocations have a separate ceiling equal to `maxAgentCalls`, and
at most `maxConcurrentAgents` child VMs run at once. Use the administrator's existing workflow controls while personal job APIs
are being integrated; a personal token does not grant the general BB CLI API.
Standalone Workflows behavior is unchanged.

Managed server restart requeues interrupted runs and replays the successful
unchanged prefix under current authority. Pending steps can execute again.
Registered worker discovery and cleanup use owner-aware core operations;
cleanup references survive removal of old run history.

Managed agents use the same bounded transient-provider retry controller as
standalone runs, creating a fresh worker attempt when the harness reports a
qualifying failure. Authorization/configuration errors are not retried. A
structured result may receive at most two corrective turns in the same worker;
exhaustion fails the call. Harness-internal retries are separate from workflow
worker retries, and interrupted side effects may be repeated.
