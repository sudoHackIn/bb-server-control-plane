# Execution admission during server shutdown

The core server closes execution admission synchronously at the start of its
shutdown function, before awaiting plugin service cleanup or stopping the managed
daemon. The periodic sweep timer is cleared at the same boundary. Admission is
monotonic for that server's database connection and does not depend on an installed
policy plugin. A new server process opens a new connection and admits work after
its normal authentication and authority checks.

Core thread creation, turn submission, queue creation/claims, pending first-turn
admission, workspace restore/reprovision and parent system messages use this gate.
The private background factory/facade and script launcher also reject new work.
Metadata and authority rechecks remain usable for cleanup. A rejected HTTP/SDK
execution request receives 503 `server_stopping` with `retryable: true`; authentication,
schema validation and entity lookups can still reject an invalid request earlier.

Checks repeat at the mutation boundary after asynchronous preparation. Losing the
shutdown race cannot consume a claimed queue row or append a new turn request.
Queue claims are released and shutdown does not spend the row's retry budget.
Automatic wakes become no-ops while stopping. An already accepted request can be
interrupted before the daemon receives it; its durable request and normal command
settlement remain the recovery evidence, rather than a claim of delivery.

The single host online-RPC sender checks admission before initial waits and again
before each actual transport attempt, including retries. Machine wake policy is
separate: approval resolution can continue an agent without waking a machine and
is therefore refused during shutdown. The default is to refuse an RPC. The explicit
cleanup exceptions are thread stop/storage deletion/archive/plan cancellation,
rewind discard, environment attach/hook cancellation and cleanup inspection,
plugin host cancel/dispose, browser close/release-control and server-move abort.
Environment teardown hooks and plugin host cleanup under the existing scoped
machine-removal context remain permitted. These exceptions retain their existing
entity, context and authority requirements.

Immediately before sending `thread.start` or `turn.submit`, core also checks the
saved thread's current owner/project/profile/source authority. Queued provider
session continuation and parent notifications repeat current-authority checks
before changing history. This closes those asynchronous preparation gaps; it does
not replace the broader audit of machine-originated requests or user context
propagation through every queue, schedule and plugin operation.

Real-SQLite tests cover full SDK requests through HTTP without a policy plugin,
queue preservation, late creation, reads/stop after quiescence, reconnect/retry
races and approval continuation. The Docker fixture pauses an actual trusted
plugin service during shutdown through a test-only file barrier. While the server
is still listening, it verifies both the plugin's private SDK and administrator/
personal HTTP requests reject new work, reads and personal stop remain available,
and rejected calls create no threads or turn events. Releasing the barrier allows
the normal daemon/plugin cleanup and restart/crash checks to continue.

This gate does not forcibly terminate a hung trusted callback or turn every plugin
SDK mutation into an execution operation. Pending-disposal storage retention is
described in [the script runtime](control-plane-script-runtime.md). Forced process
shutdown, explicit legacy ownership and the complete background/machine-RPC audit
remain separate acceptance requirements.

## Managed daemon requests and approvals

Inbound tool calls and provider interaction registration also use the core shutdown
gate. For managed threads, core requires current saved owner/project/profile/source
authority, an active or starting thread, the current uncompleted root turn, an owned
stored provider session and an exact match to the native Qwen session bound by the
private context resolver. Interaction provider IDs must match the thread. The
machine/session/host check runs first; caller-supplied user/project arguments do not
choose the tool principal.

The pending-interaction lifecycle applies the same check before registration and
resolution, including full SDK/API calls. Reusing a provider request identity for
another thread or turn returns no existing interaction ID. A stale or revoked
approval is refused before its pending row becomes resolving. Before each actual
outbound resolution attempt, core resolves the turn from the saved interaction and
checks its status, saved decision, provider/request identity, environment and host. This preserves
the existing version-253 daemon payload, which does not contain a turn ID.

An enrolled daemon remains trusted for its assigned host and can report that host's
thread events. These checks do not claim to isolate tenants from a compromised host
daemon or to authenticate a new end user from a machine credential. Unmanaged
single-user provider semantics remain unchanged except for the global shutdown
gate and exact pending-request identity reuse checks. Interrupting an existing
interaction remains a host-scoped cleanup action after revocation or shutdown.

The real-Qwen Docker scenario holds two owners' model requests active, exercises
authorized tool calls with forged owner arguments, rejects stale/cross-session
tool and interaction requests, revokes one profile while the other owner remains
usable and interrupts the revoked owner's pending request. Completed-turn calls
are refused. The shutdown barrier checks inbound tool/approval refusals against
the current daemon session after a supervised daemon restart.

The native approval revocation scenario now expects core 403 before dispatch and
then explicitly stops the pending thread; its forbidden command must still leave
no file. This proves the earlier core refusal. It does not turn that scenario into
a new test of the provider's post-approval race after an already-delivered allow.

## Trusted plugin schedules

Plugin cron sweeps check both server shutdown and irreversible background
quiescence at entry and before each claim. Clearing the ordinary reversible
schedules-paused flag cannot reopen a quiesced runtime. A callback admitted before
quiescence may finish; remaining due rows keep their deadlines and attempt state.
This is trusted centrally installed plugin code, separate from personal automation
definitions and their persisted user authority.

Real-SQLite tests cover an in-flight callback for both stop boundaries. Docker
uses the actual periodic sweep, two fixture-owned cron rows and a file barrier.
Only those disposable rows' due timestamps are advanced by the test; callback
dispatch and claim/settlement run through production code. After shutdown begins,
the first callback settles and the second remains unclaimed.
