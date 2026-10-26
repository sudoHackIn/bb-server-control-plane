# Shared project directory access primitive

Increment 65 adds an internal Linux filesystem primitive for a future shared
project runner. Public project execution remains owner-only. No personal role
mutation endpoint, shared Qwen admission or shared workflow execution is enabled
by this increment.

## Identity and policy boundary

The trusted service calls `prepareProjectAccess` with the storage owner's saved
identity, immutable project ID/slug, a positive safe-integer revision and at most
128 registered member identities. The fixed privileged helper checks UUID/UID
manifests, reserved numeric identities, system-account collisions and project
ownership. Members do not receive system accounts, supplementary groups, sudo or
a service credential. Every agent retains its own HOME and UID.

The helper's root-owned applied-policy ledger lives under
`/var/lib/bb-agent-launcher/project-access`, separately from UID manifests. It is
an execution mirror, not the central role database. The helper accepts calls only
from trusted service code through the existing fixed sudo rule. A future policy
service must derive member lists and monotonically increasing revisions from
current database grants; this primitive does not authenticate an end user or
interpret owner/runner/viewer roles.

## Filesystem behavior

Only the exact registered project directory receives member read/write/traverse
ACLs. The owner's projects parent grants traversal without listing; its member
set is the union of applied grants for that owner's projects. Revoking one
project does not remove access to another. The storage owner and central service
retain explicit project access. HOME and unrelated project ACLs are unchanged.

Existing regular files and directories are updated using descriptor-bound Linux
libacl calls. Directory defaults provide inheritance for normally created files.
An owner can still change their own file modes; this is POSIX discretionary
access control, not a guarantee that every future file remains collaborative.
Symlinks are skipped, without modifying their targets. Hardlinks, special files,
foreign filesystems, privileged mode bits, unsupported owners, cycles and excessive
trees are refused. Limits are 100,000 entries, depth 128, a cooperative 20-second
traversal budget, 64 KiB input/state and a 30-second service-call timeout.

A root-only global helper lock serializes policy application. The ledger rejects
project ID/owner/slug rebinding, lower revisions and different members at the
same revision. It writes and fsyncs a pending revision before applying ACLs. A
failed newer revision therefore cannot be undone by an older grant. New members
remain blocked at the project root until completion; retained members keep their
existing root access. Removed members lose fresh root-path access during the
update. The same revision and member set can repair an interrupted application.
The ready record is atomically replaced and fsynced only after tree validation.

## Execution boundary before increment 67

The original helper lock serialized helper calls; it did not freeze agent filesystem
operations. Descriptor checks and the final root inode check do not make a
recursive ACL update atomic against hostile concurrent rename/hardlink activity.
The static substitution checks in this increment are not proof of safety under
those races. Production shared execution must first provide an exclusive
filesystem mutation boundary, or a stronger isolated filesystem design, before
this primitive can be wired into user-facing grants.

Likewise, changing ACLs does not revoke already open descriptors, erase copied
files or cancel jobs. The next policy/execution stages must coordinate active
processes, database revocation, pending recovery and actual launch/resume before
acknowledging a role change. A failed update never counts as a successful grant
or revocation. The legacy helper still rejects launching Bob's Qwen in Alice's
project, even when a test has explicitly granted Bob filesystem access.

## Reproduction

Run the focused disposable Docker check from the repository:

```sh
pnpm exec turbo run test:control-plane-project-access --filter=@bb/server
```

It builds the same production image and uses real migrated SQLite, the compiled
TypeScript wrapper, the installed helper and three numeric UID/HOME identities.
Anonymous Docker volumes are necessary: the host's Docker tmpfs does not support
these POSIX ACLs. The container is read-only, has no network or added Linux capabilities, and uses
the deployment's narrow seccomp allowances for user/PID namespaces. It is removed
with its anonymous volumes. A 120-second outer deadline
also removes a failed test container.

The complete `test:control-plane-deployment` includes the same check and repeats
its stale-grant/read-denial assertion after the existing native BB restart and
crash-recovery matrix. The standalone check proves helper-process persistence;
only the full deployment proves persistence across a BB server restart. Browser
code and public contracts are unchanged.

## Database policy revisions (increment 66)

`control_plane_project_policies` stores each project's desired revision and its
last acknowledged applied revision. Migration 0159 backfills existing registered
projects with revision 1 and no acknowledgement. New projects get a policy row
inside their creation transaction. SQLite triggers advance the revision on
changed grants, registered identity/readiness, storage binding, native source,
project visibility/deletion and host destruction. Direct SQL mutations use the
same triggers. No-op role writes and unrelated user/display changes do not
invalidate a policy. Revision overflow rejects the authority mutation atomically.

