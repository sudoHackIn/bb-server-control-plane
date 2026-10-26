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

## Remaining execution boundary

The helper lock serializes helper calls; it does not freeze agent filesystem
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
these POSIX ACLs. The container is read-only, has no network or namespace
capability, and is removed with its anonymous volumes. A 120-second outer deadline
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

### Next execution prerequisite

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
