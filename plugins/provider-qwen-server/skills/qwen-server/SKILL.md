---
name: qwen-server
description: Diagnose the shared-server Qwen provider and its registered Unix execution context.
---

# Qwen Server

Provider ID: `qwen-server`. This provider is for the shared control-plane
deployment, not an unrestricted local Qwen executable.

The fork bundles this plugin disabled by default. An administrator enables it
through ordinary plugin management after configuring `runtime.daemonEntrypoint`
and `runtime.cliDirectory` in the private control-plane configuration. The managed
runtime supplies the execution-context socket, enrolls one daemon with a private
machine credential and disables that daemon's local HTTP API. Linux deployment
requires `/usr/bin/setpriv`; parent-death protection stops the daemon when the
server exits unexpectedly. The root job supervisor independently checks its
original service ancestors before retaining an agent process.

Every launch requires a private execution-context socket and a server-owned BB
thread identity. The provider requests the registered user UID/GID, HOME, cwd
and native Qwen session binding plus its bound approved profile version; caller-selected paths and identities are not
deployment settings. No shared-service fallback is allowed.

The root-owned launcher policy selects the Node and Qwen CLI files. A privileged
supervisor drops the child to its numeric UID with cleared groups and no new
privileges, and owns cancellation of that job's descendants. Agent UIDs have no
sudo rule. Unix permissions protect personal data; they do not restrict all
readable system paths.

Execution also requires `/usr/bin/unshare` and Linux unprivileged user namespaces.
Each job preserves its numeric UID/GID inside separate user/PID/mount namespaces,
with a proc view containing only that job's processes. Concurrent jobs for one
user share HOME. Namespace failure rejects execution with no UID-only fallback.
For Docker, use the derived seccomp profile and proc-mount options documented in
`deploy/control-plane/security/README.md`; do not add `CAP_SYS_ADMIN` or use a
privileged container. The root supervisor retains the outer PID view for cleanup.

Deployment environment on the host bridge:

- `QWEN_SERVER_CONTEXT_SOCKET`: private control-plane execution socket.
- `QWEN_SERVER_BASE_URL`: optional OpenAI-compatible backend for testing.
- `NEURALDEAP_KEY`: optional backend key, required with the testing base URL;
  forwarded only in the child environment. Never print it or put it in options.

Without the testing backend, Qwen uses the registered user's HOME configuration
and its existing authorization mechanism. An optional CLI `auth_required` event
can render a sign-in URL; do not claim that a corporate fork emits it unless
that executable has been verified.

Server integration is under development. Do not enable this provider for
unowned threads or infer identity from a cwd alone. Approved dynamic BB tools use the provider-owned `bb` SDK MCP adapter. Permission modes must match the bound profile; service-user harness execution
is rejected.

The profile fixes the model, reasoning, appended instructions and exact native
Qwen tool allowlist. Caller exclusions can reduce capabilities. Unsupported
MCP transports, unknown tools, permission mismatches and mismatching model
requests fail before launch. SDK MCP instances are not connected as the shared
service user. Model fallback configuration, hooks, extension loading and
user-configured MCP are disabled in the protected execution policy.

Policy files are created per job by the root supervisor outside writable HOME,
readable only by the registered UID and removed after descendant cleanup. A
Node preload injects private instructions without putting them in kernel
process arguments. The installer pins the reviewed stock CLI JavaScript
artifact (SDK 0.1.22, CLI 0.26.0); a different artifact requires another policy
review and deployment test. This pin does not establish corporate CLI support.

Approve a BB tool with `mcpServers: ["bb"]` and `tools: ["bb:<registered-name>"]`
in the immutable profile definition. Native Qwen names stay unprefixed. The
available BB catalog is filtered in core, validated by the provider and checked
again at each MCP list/call. Calls use the native BB tool channel and repeat
current profile/project checks before invoking a trusted server plugin. An
unavailable or unsupported tool fails explicitly. Caller exclusions reduce
capabilities; they never enable a tool. `update_environment_directory` remains
unsupported for managed threads.

The protected policy clears HOME-configured MCP servers before registering the
provider-owned adapter, including an impostor named `bb`. User-supplied SDK MCP
instances and arbitrary stdio/HTTP MCP transports are rejected. Full private
SDK calls from user-principal plugin code remain denied until their scoped
adapters are implemented; central service/admin plugin code retains its access.

`full` selects Qwen `yolo`. `accept-edits` approves canonical project-local
`edit`/`write_file` requests automatically and routes other native requests to
BB's interaction UI. `auto` selects the pinned CLI's native classifier mode;
classifier failure falls back to the BB approval channel. These policies do not
add a filesystem jail. HOME permission rules and auto-allow settings are cleared.
Native nested-agent/workflow/team and mode-changing tools are rejected in
restricted profiles until their adapter is verified.

Approvals preserve native request/tool/turn IDs, offer only allow-once/deny and
recheck current grants after a positive decision. Stop, timeout, transport exit
and bridge disposal deny outstanding requests. The deadline is at most five
minutes. Administrative integrations use `threads.interactions` and
`bb thread interactions list|approve|deny`; the personal API is still pending.
Do not replace this transport with the SDK's high-level `canUseTool` callback
without preserving tool-use IDs: that SDK callback omits them.

Managed `bb_workflow_run` is currently blocked by core even when a profile lists
it: tenant-authored workflow scripts must receive the registered UID adapter
before that tool can be enabled. Trusted unmanaged administrative workflows
retain their ordinary behavior.
