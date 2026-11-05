# Project webhook triggers

A webhook binds an authenticated owner, an accessible execution project and an
immutable published agent version. The trigger calls the same complete agent
admission service as manual background runs, so conversation and workflow agents
retain native history, dispatch checks and the registered UID/HOME/cwd. Trigger
management is available in the personal Webhooks view, restricted API, SDK and
`bb server access webhooks` CLI. Administrators still publish the agents.

## Contract

Create with `POST /control-plane/user/webhooks` and
`{projectId, profileVersionId, name, inputField}`. `inputField` defaults to
`input` and selects one top-level JSON string field, not a template or executable
mapping. The target is immutable; create another trigger to change it. Creation
returns `{webhook, secret}`. Only the SHA-256 digest of the random 256-bit secret
is stored. Ordinary reads never return it. `POST /:id/rotate` replaces it and
returns the new one-time secret. `PUT /:id` with `{enabled}` disables/enables
future admission without cancelling existing runs.

GET collection requires `projectId`; collection/history accept UUID cursor and
limit 1–50. GET `/:id/history` returns delivery records. Every management read or
mutation requires the owner and current project access; enabling and creating
also require current execution and profile access. A foreign ID is 404.

The sole external route is `POST /control-plane/webhooks/<uuid>/deliver`.
It accepts `Content-Type: application/json`, `Authorization: Bearer whk_…` and
`X-BB-Delivery-ID` (1–200 ASCII letters/digits, `_`, `.`, `:`, `-`). Other methods,
subpaths and the general BB API are not exposed. User/admin credentials alone
cannot deliver. Query parameters are rejected. The external secret permits
submission only; it does not grant project, thread, result or history reads.

The body is bounded at 256 KiB, including streamed requests. The selected field
must contain non-blank text of at most 128 KiB. Other payload fields never choose
owner/project/model/tools/permissions. Execution resolves the saved owner and
rechecks current project/profile authority, rather than depending on a browser
session's lifetime. Existing native dispatch and recovery checks remain in force.

## Delivery identity and recovery

The database atomically reserves `(webhookId, deliveryId)` and hashes the exact
body bytes before native admission. Identical concurrent/retried delivery returns
the same reservation and native identity. A changed body under the same ID is
409, including changes only to JSON formatting. Core generates the private
`webhook:<reservation UUID>` native idempotency key; public agent-run creation
cannot supply this prefix. The database retains hashes and delivery metadata,
not another copy of input/output. Native BB runs own their input and results.

A 202 `accepted` delivery means the native run was admitted, not that the agent
succeeded. Open the run's inspection/result to see execution status. A 422
`failed` delivery records invalid mapping or unavailable admission without
returning raw provider diagnostics. Failed/pending admissions can be retried with
the same ID and bytes after fixing access or availability; admitted runs are not
re-executed. Up to 64 admissions may be in flight per service; saturation returns
429 and asks the sender to retry. No extra scheduler or automatic recovery queue
is introduced. After a crash/lost response, source redelivery resumes the saved
reservation via native idempotent admission. Exactly-once external effects are
not promised. Disabling or rotating blocks future requests, not work already
admitted before the change.

Rejected credentials, oversized bodies, missing IDs and unsupported media types
are rejected before reservation. Authenticated mapping/admission failures appear
in owner-scoped history. The Agents task list labels acknowledged webhook runs
as Webhook. History opens the existing read-only run inspector; no independent
conversation composer is added for background runs.

## Interfaces and scope

The SDK is `createControlPlaneClient(...).webhooks` with `create`, `get`, `list`,
`history`, `setEnabled`, `rotate` and `deliver`. The CLI has corresponding
create/get/list/history/enable/disable/rotate/deliver commands. Delivery reads
its secret from stdin and JSON from `--payload-file`; neither belongs in a URL.
The installed CLI guide documents flags and response semantics.

This initial generic protocol uses bearer credentials over HTTPS. It does not
claim compatibility with vendor-specific webhook signatures, implement custom
code mappings, scheduled redelivery, polling, or structured agent contracts.
The schema migration is `0168_condemned_viper`. No host-daemon wire change or
plugin API capability is required. Corporate Qwen authentication is not part of
this delivery verification.
