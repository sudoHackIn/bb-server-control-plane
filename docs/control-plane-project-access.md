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