`getControlPlaneProjectAccessPolicy` reads a transactional snapshot from the real
registry and source joins. Only enabled, ready runners other than the actual
storage owner become filesystem members. Viewers and a forged nonowner `owner`
role confer no filesystem rights. A disabled/unready owner, missing owner grant,
inactive project/host, mismatched source, provider-owned source or inconsistent
canonical slug/cwd yields no members. The helper still validates UUID/UID
manifests; database revision tracking is not a substitute for those checks.

`acknowledgeControlPlaneProjectAccessPolicy` succeeds only for the current exact
revision. A grant change during helper execution therefore leaves the newer
policy unacknowledged. The old applied revision remains visible for recovery;
repeat acknowledgement of the current revision is idempotent. These are internal
trusted-service functions, not an end-user API or proof that a helper was called.
The caller must validate the helper receipt before acknowledging it.

The Docker fixture now derives a separate project's helper input from database
roles, applies the returned revision and records the exact receipt. It checks
runner write access, viewer downgrade, removed grants, regrant and stale receipt
rejection. After the full BB restart/crash matrix, it reapplies the saved empty
policy and rejects both an old database receipt and an old helper grant.

Automatic production reconciliation and public role changes remain disabled.
The exclusive filesystem mutation boundary and active-job coordination described
above are still required before exposing grants or shared Qwen execution. This
increment persists the necessary authority/recovery state without treating an
uncoordinated ACL update as safe production revocation.

### Execution prerequisite recorded before increment 67

The next implementation must give every managed UID a launcher-owned lifetime
lease across Qwen, script, workflow and workspace jobs. Launch must acquire its
shared lease before releasing the existing global helper lock. ACL application
must acquire exclusive leases for the storage owner and old/new member UIDs,
without waiting while holding the global helper lock; busy execution must return
without filesystem changes. A root process check must also refuse unknown or
orphaned live processes under those UIDs, including the monitor-crash gap. This
is a proposed prerequisite, not a mechanism implemented by increments 65–66.

Pending helper state must retain the previous writer identities until a
successful quiescent reconciliation. Removing a UID from desired or active grants
must not erase its participation in the cleanup barrier. Legacy pending records
without a provable prior-writer set require quarantine rather than guessed
revocation. The initial transition into coordinated execution must also account
for pre-existing open descriptors and unsupported hardlinks.

The service can then stop the affected managed runtimes through their supported
lifecycle, wait for acknowledged cleanup, retry the saved policy and acknowledge
only its still-current revision. Histories/HOME survive; subsequent cold resume
must recheck current grants. Until those lifecycle and race cases are tested,
public grant changes and shared launch must remain closed. This design assumes
host-local managed storage and trusted service/root writers; arbitrary external
filesystem writers would require a different isolation boundary.


## Managed UID lifetime barrier (increment 67)

Every Qwen, workflow, script and workspace job acquires a root-owned shared UID
lease before the helper releases its global launch lock or creates an agent
process. The supervisor retains that descriptor through descendant cleanup and
job-record removal. It is not inherited by the agent. Several jobs under one UID
share the lease normally; an unrelated UID can continue to launch.

Project ACL application acquires nonblocking exclusive leases for the storage
owner and every previous/new writer UID before opening or changing the project.
It checks root-owned job records even when a supervisor is already dead. A live
job, unconfirmed cleanup or a conflicting lease refuses application without
changing ACLs or applied-policy state. Stopped-before-launch tombstones are not
live jobs. A `/proc` check also refuses observed unmanaged processes under the
selected real/effective/saved/filesystem UIDs. Zombie processes do not retain
file descriptors and do not block this check.

The root policy's `writers` set retains previous and newly requested identities
through pending failures. It shrinks only after a successful quiescent tree
application. A removed grant cannot disappear from the cleanup barrier merely
because it is absent from the new desired/active member list. Legacy ready
records without this set require an all-registered-UID idle check under the
global helper lock before adoption. Legacy pending records without prior-writer
provenance are refused for operator review; their policy and ACLs are unchanged.

The safety contract is that managed UID processes originate through the fixed
launcher. Shared leases plus persistent job records cover its pre-spawn and
supervisor-crash gaps. Process enumeration is an additional refusal check, not a
kernel-wide freeze or proof against hostile unmanaged UID process creation.
Storage remains host-local, with trusted service/root writers. This does not add
cgroups, a filesystem jail or control over arbitrary external filesystem writers.

