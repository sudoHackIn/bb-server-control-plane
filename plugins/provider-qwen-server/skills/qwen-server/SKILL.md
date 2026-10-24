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
unowned threads or infer identity from a cwd alone. Dynamic BB tools remain
disabled until their delegated access adapter is enforced. Only Full access
inside the registered Unix identity is supported; automatic/manual approval
and service-user execution are rejected.

The profile fixes the model, reasoning, appended instructions and exact native
Qwen tool allowlist. Caller exclusions can reduce capabilities. Unsupported
MCP profiles, non-Full approval modes, unknown tools and mismatching model
requests fail before launch. SDK MCP instances are not connected as the shared
service user. Model fallback configuration, hooks, extension loading and
user-configured MCP are disabled in the protected execution policy.

Policy files are created per job by the root supervisor outside writable HOME,
readable only by the registered UID and removed after descendant cleanup. A
Node preload injects private instructions without putting them in kernel
process arguments. The installer pins the reviewed stock CLI JavaScript
artifact (SDK 0.1.22, CLI 0.26.0); a different artifact requires another policy
review and deployment test. This pin does not establish corporate CLI support.
