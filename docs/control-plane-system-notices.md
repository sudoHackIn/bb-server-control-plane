# Managed parent relations and system notices

Parent changes use two checkpoints: the core API preparation checks the proposed
relationship before asynchronous work, and `updateThread` checks again inside
the database transaction that changes the parent. If either endpoint is managed,
both threads need the same saved owner and current access to both projects.
Managed/unmanaged links and unknown managed owners are denied. Detaching a parent
remains available for cleanup. Ordinary unmanaged single-user relations retain
their existing behavior.

Core-owned parent notices have metadata authority distinct from permission to
execute the source agent. Ownership changes and child attention/completion/
failure/interruption require a typed thread subject. Batched outcomes check every
referenced thread and require a complete outcome list. Archived source threads
may report their results; deleted sources and revoked source project access are
rejected. Retiring the source profile does not suppress an otherwise authorized
status notice. The destination always needs its current execution authority.

The guard runs before queueing, at canonical request commit, when reading copied
or retried request ancestry, and before actual daemon transport after reconnect.
A saved queued notice is rechecked at delivery, including after restart. A mixed
owner batch fails in full rather than filtering its metadata while retaining the
original body. Core renderers remain trusted to construct matching body and
subject; typed subject metadata does not authenticate arbitrary caller text.
Neither the limited public message API nor the provider gets a new system-notice
write capability.

Detached tool completions retain their server-captured target and validated tool
name. They do not take a new user identity from the completion body. Directory
continuations must match both the current thread environment path and registered
project cwd. Explicit unlabeled managed notices are refused. The existing stored
event reader supplies an `unlabeled` display default even for ordinary messages;
authorization distinguishes this default from an explicitly saved notice field.
Ordinary messages and workflow notifications still use their existing source
markers and exact durable notification receipts.

# Legacy deferred input

The pre-queue `deferred_thread_messages_legacy` table has no verified user/source
provenance. Shared-server startup retains these rows without parsing or executing
them, including rows targeting an unmanaged operator thread. A non-deleted target gets
one passive `system/error` event per retained row with code
`legacy_deferred_not_authorized`. Repeated startup attempts do not duplicate this
event. Its detail identifies the retained row; its message does not copy the old
payload. No model request, source marker or new queue item is created.

Normal single-user startup explicitly enables the old unowned backfill, but even
there a managed target cannot regain replay permission by disabling shared-server
configuration. Managed archived/deleted targets retain their raw rows too;
missing targets follow the existing legacy cleanup behavior. This is not an
administrative owner-assignment migration: original payloads remain available to
the operator, while continuation requires a new authorized submission.

These are server policy changes. Host daemon protocol 253, Plugin SDK 0.6.80 and
public request/event schemas are unchanged. Existing timeline/history/result
surfaces expose the passive error through UI, SDK and CLI.