Real Docker tests start two namespaced script jobs under the same UID, each with
a child holding a project file descriptor. Mutation remains blocked after stopping
only one, succeeds after both acknowledged cleanups, and then denies fresh reads.
Other cases cover stale supervisor records, a stable unmanaged process, failed
new admission before job registration, another UID continuing to launch, stopped
tombstones, pending former writers, legacy ready adoption and legacy pending
quarantine. Busy attempts compare both the saved policy and exact project ACLs.
The fixture removes only its own verified tombstone after testing, preserving
other jobs and the existing missing-directory cancellation-fence scenario.

Public role mutation, automatic reconciliation and shared native launch remain
closed. The next service layer must persist and enforce admission fences for all
affected UIDs through stop, helper application and exact database acknowledgement,
including stale acknowledgements, retries and restart. Releasing the filesystem
lease alone is not such a service fence: a changed database policy must not leave
a gap where another owned project launches a process with obsolete shared access.
Histories/HOME must survive the coordinated stop and subsequent authorized cold
resume. These remaining steps are required before opening shared execution.

For that next layer, a persisted root UID maintenance fence must also block
already queued launcher requests, not only fresh server admission. Enter it
before draining jobs; retain it through helper application and exact-current
acknowledgement, and after failures/restart. Serialize administrative grant
mutation and the final acknowledgement/unfence per affected UID, and require
matching fence generations so an old completion cannot release a newer fence.
Administrative grant management is the planned mutation surface; tenant project
metadata access must not become permission to cancel another user's private jobs.
These are remaining requirements, not claims about increment 67.


## Persisted UID launch maintenance (increment 68)

The fixed helper now has private `uid-maintenance` begin/status/finish operations,
used through the typed server `controlPlaneUidMaintenance` adapter. Its records
live in root-owned `0700` `uid-maintenance` storage inside the existing launcher
volume; individual records are `0600`, UUID/UID-bound, bounded and opened without
following symlinks. Begin/finish use atomic replacement, fsync the file/directory
and launcher parent, and run under the existing global helper lock. No new sudo
rule, system account, public route, Plugin SDK surface or daemon wire field is
introduced.

Begin persists an active, positive safe-integer generation while existing jobs
may still run. Every managed launch checks it before acquiring a UID lifetime
lease, writing a job record or creating the agent process. Stop and read operations
remain available for draining and recovery. Other UIDs are unaffected. The marker
continues blocking after jobs stop and after the filesystem policy becomes ready;
those events never implicitly release it.

A newer generation supersedes an older one while remaining blocked. Repeating
an active begin or completed finish is idempotent. A stale completion cannot
release a newer generation, and a closed generation cannot be reopened. The
highest generation remains on disk after release. Finish requires the current
generation, exclusive UID quiescence and no pending root project policy involving
that UID as storage owner or writer. Unknown legacy pending writers refuse release.
Failed precondition checks leave the barrier active.

The caller still owns product authority: this helper cannot inspect central DB
revision acknowledgements or decide which operation may finish. I/O failure or
lost acknowledgement after atomic replacement can leave an operation committed;
status and same-generation idempotent requests resolve that uncertainty. There is
no exactly-once or cross-database/filesystem transaction claim.

Docker exercises two live descriptor-holding jobs during begin, replacement and
stale finish, an actual service request prepared before begin and dispatched
afterward, post-ACL blocking, pending-policy refusal, integer/identity validation
and agent inability to unlink the marker. A final active generation stays in
place through the entire BB deployment/restart/crash matrix; a fresh helper then
confirms it still blocks launch, releases it explicitly, verifies preserved HOME
contents under the same UID and advances to a newer generation.

Public roles and shared Qwen execution remain closed. The next controller must
derive affected identities from both saved root writers and current DB grants
(including removed/disabled participants), persist its DB operation/affected-UID context, serialize administrative changes,
enter these root barriers before draining, apply the current policy, acknowledge
its exact DB revision and only then finish the corresponding generations. It
must recover incomplete operations and root high-water generations after restart,
and expose current maintenance to mandatory server admission so rejected starts
are retained appropriately. The root marker closes the launcher gap but is not
that controller or an end-user grant API.

## Durable server intent and launch generations (increment 69)

