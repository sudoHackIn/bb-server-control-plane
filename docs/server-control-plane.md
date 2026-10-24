# Shared-server control plane

This fork has two target experiences: an administrator signs in with a login and password and can use the full BB UI, including every project and conversation; a user signs in through our certificate flow and sees only authorized projects, conversations, agents and models. The central BB and its plugin administration are not an anonymous public API.

## Feature sequence

Complete each implementation stage with relevant tests, a deployment check against the real fork in Docker and a separate commit. Record the verified scope and leave later features unchecked; an access-module smoke test alone does not verify a deployment.

- [x] Administrative password login and 24-hour opaque sessions; password hashes on disk, session-token hashes in memory, logout and expiration.
- [x] Gate the full HTTP API, UI assets, plugin entry points and WebSocket upgrades. Cookies require matching Origin for writes and upgrades. Invalid Bearer credentials never fall back to cookies.
- [x] Revoke established administrative WebSockets on logout or expiration.
- [x] Preserve trusted server-plugin SDK calls through a private in-process transport, including inter-plugin RPC. No full-access network credential is supplied to agent processes.
- [x] Integrate certificate/PKCE user login, 24-hour user tokens and the environment registry into this repository's shared BB database. This allocates identities and paths; provisioning those paths and running processes are the next stage.
- [x] Provision registered HOME/project directories through a fixed privileged helper, with immutable UUID/UID bindings and Docker checks under actual numeric UIDs. Qwen/thread execution remains a later stage.
- [x] Create, list and read personal native BB projects with atomic ownership, source bindings and project grants; expose these operations through the limited API, SDK and CLI.
- [x] Port the server Qwen bridge and verify the stock CLI runtime under registered UIDs, including native history resume, descendant cleanup and cancellation before launch. The authoritative BB-thread resolver/admission is still pending.
- [x] Add atomic native-thread ownership, mandatory dispatch/start checks and a private SQLite-backed Qwen context resolver. Verify resolver → provider → stock CLI in Docker; real daemon dispatch and the user thread API remain pending.
- [x] Supervise one internal local daemon with private machine enrollment, no local HTTP API, and real native Qwen dispatch/timeline/resume checks across restart and parent crash in Docker.
- [x] Complete trusted in-process SDK realtime transport, reuse the native notification protocol and automatically release plugin SDK subscriptions on disposal.
- [x] Reclaim stale private context-socket directories after a server crash without disturbing active listeners, ordinary files or symlinks.
- [x] Protect launcher context and descendant command metadata across agent UIDs through separate job user/PID/mount namespaces; verify process visibility through the actual launcher with hostile-agent /proc probes. This is not a filesystem jail or a network boundary.
- [x] Persist approved agent profiles with immutable versions and user grants: prompt, provider/model/reasoning, tools, MCP and permissions. Expose administrative management and the user's permitted catalog through API/SDK/CLI; a catalog record alone does not enforce execution.
- [x] Bind native threads atomically to approved profile versions and recheck current profile grants and availability at create, dispatch, turn submission and resume. Legacy unbound rows remain historical and cannot execute; this admission check does not translate profile settings into the harness.
- [x] Enforce a native Qwen profile subset through protected per-job policy: exact native tool allowlist, appended instructions, fixed model, SDK reasoning acknowledgement, disabled hooks/extensions/unapproved MCP; reject unsupported modes before launch.
- [x] Connect approved `bb` MCP tools through the native Qwen SDK/BB tool channel, revalidate context on MCP requests and invoke the mandatory core guard; verify actual two-user model → plugin → model round trips in Docker. Other MCP transports and interactive approvals remain pending.
- [x] Route native Qwen approvals through BB with exact tool/turn identity, current-grant rechecks after approval, cancellation and timeout; verify accept-edits, full and native auto fallback in Docker. Personal approval endpoints and restricted native subagents remain pending.
- [ ] Apply the bound profile's prompt/provider/model/reasoning/permissions/tool/MCP settings through the actual provider and tool adapter, including configuration changes and resume. Reject unsupported settings rather than accepting ignored restrictions, then open the personal execution API.
- [ ] Add our limited public API for projects, thread start/send/stop/status/result/events and model/agent selection. A user token never grants access to the full BB API.
- [x] Bind thread ownership before provisioning; enforce project, source-thread, parent-thread and environment grants. Select UID/HOME/cwd from the registry for managed Qwen threads.
- [ ] Filter lists, search, bootstrap data and events at their data sources; verify subscription ownership and access revocation.
- [x] Gate managed daemon plugin-tool invocations by current project/profile permissions, filter their contributed tool catalog and propagate the persisted user principal; deny unscoped private user SDK calls. The Qwen MCP bridge and scoped SDK adapter remain pending.
- [ ] Carry verified user/run context through plugin calls and child creation. Plugin identity, parentThreadId and origin metadata are not authentication.
- [ ] Persist execution-context references for queues, retries, workflows and schedules; recheck permissions at actual execution and after restart. Do not persist browser access tokens for jobs.
- [ ] Make execution admission mandatory even when a policy plugin is absent. Audit internal daemon RPC so a machine credential cannot impersonate a user or gain global access.
- [ ] Clear account-scoped browser caches and drafts when switching identities or signing out.
- [ ] Use this fork's native UI for both roles. Keep projects/threads/composer/timeline/model controls for users; remove the right workspace panel and administrative controls in user mode.
- [ ] Complete the mandatory [per-user workflows, automations and schedules stage](#per-user-workflows-automations-and-schedules), including background execution and isolation tests.
- [ ] Install plugins centrally; grant users access to approved agent profiles, never arbitrary server-code installation.
- [ ] Package and verify this fork in the Docker lab, including direct API/CLI bypass attempts from a user's UID, certificate login and user-to-user denials.

## Per-user workflows, automations and schedules

This stage is required before shared multi-user deployment. Everything below is planned work, not a verified property of the current fork. First inspect the existing workflow, automation and scheduler storage and execution paths; reuse their persistence where possible and add ownership and enforcement at the actual boundaries.

### Implementation stages

- [ ] Inventory definitions, runs, schedules, triggers, queued/delayed messages, retries, workflow replay and their API/CLI/plugin entry points. Identify every background path that can create a thread or execute a tool.
- [ ] Persist authoritative `userId`, authorized project and execution-context references for personal definitions, runs and schedules. A plugin ID, project ID or parent thread ID does not establish the owner. Shared project access alone must not expose another user's personal automation.
- [ ] Execute tenant-authored workflow scripts and workspace commands under the registered Unix identity. A JavaScript VM or owner metadata alone does not authorize running tenant code as the shared BB service user. Keep trusted centrally installed plugin code separate from tenant-authored scripts.
- [ ] Scope list/search/get, create/edit/delete, enable/disable, manual run/cancel and resume/replay operations to the authenticated user. Apply the same rules to the UI, API, CLI and plugin RPC. Administrators retain full visibility and management.
- [ ] At each actual start, retry, resume and scheduled execution, resolve the saved owner and recheck current project/profile/provider/model/tools/MCP permissions. Select UID/GID, HOME and project cwd from the registry. Never inherit the scheduler's administrative privileges or persist a browser token as the job's authority. Missing or revoked authority must prevent execution with an explicit status.
- [ ] Propagate verified ownership and execution context to every child/worker thread and nested workflow. Scope history, results, artifacts, logs, event subscriptions and notifications. Cached/replayed results must remain subject to the same access checks.
- [ ] Persist timezone, next execution, enabled/status state and restart recovery with their owner. Define concurrency, duplicate-trigger and retry behavior per job; do not assume workflow replay provides exactly-once side effects. A valid saved job may outlive a browser token, but not revoked execution permissions.
- [ ] Migrate existing unowned objects explicitly: assign an owner through an administrative migration or disable execution until assigned. Never treat an absent owner as public access or administrative authority.

### Required acceptance checks

- [ ] Alice and Bob can independently create and manage their workflows, automations and schedules; each sees only authorized personal objects. An administrator can inspect and manage both.
- [ ] Foreign IDs, forged owner/parent IDs, shared project membership and direct API/CLI/plugin RPC calls cannot bypass ownership checks or subscribe to another user's events/results.
- [ ] Concurrent scheduled jobs for different users run with the correct actual UID/GID, HOME and project cwd; child threads and workflow workers preserve that context.
- [ ] A tenant-authored workflow script cannot read the service database, another user's HOME or bypass the limited API through direct SDK, CLI, filesystem or process calls.
- [ ] Revoking a user, project grant or execution profile prevents subsequent scheduled starts, retries and resumes. Browser-token expiration alone does not change the owner or elevate execution privileges.
- [ ] Restart restores ownership, schedule state and queued work correctly. Workflow resume/replay and cached results cannot cross user boundaries. Logout or switching identities clears personal UI state and event subscriptions.
- [ ] Verify the complete path in Docker with two users and an administrator, including denied operations and background execution after restart, before marking this stage complete.

## First increment: administrative boundary

This increment closes external entrances to a configured BB. It is **not yet a multi-user deployment**: the new user API, user UI and per-operation plugin authorization are pending. Trusted server plugins still have full service privileges. The existing Qwen/control-plane Docker lab remains on its previous version until the new fork is integrated.

The access module lives under `apps/server/src/control-plane`; core only mounts the module and binds its private SDK transport. User/role/environment policy belongs to the control plane. Core owns enforcement points. Keep one native UI, with an explicit server-role mode, rather than another copied app.

The configuration loader has a narrowly scoped filesystem lint exception because it reads server-owned credentials, not project workspaces. It does not grant filesystem operations on user projects.

### Configure

From the repository root, with a private password file containing at least 12 characters:

```sh
pnpm exec tsx scripts/configure-control-plane.ts \
  --data-dir /srv/bb \
  --origin https://agents.example.com \
  --login operator < /secure/admin-password
```

Run the server with that data directory and `BB_CONTROL_PLANE_REQUIRED=1`. This flag makes missing configuration fatal; invalid configuration is always fatal, even without the flag. The setup command refuses to overwrite existing configuration. `control-plane.json` must be a regular file owned by the server account with no group/other permissions. Keep the data directory private. Only HTTP loopback is accepted for development; production uses an HTTPS origin behind a trusted TLS endpoint.

The browser is redirected to `/control-plane/login`; `/control-plane/logout` offers browser sign-out. `BB_APP_URL`, if configured, must match the public origin. Administrative cookies are HttpOnly, SameSite=Strict and Secure on HTTPS. Sessions last one day and are revoked by logout and server restart. Existing sessions must sign in again after restart. Login attempts are throttled and password verification concurrency is bounded.

JSON clients can POST `{ "login": "operator", "password": "..." }` to `/control-plane/login` with `Content-Type: application/json`; the response contains an administrative Bearer token and expiration. Never put this token into a user's harness. `GET /control-plane/session` inspects the authenticated session; `POST /control-plane/logout` revokes it. With the SDK, supply an explicit custom fetch implementation that adds the Bearer header only for the configured BB origin. Browser mutations and WebSocket upgrades using cookies must carry the configured Origin.

`/health` returns only `{ "ok": true }` without authentication. Existing daemon endpoints retain their machine-credential checks; loopback `/internal/hosts/enroll-key` additionally requires administrative access. Automatic unauthenticated local enrollment is deliberately unavailable in this mode; managed machine bootstrap must use the administrative enrollment flow. Daemon credentials are not administrative credentials for the public API.

Without configuration and without `BB_CONTROL_PLANE_REQUIRED=1`, the upstream single-user behavior is preserved for desktop use. **Always set the required flag on the shared deployment.** Do not publish a separate upstream listener or expose a host-daemon management port. This increment has not yet audited or secured every host-daemon operation; that audit precedes multi-user deployment.

### Verification

CLI administrators use `bb server access login --login operator --password-stdin < /secure/admin-password`, `bb server access status` and `bb server access logout`. Saved administrative credentials are private files under `~/.bb/server-access`, scoped to the exact server origin. The CLI never prints the session token. Explicit Authorization headers take precedence over the saved session.

```sh
pnpm exec turbo run typecheck --filter=@bb/server
pnpm exec turbo run test --filter=@bb/server -- test/security plugin-sdk
pnpm exec turbo run test --filter=@bb/cli -- server-access-session command-groups
pnpm exec turbo run test:control-plane-docker --filter=@bb/server
pnpm exec turbo run test:control-plane-deployment --filter=@bb/server
```

Tests use the real migrated SQLite server harness, real HTTP/WebSocket upgrades, concurrent identities, logout, expiry, private configuration and forged-identity attempts.

### Verified first increment

- 40 selected server security/plugin-SDK tests and 5 selected CLI tests passed. This is focused verification, not the entire repository suite.
- Server and CLI strict typechecks and builds passed; focused lint and formatting passed.
- The real CLI signed in, inspected its session, listed projects, signed out and was denied the next request against a real HTTP server with migrated SQLite.
- A real server plugin used the private SDK and inter-plugin RPC; the same external unauthenticated RPC was denied.
- The setup script produced a 0600 configuration containing only the password hash and refused to overwrite it.
- `test:control-plane-docker` bundled the new access module into a disposable, network-isolated `node:22-bookworm-slim` container (Node v22.23.4). A child process running as numeric UID/GID 200001 received HTTP 401. Login, forged-identity rejection, private SDK access, logout and WebSocket expiration checks passed. The container uses root only to switch that test child to the numeric UID; no host ports or credentials are supplied. This verifies the access module on Linux, not a deployment of the entire fork.
- `test:control-plane-deployment` built `bb-control-plane:local` and started the real fork with its native UI, bundled plugins and migrated SQLite under the image's `node` user. Anonymous API and asset access and forged identity headers were denied. Administrative login, native UI/assets, real CLI login/project listing/logout, WebSocket revocation and restart/session invalidation passed. The check uses disposable tmpfs data, a read-only container and no network or published ports. No existing deployment was replaced.

### Deploy the administrative increment

`pnpm exec turbo run build:control-plane-image --filter=@bb/server` builds server, CLI, native UI and bundled plugin artifacts before creating the image. The Docker build context contains only staged artifacts and the runtime dependency lockfile, never repository credentials or local data. Runtime native dependencies are installed for Linux inside the image.

Initialize a dedicated volume with a private password file, then start the image behind an HTTPS endpoint at the configured origin:

```sh
docker volume create bb-control-plane-data
docker volume create bb-control-plane-users
docker volume create bb-control-plane-launcher
node scripts/control-plane-seccomp.mjs /secure/bb-seccomp.json
docker run --rm -i \
  --mount type=volume,src=bb-control-plane-data,dst=/srv/bb \
  --entrypoint node bb-control-plane:local configure.mjs \
  --data-dir /srv/bb --origin https://agents.example.com --login operator \
  < /secure/admin-password
docker run --detach --name bb-control-plane \
  --security-opt seccomp=/secure/bb-seccomp.json \
  --security-opt systempaths=unconfined \
  --mount type=volume,src=bb-control-plane-data,dst=/srv/bb \
  --mount type=volume,src=bb-control-plane-users,dst=/srv/agent-users \
  --mount type=volume,src=bb-control-plane-launcher,dst=/var/lib/bb-agent-launcher \
  --publish 127.0.0.1:8080:8080 bb-control-plane:local
```

The image always requires control-plane configuration and runs as a non-root service account. It currently packages the BB server, UI and CLI; host-daemon enrollment, Qwen execution and user environment provisioning belong to later stages. Administrative access is the only supported mode at this stage.

The existing BB 0.46.1/Qwen Docker lab was not replaced. The fork's user project/thread API/UI, delegated plugin permissions and host-daemon audit remain required before shared multi-user deployment.

## Second increment: certificate users and environment registry

The optional `users` configuration enables an HTTPS listener with client-certificate requests. Certificate approval checks the actual TLS socket against the configured client CA; headers cannot supply a login. Clients without a certificate may start and poll a PKCE flow or use an issued token. Only the browser approval step requires a trusted certificate, a valid lowercase CN, a matching Origin and a form proof bound to that CN. This is our platform login, separate from corporate Qwen authorization.

The real Drizzle migration adds users, a durable atomic UID counter, authorization flows and hashed user sessions to BB's database. A user receives a permanent UUID, an incrementing UID/GID and recorded `usersRoot/<uuid>/home` and `usersRoot/<uuid>/projects` paths. Repeated login preserves that identity. New environments have `allocated` status: this increment does not create directories or start a harness. Disabled identities are retained; their UIDs are not recycled.

User tokens last one day, have no refresh token and survive process restarts. Every personal-session request looks up the token hash and current user state in the database. Administrative sessions retain their separate password-based lifecycle. Users still cannot use the raw BB API, native UI or global WebSocket. All remaining project/thread authorization stages are mandatory before making those surfaces available.

Configure a new instance with the private admin password on stdin and these additional setup options:

```sh
pnpm exec tsx scripts/configure-control-plane.ts \
  --data-dir /srv/bb --origin https://agents.example.com --login operator \
  --users-root /srv/agent-users --first-uid 200000 --last-uid 299999 \
  --tls-key /secure/server.key --tls-cert /secure/server.crt \
  --client-ca /secure/client-ca.crt < /secure/admin-password
```

The service account must own the regular TLS files; the key must be private. Mount them at the configured paths in Docker and use HTTPS or TLS passthrough to the listener. A terminating proxy's certificate headers are not accepted. Select a dedicated numeric UID range reserved for these environments.

CLI users run `bb server access authorize --client-name 'My BB CLI'`, approve the displayed URL in their browser, then use `status` or `logout`. SDK clients import `createControlPlaneClient` from `@bb/sdk/node` or `@bb/sdk/browser`; `start(clientName, sha256Base64UrlVerifier)` returns the approval URL, `exchange(flowId, verifier)` polls and exchanges once. Keep the verifier private. Supply a `token` callback or authenticated fetch for `session()` and `logout()`. No token is returned to the browser approval page.

The Docker deployment check now also generates a disposable test CA and separate server/Alice/Bob certificates inside its temporary filesystem. It uses the actual CLI authorization flow, verifies distinct registry UID/HOME records, denies header impersonation and cross-certificate approval, checks single-use PKCE and denies user access to the full BB API. Restart retains user identities and their tokens; disabling Bob and signing Alice out deny subsequent requests. This verifies registry records, not filesystem/process isolation, which remains pending.

## Third increment: provision personal directories

Authenticated users inspect their registry entry with `GET /control-plane/user/environment` and request creation/verification with `POST` to that same endpoint. The request accepts only an empty body or `{}`: the caller cannot choose a UUID, UID/GID or filesystem path. CLI: `bb server access environment [--provision]`. SDK: `createControlPlaneClient(...).environment()` and `.provisionEnvironment()`. This creates directories, not BB project objects or agent sessions.

The service invokes one fixed root-owned helper through a service-account-only sudo rule. Agent UIDs do not receive sudo rules or Unix account entries. The helper supports provisioning/project directories only; harness execution is explicitly rejected at this stage. A root-owned manifest and lock preserve immutable UUID/UID bindings independently of the BB database, including rejection of a reused UID after a database rollback. Requests for the same user coalesce, and failed provisioning can retry without changing identity.

The root-owned parent uses 0711, HOME uses 0700 and project ACLs grant the trusted BB service access. Other user UIDs cannot list the parent, enter another HOME/project or read service data. Directory operations reject symlinks and unexpected ownership/modes instead of recursively fixing user-controlled paths. Unix permissions do not confine an agent to HOME: readable system files remain available. Qwen launch, lifecycle and per-thread execution admission are still pending.

The Docker image installs the helper and its fixed policy for service user `node`, UID range 200000–299999 and `/srv/agent-users`. Persist **all three** data, users and launcher-manifest volumes when replacing a container; restore them consistently. The users filesystem must support POSIX ACLs. The deployment check uses disposable Docker volumes because this Docker environment's tmpfs rejects `setfacl`; there is no fallback that makes private data more readable.

For installation without Docker, copy the launcher directory from this repository, install Python 3, sudo, util-linux and POSIX ACL utilities, then run the installer as an administrator:

```sh
python3 -I deploy/control-plane/launcher/install.py \
  --service-user bb-service --users-root /srv/agent-users
```

The service account must already exist and the configured `usersRoot` must match the helper policy. The installer writes only fixed launcher/policy/state/sudo-rule locations; it creates no agent accounts. Keep these artifacts root-owned. Install on a Linux filesystem with ACL support.

Verification covers real migrated SQLite provisioning state, concurrent-request coalescing, mismatched helper identities, retry and revocation during provisioning. The real Docker server and CLI provision Alice/Bob directories, then numeric UID/GID processes with cleared groups write their own HOME/project and are denied the other user's paths and service database. Helper UID reassignment, non-service invocation and a symlink replacement are rejected; recovery preserves the same identity. The test controller uses root only to start processes under their actual service/user UIDs; BB itself runs as UID 1000.

## Fourth increment: personal native BB projects

The limited user API now supports `GET/POST /control-plane/user/projects` and `GET /control-plane/user/projects/:projectId`. Creation accepts only `{ name, slug }`; a slug is a lowercase letter followed by up to 47 lowercase letters, digits or hyphens. The server derives the workspace below the authenticated user's `projectsRoot` and selects the local BB primary host from the private server data directory. The host must already be registered. Environment provisioning must have completed first. Clients cannot select another user, host, UID, HOME or arbitrary path.

The helper creates/verifies the project directory and its ACLs. Core's existing project insertion primitive then creates the native BB project/source and its control-plane ownership/grant rows in one immediate transaction. Permissions are checked again after the asynchronous helper call. Existing unowned native project sources are not silently adopted. Repeating the same slug/name returns the existing project; a different name for an occupied slug returns a conflict.

Project lists use SQL joins constrained to the authenticated user's current grant, enabled account and matching native project/source/host bindings. Foreign and revoked IDs return 404. Unowned/legacy objects remain administrative-only until explicitly migrated. The list is paginated by project ID: optional `limit` is 1–100 (default 50), and `cursor` is the previous response's `nextCursor`. A response contains `projects` and nullable `nextCursor`.

Grant rows distinguish owner, runner and viewer, with the owner assigned atomically on creation. This increment implements shared read access; a grant to another user's project does not permit impersonating its Unix identity. The response's `canRun` requires the caller's own execution identity as well as its role. Administrative grant-management APIs and per-thread execution checks are subsequent work; no tenant can edit grants through these endpoints.

CLI:

```sh
bb server access projects create app --name 'My app'
bb server access projects list --limit 50
bb server access projects get <project-id>
```

SDK: `createControlPlaneClient(...).projects.create({ name, slug })`, `.projects.list({ cursor, limit })` and `.projects.get(projectId)`. These methods use the private per-origin user token; the full BB API stays closed to it. The native administrative UI/API sees the same project objects, not a copied project catalog.

Docker verification creates projects through the actual user CLI/API, checks separate same-slug directories, repeat creation, per-user listing, foreign-ID denial, forbidden path/identity fields, administrative visibility and shared-read grant revocation. It uses a registered **offline host fixture** for metadata registration and verifies project access after a server restart. This does not prove host-daemon or Qwen thread execution. Focused tests additionally cover pagination, source rebinding, unowned-project conflicts and revocation during helper preparation.

## Fifth increment: isolated Qwen process runtime

`plugins/provider-qwen-server` ports the existing server bridge to this fork's SDK, pnpm/Turbo and strict TypeScript tests without `any`. Its production host entry always uses the isolated transport; there is no default service-user Qwen launch. The private context contract now includes BB thread ID and native Qwen session ID as well as the registered UID/GID, HOME and cwd. A response that changes any requested binding is rejected.

The launcher installer accepts an optional `--qwen-cli <absolute-path>` and `--node <absolute-path>` (default `/usr/local/bin/node`). Both resolve to root-owned files under paths that other users cannot modify. Without a configured CLI, execution is unavailable. The image installs the pinned stock `@qwen-code/sdk` CLI and builds/packages the fork's host-daemon artifacts. It still starts the BB server only; managed host-daemon bootstrap and user thread admission are the next integration step.

Every process launch uses a fresh job UUID, separate from the persistent Qwen session ID. A root-owned job lease records its supervisor PID/start time and user identity. The supervisor is a Linux child subreaper; it drops Qwen to the registered numeric UID/GID with cleared supplementary groups and `--no-new-privs`. On close, a separate fixed helper operation stops that job's descendants, including detached commands reparented to the supervisor. It does not kill every process belonging to the user. A cancellation tombstone prevents a late launch from starting after an earlier cancellation. Stop and launch verify the immutable user binding; job state is private to root.

The transport waits for root-supervised cleanup, and the bridge reports interruption only after cleanup resolves. SDK stream-close grace defaults to one second so an aborted streaming input does not leave the SDK's normal one-minute timer alive. Bridge disposal waits for session cleanup. Sessionless model discovery cannot launch the isolated transport without a server-owned thread; user model/profile selection remains part of the pending API stage. Dynamic BB MCP tools remain disabled until delegated access is enforced.

The Docker deployment test uses the real stock CLI, real SDK transport and real native shell tool. A local deterministic OpenAI-compatible HTTP fixture supplies model responses without external credentials or quota. Native commands prove UID/GID/groups, HOME/cwd, no-new-privileges and denial of other HOME/service-data reads. A fresh process resumes the same native session, and its backend request must contain the earlier conversation. Two concurrent sessions share one user's HOME; stopping one kills its detached descendants while the other job survives. The test also checks cancellation before a late launch.

**Verification boundary:** runtime tests use a controlled private context-resolver fixture. They do not prove persistent BB-thread ownership/admission, real host-daemon dispatch, a live model backend or the corporate fork's certificate login. The provider is not automatically enabled as a bundled server provider yet. The full thread API remains closed until those ownership checks are wired in.

The next integration must bind ownership before `createThreadRecord` can emit creation events or `attemptDispatch` can start provisioning, recheck saved ownership/profile grants on queued/retried dispatch, and serve the private resolver from those authoritative records. Local daemon enrollment must use private machine credentials without exposing a full BB API credential. After that, test the complete user API → native thread → daemon → provider → Qwen path in Docker, with foreign IDs and revoked grants denied.

## Sixth increment: authoritative thread execution context

Migration 0149 adds native thread ownership and a unique, persistent Qwen session binding. Managed projects accept only `qwen-server` execution with an enabled, provisioned owner and a current execution grant. Thread creation validates parent/source/lifecycle-owner identities and inserts ownership in the native thread transaction before notifications or plugin events. Missing authority does not fall back to the BB service identity. An administrator may explicitly create a managed thread for its project's owner; an ordinary service call cannot infer that authority from a supplied project or parent ID.

The server validates a managed thread request before plugin mention expansion, then checks again when inserting the row. Managed workspaces are currently restricted to the registered project's exact source path and host, or reuse of that same native environment. Arbitrary paths, provider-created environments, provisioning-time branch changes and worktree creation are denied until their own scoped execution policies exist. Low-level native thread creation also enforces ownership and environment bindings; directly invoking it cannot publish an ownerless managed thread.

Mandatory checks run before dispatch hooks, on initial and queued dispatch, before provisioning, before native thread-start preparation and immediately before start/turn submission after host readiness. They use persisted ownership and current grants rather than a browser token or an optional policy plugin. User disablement, a viewer-only grant, missing source binding, a foreign workspace or deleted/archived thread prevents subsequent execution. This does not yet implement all background entry points, approved profile versions, workflow ownership or automatic cancellation of already-running jobs on revocation.

`startControlPlaneQwenContextService` exposes only a private Unix socket under a service-owned 0700 directory; the socket is 0600. Its strict request contains `threadId`, Qwen `sessionId` and `cwd`. It derives UID/GID/HOME from SQLite, requires a ready native environment and an execution-started thread, and binds the session atomically. A Qwen session cannot be rebound to another thread, nor can another session replace an existing binding. The service has bounded requests and an explicit cleanup lifecycle. This listener is not mounted on the public HTTP API. Startup integration with the managed local daemon is the next increment.

Private SDK dispatch preserves an existing verified in-process principal. An unrelated private service request keeps its own service identity; a network request cannot supply either principal. This is propagation plumbing, not a completed authorization layer for arbitrary plugin SDK operations. Delegated plugin permissions and background execution context remain required before exposing those capabilities to users.

Verification: all 636 database tests pass, including real migration/replay tests; 128 targeted server security, creation, dispatch-hook and live-start tests pass; database/server strict typechecks and formatting/lint checks on changed TypeScript files pass. Legacy comments in edited core files were removed to satisfy this repository's no-comments lint rule. Migration rewind fixtures now also remove the later control-plane schema before replaying its journal entries.

The Docker check now creates owned native thread/environment rows through the actual database primitives and runs the production Unix resolver, production provider transport and stock Qwen CLI together. Resume preserves the same native thread/session binding. Actual UID/HOME/cwd, native shell-tool execution, same-HOME concurrent jobs, detached-descendant cleanup and cancellation fencing still pass. The deterministic model backend and test-only fixture setup remain explicit: the user API → real daemon → provider dispatch path is **not verified yet**, and the provider is not automatically enabled for user threads. Do not mark the full thread API or multi-user deployment stages complete from this increment.

## Seventh increment: managed local daemon and native Qwen dispatch

The optional private `runtime` configuration points to the built host-daemon `control-plane.js` and CLI directory. The normal BB server starts one supervised daemon, preserving its private `host-id` and native machine-auth state. An enrollment key is issued for that host through the existing machine-auth service and delivered over stdin. It is not an administrator session or an agent environment variable. The child validates the bootstrap parent PID before starting; Linux `setpriv --pdeathsig KILL` prevents the daemon from surviving a dead server. Startup errors do not fall back to unscoped execution. The runtime restarts an unexpectedly exited daemon and stops its private context listener during normal shutdown.

The managed daemon disables the local HTTP API and automatic daemon updates. Its existing authenticated machine protocol and nullable local-API contract are preserved; no wire fields changed. Other daemon entry points keep their existing defaults. The server-owned configuration, artifact discovery and runtime-state modules have narrow filesystem lint exceptions; this does not expose workspace filesystem access to the server API.

The Qwen Server plugin is now bundled, remains disabled by default and is enabled by an administrator through ordinary plugin management. Its provider process uses the private SQLite-backed resolver. Both low-level insertion and early core creation require current grants on related parent/source projects, not merely matching owner IDs. Permission-profile versions and tenant model/tool/MCP selections remain pending.

The fixed root launcher now records the original service-process ancestry in memory with `/proc` start times. Loss or PID replacement of a service ancestor terminates only that job's supervised subtree, including detached descendants. This cleanup does not depend on JavaScript, a surviving socket, a browser token or successful event delivery. Existing stop fencing and same-user sibling-job isolation remain verified.

Docker now exercises the actual fork's administrator API → native thread → real enrolled host daemon → bundled provider → stock Qwen CLI path for Alice and Bob. A native shell tool records the actual UID/GID/groups/HOME/cwd; the standard BB timeline includes the answer. A normal server restart resumes the same native Qwen session and the model request contains earlier conversation history. Killing the server with SIGKILL ends the daemon, its captured descendants, actual Qwen children and root job supervisors. A subsequent server start reconnects a new daemon instance under the same host ID and can retrieve the persisted thread. The daemon's local API port refuses connections.

The backend is still a deterministic local OpenAI-compatible fixture and thread starts use the administrator API. The limited user thread API, user UI, approved profiles, delegated plugins/MCP, workflows and schedules are not complete. Corporate Qwen authorization and a live model endpoint are not tested. Native provider model discovery currently falls back to the configured default because an unowned harness probe is denied; approved profile model catalogs remain part of the next integration.

Verification: 636 database tests, 19 targeted server control-plane tests and 36 daemon lifecycle/auth/connection tests pass, with strict database/server/daemon typechecks. Changed TypeScript files pass lint and formatting; the complete Docker deployment check passes. See `control-plane-phase-7-verification.json` for the tested boundary.

Two follow-ups surfaced during the real integration and stay unchecked in the feature list. Trusted plugin HTTP SDK requests work, but their default realtime socket still targets the public socket without private authorization; provide a scoped private realtime transport rather than handing plugins an administrator token. A hard server crash also leaves an inert private context-socket directory; reclaim stale listeners safely before final deployment acceptance. These do not grant users raw BB API access, and neither is considered complete here.

## Eighth increment: private SDK realtime and stale-context recovery

Trusted server-plugin SDK subscriptions now use an in-process socket factory bound to the owning BB notification hub. It invokes the same open/message/close handlers used by the public BB WebSocket route; the SDK still uses its normal subscribe, unsubscribe, ping and notification protocol. No network socket is opened for this channel, its URL cannot select another application, and it carries no administrative network credential. Public HTTP and WebSocket authentication remain unchanged. Legacy deployments without control-plane configuration retain their existing network transport.

Plugin SDK subscriptions are automatically disposed with the plugin, including callers retaining an earlier SDK reference. Explicit unsubscribe remains idempotent and releases the lifecycle hook. New subscriptions through a disposed plugin are rejected. The private transport closes invalid messages, suppresses queued delivery after closure and cancels pending opens on shutdown. A user principal cannot create or send through this service-global channel or register a plugin SDK subscription against an already-shared target. User-scoped plugin operations and event policies remain a separate incomplete stage; this is not authorization for delegating the global SDK to tenants.

Context-service startup now checks only service-owned private `qwen-execution-*` directories containing a single private Unix socket. It removes that socket and directory only after connection refusal and an unchanged inode check. Active listeners, non-socket files, symlinks, unexpected contents and in-progress empty directories are preserved. Cleanup does not recurse into arbitrary server or workspace data.

The same SDK project-update notification contract runs against an authenticated public WebSocket and the private transport. Tests also cover plugin disablement, saved SDK references, unsupported user-global subscriptions, malformed frames and shutdown during connection. A real crashed child leaves a Unix socket for the cleanup test, while a second live listener and protected files remain usable. Targeted server control-plane and plugin SDK/compatibility tests pass (45 tests), with server and Plugin Guide strict typechecks and changed-file lint/format checks. Existing edited plugin-loader/storage and static-asset modules have narrowly scoped filesystem lint exceptions for their server-owned artifacts.

The Docker deployment check observes the bundled concurrency-limit plugin receiving native host changes through its private SDK subscription and publishing its normal configuration-change signal. It also restarts the managed daemon, crashes the parent server, recovers the same native thread/host identity and verifies that context directories are gone after recovery and normal shutdown. Earlier native Qwen UID/HOME/tool/timeline/resume and cancellation checks remain passing. The limited user thread API, profile grants, user UI, delegated MCP and personal workflows/schedules remain unfinished.

A separate hostile-UID Docker probe confirmed that ordinary Linux UID separation still permits reading another process's initial command line. This finding led to the namespace boundary in the ninth increment below; filesystem access denials alone did not prove process-metadata confidentiality.

## Ninth increment: isolate agent process metadata

The root-owned launcher now drops to the registered UID/GID with cleared supplementary groups and no-new-privileges, then runs the fixed Node/Qwen executable inside separate user, PID and mount namespaces. The same numeric UID/GID is mapped inside; Node runs with no effective capabilities. Each job mounts its own nosuid/nodev/noexec proc, so the CLI and its native tools cannot enumerate BB, root supervisors, other users or sibling jobs. Same-user jobs retain their shared HOME and native Qwen history. Namespace setup failure prevents execution, with no UID-only fallback. Filesystem permissions still govern readable paths outside HOME; networking remains shared.

Docker deployment uses a derived profile preserving the pinned Moby default deny rules, adding only the required unshare flag combinations and mount flags. `systempaths=unconfined` permits the new proc mount; seccomp remains enforced, and neither `CAP_SYS_ADMIN` nor a privileged container is used. The base profile, license, generator and installation requirements are committed under [deployment security](../deploy/control-plane/security/README.md). Non-Docker installations require Linux unprivileged user namespaces allowed by their kernel/LSM policy. Untrusted code must enter through this launcher, not an outer-namespace shell.

The deployment check first proves that the actual launcher fails closed under Docker's default seccomp policy and leaves no job lease or CLI output. Under the derived policy, three actual Qwen jobs run simultaneously for two users, including two jobs sharing one HOME. Native shell tools refresh their own proc snapshots after all three jobs are ready. Their views contain only their own UID and instruction/command markers; the root observer verifies the corresponding real CLI and tool processes in its outer proc view. Cancellation checks resolve namespace-local PIDs through the root job lease and outer process ancestry before verifying complete cleanup and sibling survival. Managed BB dispatch, timeline, history resume, daemon restart, parent SIGKILL cleanup and recovery remain passing with these namespaces.

The repeated deployment test also exposed a managed-daemon shutdown race: a session could be committed before its WebSocket opened, leaving an active database row with no close event. Managed shutdown now explicitly passes its remaining session through the native disconnect handler after the child stops. A real SQLite test covers the pre-WebSocket session and preserves an unrelated host's active session. Six targeted runtime/session-status tests, strict server typechecks, changed-file lint/format and the complete Docker deployment pass. See `control-plane-phase-9-verification.json`. User thread APIs, approved profile versions, user UI, delegated tools/MCP and personal workflows/automations/schedules remain pending.

## Tenth increment: approved profile catalog

Migration 0150 adds centrally managed profiles, immutable numbered definition versions and per-user profile grants to the shared BB database. Creation commits the profile and version 1 together. Publication allocates the next version in an immediate SQLite transaction without changing an earlier definition. Availability is mutable separately for the whole profile and each version; no delete or in-place definition replacement is exposed. A grant covers that profile's enabled versions, including later administrative publications. Profile names/slugs are stable at this stage.

Definitions contain a prompt, the `qwen-server` provider, model/reasoning, permission mode and unique tool/MCP identifier arrays. They are policy records; arbitrary environment variables, executable MCP configuration and secret fields are rejected. The schema is shared by persistence boundaries, HTTP input validation and SDK response validation. Referenced providers, models, tools and MCP servers must still be validated against their actual installed capabilities at execution time. Creating a catalog record does not start or authorize a harness.

Administrative routes under `/control-plane/admin/profiles` create/list/get profiles, publish versions, list version metadata and grants, change availability and grant/revoke registered users. They require the administrative boundary, including cookie Origin checks; user credentials cannot reach these routes. Users only get `/control-plane/user/profiles`, `/:id`, `/:id/versions` and `/:id/versions/:versionId` with a valid personal token. Lists are scoped in SQL; ungranted, disabled, foreign-profile version IDs and disabled-user records are unavailable. The default version is the latest enabled one; retiring it allows an older enabled version to remain selectable. No enabled version means the profile disappears from the personal catalog. Known IDs do not bypass the checks.

`createControlPlaneClient(...).profiles` exposes personal reads; `.admin.profiles` exposes the management operations using an administrator's authenticated transport. CLI commands live under `bb server access profiles`; `bb guide machines` documents JSON stdin, administrative read switches, grants, availability and both cursor forms. Profile and grant lists paginate by UUID; version metadata lists newest first with a version-number cursor. The trusted plugin SDK transport still accepts only native `/api/v1/` requests, and was not widened to these management routes.

Verification uses real migrated SQLite: 638 database tests pass, including schema rewind/replay, grant and user revocation, immutable history, transactional rollback and foreign-version mutation denial. The 25 selected control-plane server tests pass; the additional profile contract checks use the real HTTP middleware and the actual Node SDK against that application, including private-transport denial and retirement of every version. Database/server/SDK/CLI strict typechecks and changed-file lint/format pass. The Docker deployment uses actual administrator and certificate-user CLI sessions to create/publish/grant/retire/restore/revoke profiles, denies Bob's known-ID reads and a user's administrative writes, and verifies definitions/grants after server restart. Previous native Qwen process isolation, history, daemon and crash-recovery scenarios remain passing. See `control-plane-phase-10-verification.json`.

The next increment must bind a chosen version to native threads before creation events or dispatch, recheck current grants on actual execution/resume and translate all allowed settings into the Qwen/provider/tool/MCP paths. Unsupported settings must fail explicitly. That enforcement, the limited user thread API, user UI, delegated plugin operations and personal workflows/automations/schedules are still incomplete.

## Eleventh increment: pin execution admission to a profile version

Migration 0151 adds a nullable profile-version reference to native thread ownership records. Existing null values retain historical rows but cannot execute. New managed threads require an explicit `controlPlaneProfileVersionId` in the native HTTP/SDK create request; the CLI passes it with `bb thread spawn --profile-version <id>`. Unmanaged projects reject that field. No host-daemon wire field changed: this is server-owned policy and persistence.

Both early core creation and the database insertion transaction require the owner's current grant, an enabled profile/version and the matching managed provider. Ownership and the exact version ID commit together before creation notifications. The shared execution guard resolves that saved version again for dispatch, provisioning, native turn submission and the private Qwen context service. Later publications never replace it; revocation or retirement denies execution even if another version remains available. Historical reads are preserved. Native HTTP execution-policy failures return `403 execution_not_authorized`; missing/foreign create authority is denied before inserting a thread.

This increments the **admission boundary**, not the completeness of harness settings. The selected definition's prompt/model/reasoning/permissions/tool/MCP controls are not yet all translated into Qwen execution. That remains mandatory before enabling the personal thread API. Existing managed forks/children without an explicit authorized binding are also denied; automatic inheritance through verified plugin/workflow context is still pending. No fallback profile or implicit administrative grant is introduced.

The Docker scenario creates execution profiles and grants through the actual administrative API, verifies the binding in the native thread row, rejects missing and foreign versions without inserting threads, revokes Alice's grant and proves an attempted continuation returns the policy error without appending conversation events. Restoring the grant permits the existing native session to resume after restart. Earlier numeric UID/HOME, process namespace, tool execution, timeline and crash-recovery checks remain passing.

The CLI contract checks also exposed missing `--json` support in the previously added `server access` commands. All their leaf commands now accept it. Existing catalog/project/environment output remains JSON; login/status/logout provide structured responses, while `authorize --json` emits pending and authorized JSON lines. Neither tokens nor PKCE verifiers are printed. Docker uses those real authorization/login/status/logout paths and checks their output. CLI command-output tests require process inspection for their own temporary service fixture; macOS sandbox denies `ps`, so those checks ran with that host restriction lifted, preserving the product's process-identity verification.

Verification: 639 database tests, 26 selected server control-plane tests and 577 CLI contract tests pass (one existing CLI test skipped), with database/server/SDK/CLI strict typechecks and changed-file lint/format. Tests prove pre-notification binding, grant/profile/version revocation, old-version pinning, legacy null denial, initial/queued dispatch refusal and resolver refusal. The complete fork Docker deployment passes. See `control-plane-phase-11-verification.json`. Native profile-setting enforcement, personal thread API/UI, delegated MCP/plugin operations and personal workflows/automations/schedules remain unfinished.

## Twelfth increment: protected native Qwen execution policy

The private context resolver now returns the persisted approved version and its
definition after the existing grant checks. The provider resolves and validates
that context before constructing an SDK Query. In particular, an SDK MCP
instance cannot connect in the shared service process before authorization.
Caller model overrides, safe mode, non-Full permissions, nonempty MCP profiles,
unrecognized native tools and unsupported reasoning values are rejected. This
is an enforced native subset, not completion of the delegated MCP/approval layer.

The root supervisor receives a bounded framed policy over stdin, creates
root-owned policy/settings files outside writable HOME, grants the registered
UID read-only access, and removes them after descendant cleanup. A Node preload
injects appended instructions and launch options in JavaScript memory instead
of kernel argv. Internal Qwen relaunch is disabled so it cannot copy those
arguments into a new OS command. The existing numeric UID, no-new-privileges,
namespace and parent-death boundaries remain in force. Concurrent jobs share
HOME but have separate policy files and proc views.

The profile controls the model and reasoning settings. SDK initialization must
acknowledge the requested effort without an overriding sampling configuration;
for `none`, a diagnostic effort request must report disabled thinking before
conversation input is sent. Protected settings clear model-provider/fallback
and generation overrides, disable hook execution and extension loading, and
exclude all unapproved MCP. Empty MCP allowlists alone are insufficient in
this pinned CLI because user configuration can merge into them: the launch also
supplies an explicit empty CLI allowlist and a wildcard exclusion. Native tools
are disabled by exact registry name, avoiding the broader alias-family effects
of permission deny rules. Caller exclusions can only reduce capabilities.

The installer verifies immutable root ownership and a SHA-256 pin of the
reviewed stock CLI JavaScript modules (SDK 0.1.22, CLI 0.26.0). A changed artifact
fails installation until its policy behavior is reviewed and tested. This does
not verify the corporate fork or its browser authorization mechanism. The
unused `QWEN_SERVER_MODEL` override has been removed; execution models come
from the bound approved profile.

Docker exercises a model-forged `write_file` call against a read-only native-tool
profile, hostile HOME settings that attempt to enable hooks, extensions, MCP,
command discovery and another model, read-only policy files, instructions larger
than the Linux per-argument limit, native resume, concurrent jobs and cleanup.
The deterministic model backend checks the actual offered tool names, selected
model and appended instructions. Full approval modes, approved delegated MCP,
personal execution API/UI and user workflows/automations/schedules remain open.

Verification: 639 database tests, 26 selected server control-plane tests and 21
provider tests pass, with strict database/server/provider typechecks and
changed-file lint/format checks. The complete Docker deployment passes,
including native daemon dispatch and prior crash recovery checks. See
`control-plane-phase-12-verification.json`. The full feature list remains open.

## Thirteenth increment: mandatory delegated tool admission

Managed `/internal/session/tool-call` requests now pass an unconditional core
authorization check after machine-session/host ownership checks and before
built-in or plugin invocation. Each call re-resolves the persisted thread owner,
current project access, profile grant and enabled version. Only starting/active
threads can invoke tools. Profile `mcpServers: ["bb"]` and an exact
`tools: ["bb:<registered-tool-name>"]` entry are both required for a delegated
BB tool. Native Qwen tool identifiers keep their existing meaning. The
contributed tool catalog and tool-associated instructions are filtered through
the same allow predicate before dispatch. A caller-provided user/project/thread
inside tool arguments does not select execution authority.

The plugin invocation runs inside the persisted owner's asynchronous principal
context, including across awaited work. Unmanaged desktop threads retain their
existing behavior. `update_environment_directory` remains denied for managed
threads even if listed: its general workspace implementation has not yet been
adapted to registered personal projects. Approval and other delegated adapters
are still required before enabling the Qwen MCP bridge; the provider continues
to reject these MCP profiles explicitly.

Inspection also found that carrying a user principal through private SDK fetch
was insufficient: the trusted-request path bypasses the public HTTP gate, while
many native handlers still lack scoped object checks. Private user SDK HTTP
calls now fail with `User SDK operations require scoped authorization`, matching
the existing user realtime refusal. Trusted service and administrative plugin
calls remain available. Scoped SDK operations and child/workflow authority will
replace this refusal as their boundaries are implemented. This is not a claim
that all plugins can already operate safely on behalf of users.

Real migrated-database HTTP tests exercise an authorized plugin call, foreign
and built-in tools, profile-grant/version revocation, user disablement, viewer
project access, foreign environment paths and inactive threads. No denied call
reaches the plugin; restored authority permits another invocation. A Linux
Docker fixture uses the deployed source's production guard and real SQLite to
verify exact catalog filtering, async principal propagation, revocation and
private user SDK denial. That fixture does not claim a live Qwen MCP round-trip;
its activation remains the next integration. The complete actual fork Docker
server/daemon/Qwen deployment is also rerun for this increment.

Verification: 94 selected server security, internal tool and runtime-config tests
pass; the new tool case also passes with additional viewer-project and foreign
workspace probes. Strict server typecheck and changed-file lint/format checks
pass. The full fork Docker deployment passes with the production guard/SQLite
fixture and previous native runtime checks. See
`control-plane-phase-13-verification.json`.

## Fourteenth increment: approved BB MCP bridge in Qwen

The Qwen Server bridge now consumes the already-contributed dynamic tool
catalog instead of discarding it. It supplies a local delegated adapter to the
query factory, not caller-provided SDK MCP configuration. The factory resolves
the private thread/profile context first, validates approved `bb:<tool-name>`
entries against the available catalog and constructs only its own `bb` SDK MCP
server. Raw SDK MCP instances are still rejected before connection. Missing,
duplicate or unsupported delegated names fail explicitly; caller exclusions can
only reduce the selected tools. `update_environment_directory` remains denied.

Each MCP list/call re-resolves current authority over the private Unix socket
and checks the user, BB thread, native Qwen session and bound profile version.
Only initially selected tools remain available. Calls then use BB's existing
pending-tool tracker and native daemon tool route, where the mandatory core
profile/project guard runs again before plugin invocation. Tool arguments do
not replace the captured identities. SDK MCP configuration is created only
after authorization, and trusted plugin execution retains the user's async
principal. Scoped plugin SDK operations and child/workflow authority remain
unfinished; the full private user SDK is still denied.

Protected settings now clear the entire untrusted `mcpServers` configuration.
For approved BB tools, only `bb` is allowed and only their exact qualified names
are made eager/visible. With no selected delegated tools, MCP remains disabled.
The existing protected model, native-tool, hook, extension and launch policy
stays in force. Arbitrary stdio/HTTP MCP servers and interactive approval modes
are not supported by this increment and are rejected rather than ignored.

The Docker lab installs a disposable typed server-tool plugin through the real
administrative API. For each user, the deterministic backend first calls the
native shell identity probe, then the approved BB MCP tool and consumes its
actual result. The result's BB thread/project are checked against persisted
ownership; the plugin's attempt to use the full private SDK is denied. Another
registered plugin tool is not offered. Alice's HOME contains an impostor `bb`
MCP command as well as the previous hostile settings; none of their marker
files appear. Native session resume, two-user isolation, timeline and service
crash recovery remain passing. The fixture is copied only into the Docker lab
image and is not added to the bundled production plugin registry.

Installing a source plugin in the network-isolated container revealed missing
build tooling in the image. The image now includes the same exact esbuild and
Tailwind toolchain pins used by BB's normal plugin builder, recorded in the
runtime npm lockfile. Installation therefore uses the ordinary source-plugin
build path without fetching tools after startup or weakening packaging checks.

Verification: 24 provider tests pass, including a real in-memory MCP client and
native bridge tool-response forwarding; provider/server strict typechecks and
changed-file lint/format checks pass. The complete fork Docker deployment passes
with the actual model → Qwen → BB plugin → model round trips. The backend remains
a deterministic local fixture, not a corporate CLI or a live external model.
See `control-plane-phase-14-verification.json`.

## Fifteenth increment: native approval lifecycle

Qwen Server now advertises `accept-edits`, `auto` and `full`. A native request's
mode must match the bound profile; mismatches fail before harness launch.
`full` maps to Qwen `yolo`. `accept-edits` uses Qwen `default` and approves
`edit`/`write_file` automatically only when their canonical target is inside
the registered project. Missing path arguments or uninspectable ancestors, symlink escapes and
provider-blocked paths do not receive that automatic file approval. Other
operations go to the normal BB interaction UI. `auto` selects the stock CLI's
native classifier mode and uses the same BB callback when it falls back to
manual approval. This does not introduce a filesystem jail: numeric UID/HOME,
process namespaces and registered-project admission remain the OS boundaries.

Protected settings clear inherited permission rules, legacy tool allow/exclude
rules and automatic acceptance. Profiles and explicit caller exclusions remain
authoritative. Caller-supplied SDK approval callbacks/auto-allow lists are
rejected. Restricted profiles cannot enable unreviewed native nested-agent,
workflow, team-creation or permission-mode-changing tools; their adapter remains
pending rather than running those paths with an assumed policy. The managed
core tool guard also denies `bb_workflow_run` until tenant-authored workflow
scripts can run under the registered UID; granting a tool name must not enable
untrusted JavaScript in the shared service process. Unmanaged administrative
workflow behavior is preserved.

The high-level SDK callback drops `tool_use_id`. Our existing custom transport
therefore handles the pinned CLI's native `can_use_tool` control requests,
preserving both request ID and actual tool-use ID. It sends other SDK traffic
through unchanged, processes approvals concurrently and never matches them by
arguments. BB receives `interaction/request` with native item/turn IDs, after
the translator has ensured that item's timeline entry exists. Only one-time
approval and denial are offered; persistent grants and edited input are not
accepted. No public SDK or host-daemon wire fields were added.

The private resolver rechecks current authority before a request and again
after a positive decision, including automatic project edits. An approval is
not a substitute for the profile grant. Stop, control cancellation, transport
exit/error and bridge disposal settle outstanding requests as denied; late
responses cannot execute the action. The transport permits at most 64 pending
requests and defaults to a five-minute deadline; an internal caller can only
shorten it through `timeout.canUseTool` (1–300000 ms). Bridge callbacks also
honor denied escalation for background turns. The bridge keeps
`approvalEnforcedBy: "provider"`: native classifier/file policy executes before
a manual request, and BB is the manual interaction channel.

The actual fork Docker lab now exercises seven cases: allow, deny, stop while
waiting, revoke a profile while waiting then approve, automatic project edit,
native-auto project edit, and a project-local native-auto command whose observed classifier query
receives malformed output before manual denial. Before manual decisions the side-effect file is absent. It appears
only for allowed operations; revocation prevents it even after an explicit
approval. Resolved/stopped threads have no pending interactions. Hostile HOME
auto-allow rules cannot bypass these asks. Existing two-user MCP, namespaces,
timeline, resume and parent-crash checks still pass. Public personal thread and
approval endpoints remain closed until their scoped API is implemented.

Verification: 30 provider tests and 94 selected server security/tool/runtime-config
tests pass, including parallel identical native
requests with different IDs, timeout/cancellation, late-reply fencing, canonical
path/symlink classification and native interaction mapping. Strict provider/server
typechecks and changed-file lint/format checks pass. The full Docker deployment
passes with the pinned stock CLI and deterministic local model backend. This
does not verify a corporate fork or real external classifier/model quality.
See `control-plane-phase-15-verification.json`.
