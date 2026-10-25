# Shared-server machine and command boundaries

A machine credential identifies an enrolled host, not an end user. The daemon is
trusted to run the service's assigned runtimes for that host. Its credential is
not accepted as a full public BB user/admin API credential. This boundary does
not defend against a compromised daemon, operator plugin or root process stealing
or modifying the runtimes assigned to it. Tenant processes receive neither the
machine key nor the private service SDK transport.

## Incoming surfaces

| Surface                                  | Core boundary                                                                                                                                                                                                                                            | Relevant verification                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Internal HTTP routes                     | `server.ts` verifies a daemon host key before routing. Exact enrollment, daemon-WebSocket and pending server-move paths have their own authentication.                                                                                                   | Internal route tests and Docker machine-key/public-API denial.                                              |
| Enrollment and session open              | Enrollment tokens are host-bound; loopback key creation remains behind the shared-server administrative gate. Session open matches the authenticated host and protocol.                                                                                  | `internal-session-protocol-version`, machine enrollment and control-plane Docker checks.                    |
| Internal WebSocket                       | Host-key authentication plus an open session belonging to that host. Replies settle requests belonging to the live daemon connection.                                                                                                                    | `daemon-protocol`, host RPC and liveness tests.                                                             |
| Events and reconciliation                | Stored thread/environment assignment selects the host. Managed server-authored command/operation/provisioning events and interaction lifecycle events cannot be injected as provider events. Reconciliation is host-scoped.                              | Internal event ownership/envelope/tool/lifecycle and background reconciliation tests.                       |
| Tools and provider interactions          | Current saved owner/project/profile, current root turn, private-resolver-bound native session and provider identity. User fields inside tool arguments are not principals. Resolutions repeat these checks against the exact saved receipt and decision. | Stage 54 current-turn/session tests and native two-user Docker checks.                                      |
| Project attachment content               | Requested project must match the thread; environment must belong to the authenticated host. Managed execution authority is checked before reading bytes and again before responding.                                                                     | Real-SQLite route tests; two native users, profile revoke/regrant and independent owner download in Docker. |
| Environment and plugin-host signals      | Environment host/path and active plugin-host identity/generation select what can change.                                                                                                                                                                 | Internal environment-change and plugin-host-event tests.                                                    |
| Central plugin artifacts and skill trees | Validated content identifiers resolve only centrally registered operator artifacts. These are shared installed code, not personal result storage.                                                                                                        | Internal artifact and skill-tree tests.                                                                     |
| Server move                              | Pending bootstrap is loopback-only; downloads bind to the selected destination host and active move.                                                                                                                                                     | Existing server-move tests.                                                                                 |

The table is an inventory and evidence map, not a claim that all remaining
shared-server acceptance requirements are complete.

## Managed server-authored events

The managed event path omits server-authored `client/thread/start`,
`client/turn/start`, `client/turn/requested`, `client/turn/rejected`,
`system/manager/user_message`, `system/operation` and
`system/thread-provisioning` events from daemon batches. A machine cannot reuse a
real canonical request ID to replace its saved input or synthesize a server
operation. Ordinary provider output remains supported. This is managed policy;
unmanaged single-user behavior is unchanged.

The existing batch response shape is preserved: omitted events receive no
accepted-event index, as already happens for filtered interaction lifecycle
records. There is no new rejection reason or wire field. A real-SQLite route test
submits all seven types alongside an ordinary provider error, verifies only the
provider event is accepted, and verifies the original canonical request bytes
remain unchanged. Docker sends a forged canonical request through the actual
host-key-authenticated endpoint for each user's live native Qwen thread.

## Outgoing thread targets

`assertControlPlaneRpcTarget` is called by the common host-RPC admission path
before waiting/preparing a host and on every actual transport attempt. A managed
thread command must match the saved thread/environment/project/host relationship.
Provider, workspace cwd and nested resume context must agree with that same
registry record. A supplied native provider session must match the private saved
Qwen session. An unknown thread cannot borrow a managed environment to become an
unmanaged operator command. Ordinary unmanaged commands keep their existing
behavior.

Executing start/submit/goal/rewind/unarchive paths also require current managed
execution authority. Interaction resolution keeps its existing dedicated
receipt/current-turn/session guard, now at every admission checkpoint. Start and
submit additionally check the exact saved request's complete source graph before
transport. These checks are in core and do not depend on an optional policy
plugin being loaded.

Stop, storage deletion, plan cancellation, rewind discard and archive keep their
cleanup behavior after grant revocation. They remain bound to the saved owner,
project, host and environment. A destroyed environment may have a cleared path;
that does not turn an otherwise correctly bound stop/storage cleanup into a new
execution request. It cannot redirect cleanup to another owner's environment.

## Environment hooks and reuse

A managed Qwen thread cannot reuse an environment whose provider owns the path.
Its registered workspace is an unmanaged path. A centrally installed provider
record such as the normal `project-checkout` wrapper may still represent that
unmanaged directory; its ID alone is not ownership or authority. This is checked both
before creation and at dispatch. Managed environment attachment must match the
registry path/host, cannot request a service-account setup script and verifies a
supplied initiating thread. The generic hook command also refuses setup and
teardown paths inside any registered user's HOME, including normalized `..`
paths. Cleanup cancellation remains available.

This does not implement user-authored environment hooks. Tenant-authored scripts
must use an execution path with the registered Unix identity, not the common
service account. Normal non-managed operator environments retain their hooks.

## Remaining workspace execution audit

Qwen commands and managed workflow/automation scripts already use the registered
Unix identity. Daemon-side workspace inspection and Git are a different path:
`RuntimeManager.provisionHostWorkspace` calls `@bb/host-workspace`, whose buffered
and streaming Git runners use the daemon's process identity. Current managed
workspaces grant the service access through the provisioning helper's ACLs.
Those ACLs do not make Git execute under the project owner's UID/HOME.

The next workspace increment must address this path, including Git-configured
commands, status/diff/commit, restart and cleanup. It must preserve the native
workspace behavior under the registered identity rather than treating Git trust
configuration or successful Qwen isolation as proof. This source finding alone
does not establish that a particular repository has already executed a hostile
hook. Keep the overall machine/action and tenant workspace execution requirements
open until the actual path is implemented and tested.

Host daemon protocol 253 and Plugin SDK 0.6.80 are unchanged in this increment.
No new command fields or tenant-supplied identity parameters are introduced.