Migration 0160 stores each UID's latest maintenance operation, generation, pinned
project revision and phase (`blocking`, `blocked`, `releasing`, `idle`). A missing
row means initial generation zero. The private per-UID coordinator reserves the
blocking DB row before beginning the root barrier, using the maximum saved/root
high-water generation plus one. It checkpoints the root begin and requires an
exact current/applied project revision before release. Root finish is followed
by another transactional DB revision check before admission becomes idle.

The same operation can retry an interrupted begin or finish; closed operation IDs
cannot reopen. A changed policy or superseded generation keeps admission blocked.
Explicit restart of the current generation pins the new policy revision and
allocates a higher generation; old completion receipts cannot release it.
Active operations retain their project context. Deleting a completed project
clears only that nullable reference and preserves the UID generation, preventing
an old context from becoming valid again. This table is latest-operation state,
not a complete administrative operation history.

Managed thread creation/dispatch/context resolution, background job authority and
workspace execution refuse non-idle UID intent. Thread metadata and explicit
cleanup/stop remain available. Authority captures the maintenance row before
checking current grants and emits that same generation; it does not combine an
old grant check with a freshly reread pending generation. Workspace resolution
also revalidates current owner, canonical cwd and user readiness.

Every Qwen, workflow, script and workspace launch now carries an explicit
`--uid-generation` prefix through the trusted launcher. Root admission compares
it with the saved UID generation even after the barrier has been released. This
closes the delayed-command gap: an old prepared request cannot start with stale
authority merely because maintenance is over. Unversioned commands retain only
generation-zero compatibility before the UID's first maintenance operation.
Stop commands do not require a launch generation.

The workspace identity wire field is required, so host daemon protocol is 256;
255 is refused. The Qwen Server plugin is 0.1.1 and requires the corresponding
private context field. Deploy server, daemon, helper modules and provider together.
The Plugin SDK API version is unchanged; stock Qwen SDK behavior is unchanged.

Docker reserves a DB/root operation before the BB restart matrix. After restart,
the private coordinator reads its saved blocked phase, verifies current policy,
releases it and rejects a command prepared before that operation even though root
is now unblocked. A fresh job preserves UID/HOME. A subsequent policy change
refuses completion until explicit rebase and exact revision acknowledgement.
Real migrated-SQLite tests cover ordinary/background admission, metadata privacy,
other-user execution, phase/generation CAS, overflow, rollback, repeated migration
and active/completed project deletion behavior.

This remains a private per-UID controller. Public role mutation, multi-UID project
reconciliation and shared native launch remain closed. The next integration must
resolve all saved/current writers, reserve their intents atomically with the
administrative grant change, drain runtimes through supported lifecycle, apply
and acknowledge the pinned filesystem policy, finish all participants and resume
pending operations at startup. It must retain queued work appropriately and ship
administrative API/SDK/CLI/UI controls. None of those end-user surfaces are implied
by the new internal coordinator.

## Durable project participant coordinator (increment 70)

Migration 0161 stores each private project maintenance operation with its pinned
policy revision, attempt, complete participant/generation snapshot, phase and
worker claim. Reserving all participant UID intents is one SQLite transaction;
a conflict on any UID rolls back the entire reservation. Participants include
the owner, current runnable members, root's saved former writers and the previous
attempt's participants. Removing a database grant therefore cannot hide a process
which still holds a shared file descriptor. Explicit rebase retains those identities
and advances generations; stale attempts cannot complete it.

The coordinator advances preparing → draining → applying → releasing → complete.
It blocks every participant in the database before root barriers, confirms stops
before applying the pinned ACL, acknowledges only the same current revision, and
finishes every root barrier before atomically returning all database UID intents
to idle. A crash after one root release leaves the entire service cohort blocked.
Recovery reclaims only an exited worker, retains previous participant identities
and retries the remaining release without reopening a closed root generation.
A live worker cannot be stolen. An uncertain stop retains its claim while that
process is alive, avoiding a second coordinator racing an unfinished stop request.

The privileged helper now exposes private validated project-writer inspection
and a bounded job-ID listing for the exact blocked UID generation. The latter
includes stale supervisor records and fails closed if cleanup cannot be confirmed;
it does not silently delete them. The required stop callback is responsible for
BB lifecycle settlement before helper job cleanup. The independent per-UID
controller refuses grouped operations. The native BB adapter remains pending: its
pre-start/active/idle settlement and queue retention must be verified before it is
connected to project maintenance.

Docker exercises two real numeric users, namespaced script jobs and a descendant
holding a shared descriptor. It verifies grant, drain, former-writer revocation,
partial root release, persisted worker/participant state, recovery after the BB
restart matrix and unchanged shared content and private HOME access. SQLite tests
cover cohort rollback, exact phases/revisions, rebase, identity substitution,
worker CAS and active/completed deletion. Server tests reject live-worker takeover,
independent UID release and conflicting duplicate requests.

