---
name: qwen-server
description: Diagnose the shared-server Qwen provider and its registered Unix execution context.
---

# Qwen Server

Provider ID: `qwen-server`. This provider is for the shared control-plane
deployment, not an unrestricted local Qwen executable.

Every launch requires a private execution-context socket and a server-owned BB
thread identity. The provider requests the registered user UID/GID, HOME, cwd
and native Qwen session binding; caller-selected paths and identities are not
deployment settings. No shared-service fallback is allowed.

The root-owned launcher policy selects the Node and Qwen CLI files. A privileged
supervisor drops the child to its numeric UID with cleared groups and no new
privileges, and owns cancellation of that job's descendants. Agent UIDs have no
sudo rule. Unix permissions protect personal data; they do not restrict all
readable system paths.

Deployment environment on the host bridge:

- `QWEN_SERVER_CONTEXT_SOCKET`: private control-plane execution socket.
- `QWEN_SERVER_MODEL`: default model when the approved request has no override.
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