This is private reconciliation of an already saved policy. Administrative role
mutation is not yet combined atomically with cohort reservation. Automatic startup
sweep, queue-specific retention, public role API/SDK/CLI/UI and actual shared
native Qwen launch remain subsequent work. A maintenance operation with live
Qwen/workflow queues still needs its own lifecycle adapter and integration check;
the Docker cohort scenario uses real script jobs and an empty BB-thread registry. Existing ordinary native runtime deployment checks remain separate.
Host protocol 256, Qwen Server plugin 0.1.1 and SDK 0.6.80 are unchanged.

## Queue retention during UID maintenance (increment 71)

Thread and background authority errors retain a private `maintenance` reason.
The ordinary error classes, messages and HTTP authorization mapping stay intact;
project, identity and profile checks still reject invalid authority before the
thread guard classifies an otherwise valid request as temporarily blocked.
Background authority preserves that reason through its existing conversion.

Both automatic queue drain and explicit send release their claims and keep input,
source identity, waits, scheduled time and retry metadata when the mandatory
execution guard observes maintenance. A maintenance refusal is not recorded as a
failed attempt, including when the UID has already been released by the time the
failure handler runs. After release, dispatch performs the ordinary current-grant
and source checks again. This does not exempt revoked grants from authorization.

The Docker check reserves a real native user's DB intent and an existing queue
row atomically, activates its root barrier, and repeatedly invokes the normal BB
queue-send HTTP route. It checks unchanged input/retry metadata, no accepted-turn
events and cleared claims. It stops every owned native thread through the normal
HTTP route and requires no remaining root launcher jobs before applying and
acknowledging the pinned project policy and finishing maintenance. That same queue
row runs once through the actual Qwen provider in its existing session under the
advanced UID generation. Later workflow, automation, restart and crash checks use
that generation too.

This covers refusals observed by queue admission. An already accepted turn is a
durable turn request, not a retained queue row; its interruption and recovery still
need the native maintenance drain integration. Confirming pre-start/active/idle
runtime settlement, preserving intentional queue pauses and wiring automatic
startup reconciliation remain pending. Public role mutation and shared native
execution remain closed. No database schema, host wire contract, SDK API or
production frontend changes are introduced by this increment.


## Native lifecycle drain and recovery (increment 72)

The production adapter enumerates every non-deleted owned BB thread across the
participant's projects, including archived threads. Each stop checks the same
blocked UID operation/generation and thread owner. It revokes desktop control,
cancels pre-start work, interrupts an active turn and awaits idle runtime release.
The existing 60-second stop budget is shared across settlement attempts. An
unknown acknowledgement or generation change fails closed; the project worker
claim remains held while that process lives. No ACL is applied on an uncertain
native stop. Root job quiescence is still required independently.

`access-maintenance` is a persisted interruption reason rather than a user pause.
Queue pause detection ignores it when looking for a later action which clears a
manual pause. An explicit user Stop during maintenance records manual intent even
if the thread is already stopping. Late daemon turn-state reports preserve the
stored interruption reason and cannot revive a stopped turn. If global server
shutdown overlaps maintenance, visible personal execution requests retain the
existing retryable `503/server_stopping` response; foreign thread IDs still fail
the ordinary visibility check. Accepted turns keep
their durable interruption; this does not promise automatic replay of side effects.

The five-second sweep reconciles saved project operations and skips shutdown.
Preparing/draining work waits for a connected host daemon before claiming, avoiding
an uncertain stop merely because daemon enrollment has not completed at startup.
Live-worker claims cannot be stolen; exited claims can resume the saved operation.
Changed policy revisions still require explicit rebase, never an automatic change
to the captured authorization decision.

Builtin Workflows and Automations receive lifecycle-scoped, owner-filtered private
pause metadata. Queued workflows skip paused owners without starving other owners;
due automations retain their schedule cursor. Skipped startup automation recovery
is retried after release. Active background observation treats captured temporary
maintenance refusals as pending rather than permanent authorization failures.
Actual worker starts and resumed calls still enforce current saved authority.
Owned workflow notifications wait before beginning an attempt while paused. The
private job-authority and notification adapters preserve a temporary maintenance
fault rather than converting it into permanent denial; a captured fault which
races the pause snapshot remains retryable. After release, a committed native
notification receipt can be replayed without appending another turn request.
Revoked profiles still deny delivery.
Paused automation owners are excluded in SQL before due-page pagination, so a
large paused-owner backlog does not hide another owner's due work. This is not a
general grant to plugins or a guarantee that an interrupted workflow call
executes its external effects exactly once.

The deployment fixture seeds a private maintenance operation; no public role
mutation endpoint is enabled. Atomic administrative grant mutation/cohort
reservation, API/SDK/CLI/UI role controls and shared native project execution
remain separate acceptance work. Protocol 257, SDK 0.6.81 and builtin Workflows/
Automations 0.1.1 must be deployed together. The native timeline now labels the
maintenance interruption; a real-browser check of that specific label is not
claimed by this increment.


Deployment verification runs the new live native-drain scenario in its own fresh
Docker container with 150/180-second inner/outer deadlines. The complete existing
composite matrix still uses 540/570-second deadlines and retains the saved
maintenance intent before shutdown, notification receipt replay, native workflow/
automation recovery and crash checks. Both suites are required by the ordinary
`test:control-plane-deployment` task and execute sequentially. The focused suite
is additional acceptance, not a replacement for the composite deployment.
The final rebuilt image passes both suites: the focused suite in 98.811s and the
full matrix in 558.221s, with 63/63 Turbo tasks successful. The full matrix
confirms startup recovery of the saved UID operation, unchanged participant
generations, notification receipt replay, workflow crash recovery and native
script cleanup. See [the stage 72 record](control-plane-phase-72-verification.json).


## Atomic private role change (increment 73)

The private coordinator reads the current project policy and root ACL writers
before asking SQLite to change a single nonowner grant. The database transaction
checks the expected policy revision, confirms coverage of the owner, target and
all current grantees, changes the grant, and reserves every supplied UID against
the triggered new revision. The group worker claim is released inside the same
transaction, so a later process or the restart sweep can resume the operation.
If any UID is busy, the grant and all reservations roll back together.

After commit, normal reconciliation stops native threads and root jobs, applies
the exact ACL, acknowledges the revision and releases all participants. A failed
postcommit step leaves the saved operation and launch barriers in place. The
database function also refuses concurrent pending project maintenance and
owner-role changes. The service entry remains private while administrative
authorization, API/SDK/CLI/UI controls and shared native execution are built.
The stage 73 Docker matrix verifies the runner grant, generation advance,
completed saved operation, retained shared content and separate HOME isolation
after restart. Role removal has a migrated SQLite reservation test; the earlier
three-UID Docker ACL scenario continues to cover direct revocation and former
writers. See [the stage 73 record](control-plane-phase-73-verification.json).


## Administrator role API (increment 74)

`GET /control-plane/admin/projects/:projectId/access` reports the current
grant list, desired/applied revisions and any pending project operation.
`PUT /control-plane/admin/projects/:projectId/access/:userId` accepts a
runner/viewer/null role and the expected revision. It returns the saved operation
ID when a role changes; a postcommit reconciliation error returns the pending
operation with HTTP 202. `GET .../maintenance/:operationId` lets the
administrator inspect its phase and revision. The routes require the active
administrator request context from the central access gate, including for
reads. Personal tokens never authorize them.

These are limited control-plane methods rather than access to general BB
project APIs. The SDK, CLI and UI contracts and actual shared native agent
launch remain future stages.
The focused Docker suite authenticates as an administrator, rejects an
anonymous inspection, grants Alice runner access to Bob's project and waits for
the saved operation and applied revision to complete. The complete composite
matrix passes separately under the 660/690-second budget already used for
browser deployments. See [the stage 74 record](control-plane-phase-74-verification.json).


## Administrator role SDK and CLI (increment 75)

`createControlPlaneClient(...).admin.projectRoles` provides typed `list`, `set`
and `operation` methods for the three limited administrator role routes. A role
change requires the policy revision observed by the caller. A saved operation
may remain in progress after the role transaction, so callers can inspect its
phase and the project's applied revision before relying on filesystem access.

`bb server access projects roles <project-id>` lists the current policy and
grants. `set-role` takes a project ID, user ID, `--role runner|viewer` and
`--revision`; `remove-role` takes the IDs and `--revision`; `role-operation`
takes the project and operation IDs. Each command supports `--json` and uses
the existing administrator login session. Personal sessions cannot access the
underlying routes. The CLI outputs the saved operation ID from a changed role,
including the pending result of a postcommit reconciliation failure.

This stage adds no native role editor or shared-project native Qwen execution.
