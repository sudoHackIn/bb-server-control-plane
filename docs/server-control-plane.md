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
- [x] Expose owner-scoped native thread start/list/status/send/stop/result, persisted event pages and native approval/question resolution through the personal API, SDK and CLI; verify cold project provisioning and same-session restart in Docker. Live subscriptions and user UI remain pending.
- [x] Add a personal workflow run screen through the limited SDK: project list, status/result/history, inline start, terminal replay and cancellation, with access failures hiding cached data.
- [x] Persist personal workflow definitions and immutable source/default-argument revisions, with stable source authority and API/SDK/CLI/UI controls for create/read/update/run/enable/disable/delete.
- [x] Add native administrative workflow-definition management with owner/project inventory, immutable revisions and owner-adopting dispatch through the existing SDK/RPC/CLI path.
- [x] Bind native automation agent definitions/runs/sweeps to saved user authority, execute through registered Qwen workers, preserve revisions and recover owned once schedules; personal mutation API/UI and script execution remain subsequent increments.
- [x] Expose owner-scoped automation metadata and run history through the limited API, SDK and CLI, including bounded pagination across incomplete reservations; personal mutations and UI remain pending.
- [x] Add our limited public API for projects, thread start/send/stop/status/result/events and model/agent selection through approved profile versions. A user token never grants access to the full BB API.
- [x] Bind thread ownership before provisioning; enforce project, source-thread, parent-thread and environment grants. Select UID/HOME/cwd from the registry for managed Qwen threads.
- [x] Stream personal persisted events with exclusive cursor replay and native BB timeline snapshots/updates; recheck token/project authority on every frame and idle intervals, limit buffers/connections, and release subscriptions on cancellation. Global lists/search/bootstrap/user UI still require separate scoping.
- [ ] Filter lists, search, bootstrap data and events at their data sources; verify subscription ownership and access revocation.
- [x] Gate managed daemon plugin-tool invocations by current project/profile permissions, filter their contributed tool catalog and propagate the persisted user principal; deny unscoped private user SDK calls. The Qwen MCP bridge and scoped SDK adapter remain pending.
- [ ] Carry verified user/run context through plugin calls and child creation. Plugin identity, parentThreadId and origin metadata are not authentication.
- [x] Add the internal durable background authority-binding registry, immutable object revisions, current-grant/source checks and user-principal callback scope. Actual workflow/automation/scheduler integration remains pending.
- [x] Expose lifecycle-scoped internal background authority only to builtin Workflows/Automations, derive owner/profile context server-side and verify registration/read/restart plus unapproved-plugin denial in Docker. Native plugin persistence/execution integration remains pending.
- [x] Expose personal native workflow run start/list/status/result/history/stop and terminal replay through the limited API, SDK and CLI, reusing builtin persistence and owner authority. Automations and schedules remain pending.
- [x] Manage personal agent automations through limited API/SDK/CLI: create/edit with revision CAS, pause/resume, idempotent run, durable individual stop and deletion. Personal UI and the composite background audit remain pending.
- [x] Add the personal Automations workspace using the limited API: revision-protected editor, once/cron schedules, pause/resume, manual run, paginated history, individual cancellation, conversation links and confirmed deletion; verify both users in a real browser.
- [ ] Persist execution-context references for queues, retries, workflows and schedules; recheck permissions at actual execution and after restart. Do not persist browser access tokens for jobs.
- [ ] Make execution admission mandatory even when a policy plugin is absent. Audit internal daemon RPC so a machine credential cannot impersonate a user or gain global access.
- [x] Add certificate browser sessions, Origin checks for cookie writes, browser role-switch revocation and personal source-filtered bootstrap pages through SDK/CLI. Native UI access and actual client cache isolation remain pending.
- [x] Gate native web initialization on verified browser context, namespace core caches/drafts/recordings by actor and session epoch, revalidate returning pages, and reject frontend requests bound to an old actor. Legacy plugin persistence and rendered personal UI remain pending.
- [ ] Clear account-scoped browser caches and drafts when switching identities or signing out.
- [x] Open a separate personal browser entry with native sidebar navigation, paginated own project/thread metadata and access-loss handling; leave administrative bootstrap and plugin frontends closed.
- [x] Render owned conversations through the native timeline and scroll surface, personal SSE, older history and deferred tool details; retain the limited API boundary.
- [x] Connect the native composer and approval/question forms to personal start/send/queue/stop/resolve operations, select approved profiles for new threads and read pinned profiles through SDK/CLI.
- [x] Support personal project/thread/message URLs, URL-driven sidebar selection and authorized SDK/CLI browser links; validate certificate-login return destinations.
- [x] Exercise the production personal text-chat bundle in a real browser with separate client-certificate contexts, native editor submissions, actual Qwen replies, denied foreign links and logout. Broader native UI/cache/background-job coverage remains pending.
- [ ] Use this fork's native UI for both roles. Keep projects/threads/composer/timeline/model controls for users; remove the right workspace panel and administrative controls in user mode.
- [ ] Complete the mandatory [per-user workflows, automations and schedules stage](#per-user-workflows-automations-and-schedules), including background execution and isolation tests.
- [ ] Install plugins centrally; grant users access to approved agent profiles, never arbitrary server-code installation.
- [ ] Package and verify this fork in the Docker lab, including direct API/CLI bypass attempts from a user's UID, certificate login and user-to-user denials.

## Per-user workflows, automations and schedules

This stage is required before shared multi-user deployment. The composite checks below remain incomplete; the increment reports document the verified subset. Inventory the existing workflow, automation and scheduler storage and execution paths, reuse their persistence where possible and enforce ownership at the actual boundaries.

### Implementation stages

- [x] Inventory definitions, runs, schedules, triggers, queued/delayed messages, retries, workflow replay and their API/CLI/plugin entry points. Identify every background path that can create a thread or execute a tool. See [the background inventory](control-plane-background-inventory.md) for source locations, trust boundaries and remaining implementation/acceptance; this item closes the inventory only.
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

## Sixteenth increment: personal thread API, SDK and CLI

The limited user facade now creates native BB conversations in a registered
project with an exact approved profile version. It exposes owner-filtered lists,
status, send, stop, persisted event pages, latest text and native interaction
listing/resolution. `createControlPlaneClient(...).threads` and `bb server access
threads` use these routes with the existing certificate/PKCE-issued user token.
Raw native HTTP, private plugin SDK and native realtime endpoints remain closed
to that token. Lists filter ownership and current project grants in SQL before
pagination; another user's project grant never grants their conversations.

Start accepts project ID, profile-version ID, message and optional title only.
The service derives provider/model/reasoning/permissions and UID/HOME/cwd/host
from the approved version and registered project. It reuses a matching ready
native environment or provisions the normal project-checkout provider. Send
continues the same native session with the pinned version, queues when active,
and accepts no execution-option override. Unsupported steering is rejected.
New actions and interaction resolutions recheck current profile authority;
profile revocation preserves authorized history and the ability to stop one's
own job. Current project access remains required for every thread operation.
Pending native approval or user-question responses go through the same native
interaction validator and provider recheck as the administrative path. Extension
form resolution is not exposed until scoped plugin actions are implemented.

The real cold-start path required two narrowly scoped private SDK reads.
Project-checkout validation can list environments only for the server-selected
exact host/path/project during that provisioning context. The query rechecks
current project access and filters by project in SQL. The centrally installed
`concurrency-limit` message-dispatch hook can read running-thread ID/host pairs
only inside its own callback, after current thread/project/profile admission.
Other hooks, arbitrary query options and mutations are denied. That trusted
capacity policy gets no conversation content; no full service-principal fallback
was added. Public user HTTP access to both native routes remains denied.

Events are canonical persisted BB rows with exclusive sequence cursors and
bounded pages. This increment does not supply a live stream or reconstructed
UI timeline. Result means latest assistant text with current thread status,
not an immutable execution snapshot. Live subscriptions/revocation, native
user UI, scoped delegated plugin actions and personal workflows/schedules
remain subsequent required stages.

Verification: 641 database tests, 166 selected server security/tool/runtime-config/
dispatch-hook tests, a final personal API retest and five CLI registration/JSON
checks pass. Strict server/CLI/SDK/database typechecks and changed-file lint and
format checks pass. The real fork Docker deployment verifies certificate login
through the actual CLI, fresh projects with no preseeded environment, two-user
UID/HOME/cwd probes, foreign access denial, one-time approval, grant revocation
before side effects and same-Qwen-session continuation after BB restart. The
backend is the local deterministic fixture with pinned stock Qwen CLI, not a
verified corporate fork or external model. See
`control-plane-phase-16-verification.json`.

## Seventeenth increment: personal native timeline and live replay

Personal clients can now open `/control-plane/user/threads/:id/stream` with an
exclusive persisted event sequence. The authenticated SSE response replays
canonical BB event rows, supplies a full native timeline snapshot, emits a
`ready` marker after the initial replay, and forwards subsequent native BB
changed/timeline frames. It subscribes only to that thread's detail and fixed
20-segment deferred-content timeline targets. The same native timeline builder
and hub power both roles; window instances are shared per hub so registering
the personal facade does not install duplicate projection listeners.

`createControlPlaneClient(...).threads.stream` is an async iterator; the CLI
`bb server access threads stream --after ... --json` prints JSON lines and
cancels its subscription on Ctrl-C/SIGTERM. Both also expose a latest-window
`timeline` read. Live frames retain native BB shapes and are not durable replay
records. Reconnection uses the last consumed canonical `event.seq` and receives
a new full timeline snapshot. A mismatched native delta baseline is replaced
with a full snapshot; no consumer must apply a delta to an assumed baseline.
This does not implement exactly-once delivery, automatic reconnect, older
window/content pagination, global subscriptions or the user UI.

Every emitted frame checks current project ownership/access and token validity;
an idle one-second check closes revoked, expired or disabled identities. Profile
revocation preserves already-authorized history reads. Transport cancellation
and authority loss unregister both native hub targets and release the slot.
Limits are four streams per user and 64 per server, a 64 KiB stream high-water
mark, at most 2 MiB of pending live frames and 16 MiB per frame. Slow clients are
closed rather than accumulating unlimited data. Heartbeat comments keep idle
connections alive. Bearer credentials never enter stream URLs. The full native
BB WebSocket and private user SDK/realtime remain closed.

Verification: 129 SDK tests, 166 selected server security/tool/runtime-config/
dispatch-hook tests, 26 native timeline push/delta/scrollback tests and 12 CLI
registration/JSON/error-output checks pass. Strict server/CLI/SDK/contract
typechecks, changed-file lint/format and diff checks pass. The full fork Docker
deployment verifies actual CLI replay, a live native Qwen turn and timeline
update, cursor reconnect, repeated cancellation without exhausting stream slots,
revocation-driven disconnect and closing an open stream during BB shutdown.
The CLI now marks emitted JSON lines so a later transport failure cannot append
a pretty-printed error envelope to the live output. The local deterministic
model and pinned stock CLI remain the backend, not a verified corporate fork.
See `control-plane-phase-17-verification.json`.

## Eighteenth increment: certificate browser sessions and personal bootstrap

The browser sign-in page uses the existing trusted-client-CA TLS listener and
verified certificate CN. The empty form requires the configured Origin and
rejects body fields. Registry allocation remains UUID/atomic UID based. An
opaque 24-hour browser cookie is HttpOnly, Secure on HTTPS, SameSite=Strict and
stored only as a digest in the existing session table. Browser session rotation
and revocation are transactional; a failed issue leaves the previous credential
intact. Missing, disabled and expired identities cannot receive a new session.
PKCE CLI/plugin credentials keep their existing behavior.

Personal endpoints accept the browser cookie only when Authorization is absent.
An explicit invalid Bearer credential never falls back to either role's cookie.
Cookie mutations require a matching Origin. Personal browser sign-in revokes
and clears the previous administrative browser cookie; administrative password
sign-in revokes and clears the personal cookie. Switching certificate users
retires the prior browser credential. Logout revokes the session server-side.
Browser sessions survive BB restart and expire without refresh. Native API,
UI assets and raw WebSocket access remain closed to personal cookies at this
stage; the sign-in redirect is the personal identity endpoint, not a claim that
the native user UI is finished.

The new personal bootstrap returns identity, fixed capabilities and the first
50 project/thread/profile records, with separate continuation cursors. It uses
the existing current-grant SQL queries and persisted thread ownership, not a
filtered copy of the administrator's bootstrap. It includes no global settings,
all-host catalog or unrestricted plugin registry. SDK `bootstrap()` and CLI
`server access bootstrap` expose the same result; `browserLoginUrl()` and
`server access browser` expose certificate sign-in navigation. Bootstrap accepts
no user/environment overrides. Navigation continues through scoped list APIs.

Login/logout responses request `Clear-Site-Data` cache/storage clearing. This
is a server-side header only: application memory, drafts, persistent native UI
caches and concurrent-tab identity changes still require client integration and
verification. The full cache-isolation and native-UI checklist items remain open.

Verification: 644 database tests, 46 server security tests, 129 SDK tests and
12 CLI registration/JSON/error-output checks pass. TLS tests use actual trusted,
rogue and wrong-purpose certificates, exercise cookie flags, Origin checks,
explicit invalid Bearer rejection, browser role transitions, disabled identities,
expiry and logout. A personal API test verifies cookie-authenticated bootstrap
and native live-stream reads, plus source-filtered ownership and revocation.
Strict server/CLI/SDK/database typechecks and changed-file lint/format checks pass.
The full fork Docker deployment verifies the same certificate/browser boundary,
real bootstrap/login-URL CLI commands and browser-cookie persistence across BB
restart while retaining native Qwen/MCP/approval/timeline/isolation checks.
This verifies HTTP/cookie behavior, not rendered native user UI or browser cache
clearing effectiveness. See `control-plane-phase-18-verification.json`.

## Nineteenth increment: verified browser initialization and core cache scope

The web entry now verifies browser context before dynamically importing the
native application. Shared-server responses describe only the current
administrator/user or anonymous mode. Standalone BB returns an explicit
standalone mode and keeps its preexisting local settings on the first boot.
Personal mode still redirects to the identity endpoint; this increment does
not open the full administrative app or claim a completed personal UI.
SDK `browserContext()` and CLI `server access browser-context` expose the same
metadata without granting native API access.

Authenticated context includes a stable noncredential fingerprint derived from
the current credential verifier with a separate cache domain. A fresh sign-in
changes this epoch even for the same account; an existing personal session's
epoch survives server restart. The frontend captures immutable actor/session
storage scope for the document. Deferred writes from an old document cannot
retarget a newly signed-in identity/session. Core local/session storage, prompt
and question drafts, sidebar/model/workspace caches, theme preferences and voice
recordings use that scope. Initialization clears previous/legacy core data and
prunes inactive namespaces; known recordings are reset in IndexedDB, with
additional inactive database cleanup when enumeration is supported.

Cached account CSS is applied only after verification. Inline HTML pre-paint
uses the system scheme without reading stored account data. The stylesheet/font
ordering guard now recognizes an explicit pre-paint marker instead of requiring
a raw theme-key read. The existing native application moved to a lazy entry;
its disposer unmounts React, cancels and clears queries, closes the native
socket and removes browser/chunk-recovery listeners. Identity/epoch changes
hide and retire the old view, clear core data and reload. Hidden/history-returned
pages revalidate before showing the view; stale overlapping checks cannot
restore a retired identity. Unverifiable context fails closed.

Same-origin frontend fetches assert the verified actor through the optional
`x-bb-client-identity` header. `x-bb-client-session` also asserts the current credential epoch. The backend compares both assertions with existing
credentials before protected operations. It accepts percent-encoded
UTF-8, rejects mismatches/malformed encodings, and never treats the header as
login authority. Context observation and sign-in flows remain available to
change identities. Administrator login/logout also emit cache/storage clearing
headers. The Vite development proxy forwards the new context route so ordinary
standalone development still boots.

Legacy plugin frontend code using raw storage is not migrated here. The broader
cache-isolation checklist stays open until those approved plugin paths and the
rendered personal native UI are integrated and verified. Production browser
rendering remains a subsequent required check; DOM/cache tests and a rebuilt
Docker HTTP deployment do not substitute for that evidence.

Verification: 137 selected app/cache/theme/draft/recording/bootstrap/header tests,
47 server security tests, 129 SDK tests and 12 CLI checks pass. Bundle and
stylesheet/font/module-preload guard checks pass. Strict app/server/SDK/CLI
typechecks, changed-file formatting and lint error checks pass; four React
compiler warnings remain in unchanged component statements. The Docker image
rebuilds the native lazy entry and verifies real context/CLI responses, stale
actor/session-header denial, credential-bound epochs and personal-epoch
persistence across restart while retaining the full Qwen/MCP/approval/timeline
and UID isolation checks. DOM tests cover portal/title hiding during history
restore; this is not a production-browser rendering verification. Personal UI
and legacy plugin persistence remain open. See
`control-plane-phase-19-verification.json`.

## Twentieth increment: personal native sidebar navigation

Certificate browser sign-in now opens `/control-plane/app`. The existing web
entry verifies identity/session epoch, lazily selects the separate personal
application and verifies context again before mounting. It never loads the
full administrative application for a user. Both modes retain the existing
identity-change, history-restore and cleanup gate.

The personal entry composes the native responsive Sidebar components, theme and
frame geometry. Projects remain on the left with their owned thread summaries;
there is no right workspace, terminal, settings page or plugin frontend boot.
It reuses the personal SDK's bootstrap and source-filtered project/thread list
and detail operations. Projects and threads have explicit pagination, and thread
lists are queried for the selected project. Queries have a separate ephemeral
client, abort on disposal and revalidate periodically. Late responses for a
previous project cannot populate a different selection. A failed authentication,
project or thread refresh hides the affected data instead of retaining stale
private details. Sign-out uses the existing limited logout endpoint.

The access boundary admits only the exact personal shell, compiled single-level
asset paths and named application icons/manifest for an authenticated identity.
Missing credentials, invalid explicit Bearer, cross-origin requests and stale
actor/session assertions remain denied. This serves code assets without opening
native APIs, raw WebSocket, plugin asset routes or arbitrary shell fallback
paths. The identity JSON endpoint is unchanged. SDK and CLI readers remain the
same paths used by this navigation; the existing browser-login URL now reaches
this screen after certificate sign-in.

This increment is navigation and metadata only. Native timeline, composer and
model controls remain open work, as do approved plugin frontend persistence and
production-browser rendering verification. The complete personal UI checklist
is deliberately not checked off.

Verification: 18 selected app tests and 10 server security tests pass. Strict
app/server typechecks, changed-file lint and formatting checks pass. The full
Docker deployment builds both native entries and fetches the compiled personal
module over TLS using a certificate-issued browser cookie. It also
verifies anonymous asset denial, personal API isolation and all previous
Qwen/UID/HOME/approval/stream/restart checks. These are not production-browser
rendering tests. See `control-plane-phase-20-verification.json`.

## Twenty-first increment: personal native conversation timeline

Selecting an owned thread now mounts the existing ThreadTimelineSurface and
BottomAnchoredScrollBody. Native messages, expandable commands and reasoning,
streaming rows and history paging use the personal SDK. A private React context
selects the detail reader for native hooks and hover prefetching; administrative
rendering uses the same hook path with its existing native SDK reader. User mode
still does not bootstrap plugin frontends, settings or the workspace panel.
Local-file links are consumed without invoking privileged file actions. Browser
routing is mounted for the native timeline's message-location handling.

The limited timeline endpoint accepts only the paired native earlier-page
cursor. A separate timeline-details endpoint accepts a bounded turn/sequence
range, optional item and details cursor. Both resolve the persisted owner and
current project access before calling the native projection. Foreign IDs and
transplanted history cursors fail; callers cannot override environment, provider,
model, tools or permissions. Older pages retain native snapshot validation and
content bounds. SDK olderTimeline/timelineDetails and CLI timeline cursor flags
plus timeline-details expose the same operations.

The personal live controller starts from an authorized snapshot and consumes the
existing personal SSE stream. It applies native deltas only to the matching
baseline, resnapshots otherwise and retains loaded history using native merge
helpers. It ignores late responses after changing threads, retires disconnected
rows, reauthorizes before reconnecting and handles lost earlier-page cursors by
refreshing history. Native status-change metadata updates the working indicator.
Permission failure during history recovery hides rows and cancels the live
subscription. Disposal aborts requests and releases the reader. The SDK parser
also cancels an idle custom transport reader on AbortSignal, including when no
new frame arrives; aborting buffered replay stops further delivery.

This increment does not complete the composer, profile/model controls, personal
deep links, attachment preview routes, approved plugin frontend storage or production-browser rendering
verification. The full personal UI and workflow/automation/scheduling checklists
remain open.

Verification: 56 selected app/native timeline tests, 8 server timeline/security
checks, 132 SDK tests and 24 CLI registration/JSON/error tests pass. Strict
app/server/SDK/CLI typechecks and changed-file lint/format checks pass without
lint warnings. The full Docker deployment executes the actual personal native
Qwen command, reads its timeline and hydrates its deferred command through the
new real CLI, denies foreign detail access and retains prior approval, replay,
UID/HOME and restart checks. Migrated-SQLite tests cover older-page pagination,
transplanted cursors and grant revocation; DOM tests cover native messages and
command expansion. Production-browser rendering is not claimed. See
`control-plane-phase-21-verification.json`.

## Twenty-second increment: native personal composer and approved agent selection

The personal workspace can start a conversation in the selected project with a
currently permitted profile. It statically composes the actual built-in Composer
renderer through the existing host API and runtime. It does not start the
installed-plugin frontend loader. Native rich text, Enter submission, queueing,
stop controls, approval banners and user-question forms use the limited client.
The editor has its actual thread/new-project draft scope and a stable draft key.
Shared query transports use their existing native readers in administrative mode
and the explicitly bound personal readers in this view. Native host/daemon/thread
bootstrap queries stay disabled for personal interaction forms.

Mention/command searches and pasted-thread resolution have explicit host inputs;
user mode does not query global catalogs or fall back to the unrestricted SDK.
Plugin composer customizations, including the plus menu, are suppressed here.
Scoped autocomplete, personal deep links, attachment previews/uploads, first-login
workspace/project creation UI and broader approved plugin frontend integration
remain open work. These limitations do not mark the full native user UI complete.

The project/profile catalog uses personal SDK readers with pagination and grant
refresh. A new thread sends only projectId, profileVersionId and message; existing
threads send only the message with queue-if-active. There is no client-supplied
UID/HOME/cwd/tool/MCP override. The new thread profile reader resolves the
persisted profile version and rechecks current grants, even after newer versions
are published. Its SDK and CLI surfaces use the same route as the UI. A revoked
profile disables sending and interaction controls while authorized history and
stopping remain available.

Drafts reuse the account/session-scoped native storage. Confirmed sends clear
only the submitted snapshot, preserving a subsequently changed draft. Failure
or uncertain delivery retains input; the UI does not claim exactly-once delivery.
A local latch prevents simultaneous duplicate submissions. Leaving a composer
aborts its requests; delayed results cannot select a thread in another view.
Lifecycle effects tolerate StrictMode teardown/recreation. Native status frames
update the personal thread cache so controls follow the live conversation.

The app TypeScript resolver now includes shared UI fallbacks for directly reused
first-party composer source, matching the existing forkable-plugin Vite resolver.
The plugin remains independently typechecked and packaged. Its stable composition
key-event set uses a state initializer, preserving identity without reading a ref
during render. No new public Plugin SDK member is introduced.

Verification: 146 selected app/native composer/interaction tests, 3 server
profile/thread security scenarios, 132 SDK tests, 24 CLI checks and 87 Composer
plugin tests pass; 3 opt-in plugin performance tests are skipped. Strict
app/server/SDK/CLI/plugin typechecks and changed-file lint/format checks pass
without lint warnings. The production bundle and full Docker deployment rebuild
successfully. Actual certificate-authenticated CLI reads prove an existing
thread retains its pinned version after a newer profile publication; prior
Qwen/UID/HOME, approvals, personal SSE, revocation and restart checks pass.
DOM tests exercise the real editor, Enter, native approval/question forms,
queue/stop, StrictMode cancellation and failed-delivery draft retention. These
are not production-browser rendering tests. See
`control-plane-phase-22-verification.json`.

## Twenty-third increment: personal conversation links

Personal navigation now follows canonical native project/thread URLs, including
`/threads/<id>` and `#msg=<sequence>`. New conversations update the URL; Back and
Forward restore selection. The selected project and thread are read directly
through the personal SDK, even outside the loaded sidebar pages. Their actual
relationship is checked before mounting history or the composer. Pending,
revoked, foreign, inconsistent and invalid-message destinations do not expose
conversation content or enable sends. Selected authorized objects join sidebar
navigation without a global catalog fetch.

Authenticated personal GET/HEAD requests can read the same production shell at
these canonical paths. The shell contains no object data and does not establish
ownership; all data/actions still require the limited API. Anonymous HTML reads
redirect to certificate login with a bounded return destination. GET and POST
reject duplicate/unknown return fields, external origins and non-personal paths.
The login form posts to its current document URL. Preservation of message
fragments through browser redirects and login is pending real-browser testing.

`threads.browserUrl(id, { messageSeq, signal })` and
`bb server access threads link <id> [--message <sequence>] --json` first read the
current authorized thread, derive its actual project and return a credential-free
URL. The command does not launch a browser. Native copied message links use the
same URL shape.

Verification: 52 selected app/native timeline/composer tests, 12 migrated-SQLite
server security tests, 2 SDK transport tests, 1 path-contract test and 46 CLI
registration/session/error tests pass. Strict app/server/SDK/CLI typechecks and
changed-file lint/format checks pass without lint warnings. The full Docker
build/deployment passes all 61 tasks, proves canonical shells use the identical
protected production bundle and exercises the new link command against actual
personal Qwen conversations. Rendering, fragment inheritance and native anchor
scrolling in a production browser remain unverified at this increment. See
`control-plane-phase-23-verification.json`.

## Twenty-fourth increment: production personal-browser verification

A reproducible `test:control-plane-browser` Turbo task runs the existing real
fork deployment with an installed headless Chrome controlled by pinned
Playwright Core. It loads the compiled native personal entry rather than a dev
server or DOM-only renderer. Separate nonpersistent Alice/Bob browser contexts
use temporary fixture client certificates. The test does not install trust roots,
open the operator's existing browser profile or add browser dependencies to the
runtime image. Certificate/key material is read from the fixture into memory;
it is not printed or included in artifacts.

The test opens canonical conversation/message links before login, signs in by
certificate and checks that the original path and fragment survive the form and
redirects, then reloads the conversation. It renders the actual native sidebar,
timeline and Composer, selects an approved profile and submits Enter to create a
real Qwen conversation and send a follow-up. The local model fixture returns real
streaming responses through stock Qwen/daemon/control-plane execution. An actual
native command writes a UID/HOME/cwd proof that the container verifies against
Alice's registry. This is not corporate Qwen authorization verification.

Both users can render their own threads; one user's project is absent from the
other's navigation. Bob's request for Alice's new thread returns 404, its shell
shows unavailable without message content or an editor, and the raw native API
returns 401. Page request tracing checks that initialization and the complete
submit/logout scenario do not call the full API, raw WebSocket or plugin
frontend entry points. Logout returns to certificate login, hides the editor and
revokes subsequent cookie access. Uncaught page errors fail the check. Optional
screenshots and bounded failure diagnostics can be saved to a private directory.

The browser variant publishes only loopback host port 8080 from its disposable
container. It retains the read-only root, tmpfs data, anonymous volumes, namespace
checks, restricted launcher and deterministic model fixture. It is separate from
the original deployment test, which still uses `--network none` and no published
ports. The browser-result handshake uses an atomic rename, and all browser
contexts/processes, test credentials, data and containers are temporary. macOS
sandbox execution required allowing the separate headless Chrome process; no
system certificate or normal-browser settings were changed.

Production text-chat coverage does not complete all personal UI work. Attachments,
scoped autocomplete, first-login project creation, legacy plugin browser storage,
full administrative browser scenarios and personal workflows/automations/
schedules remain separate work. Native message-target pagination/scrolling needs
a long-history browser scenario beyond the fragment/reload checks here.

Verification: the final production-browser Docker task and the default
network-isolated deployment task each pass all 61 Turbo build/deployment tasks.
Chrome 155.0.8059.85 completes the certificate/real-editor/Qwen/foreign-link/logout
scenario with zero uncaught page errors. Actual command identity matches the
registered UID/HOME/project cwd. Strict app/server typechecks, changed-file
lint/format and diff checks pass. A screenshot of the successful native
conversation was inspected. These are focused integration checks, not the full
repository suite. See `control-plane-phase-24-verification.json`.

## Twenty-fifth increment: durable background authority-binding foundation

Migration 0152 adds an internal shared-DB registry for workflow definitions/runs,
automations/runs and schedules. Native product persistence is reused; workflow
history, results, source and scheduler state are not duplicated. The new binding
stores owner/project/profile references, object revision, optional source binding
and original thread. Definition edits can allocate a new immutable revision
without mutating prior runs or moving the object to another owner/project.
No browser credential or client-supplied UID/HOME is accepted.

Current owner/project filtering precedes SQL pagination. Execution resolves the
registered identity and pinned profile anew and checks every source's enabled,
deleted and grant state. Foreign sources, missing bindings, deleted origins,
source cycles and chains beyond 32 bindings fail closed. Authorized history can
remain readable after profile revocation; safe disable/delete operations remain
available while re-enable requires renewed execution authority. Tombstoned
binding revisions cannot be resurrected by repeated registration.

The server callback guard adopts the saved user principal and rejects a different
user principal, including across asynchronous work. This is internal plumbing;
there is no new public plugin SDK method or personal job-management API yet.
Existing plugins have not been wired to it, tenant scripts still need registered
UID execution, and legacy objects have not been migrated. The complete required
workflow/automation/schedule stage remains unchecked. The inspected source map
and next integration boundaries are in `control-plane-background-execution.md`.

Verification: 19 migrated-SQLite control-plane tests pass, including 8 binding
cases covering ownership, shared projects, pagination, rollback/idempotency,
profile revisions, grant loss, origin cleanup, deleted/cyclic/deep sources and
credential-independent reopening. Strict DB/domain/server typechecks and
changed-file lint/format/diff checks pass. The actual Docker fork runs migration
0152 and creates bindings for two real personal Qwen threads in its service DB.
It verifies source disable/re-enable and foreign denial, restarts the server,
then runs parallel callbacks with each saved user's principal and pinned
registry/profile context, after Bob's browser/CLI credential was revoked. All
61 Docker build/deployment tasks pass. This proves the binding kernel and its
callback scope, not actual personal scheduler/workflow execution. See
`control-plane-phase-25-verification.json`.

## Twenty-sixth increment: builtin-only background authority facade

The Plugin SDK's internal server namespace exposes bind/get/list/enable/remove
and saved-authority callback operations to builtin Workflows/Automations only.
The host derives plugin identity and provenance from its installed record. It
returns null in standalone mode and rejects other plugin access in shared mode.
The fake host remains explicitly standalone. Captured facade methods recheck
plugin liveness, so disposal cannot leave an operational cached handle.

Binding rejects unknown owner, UID, HOME and credential fields. It derives owner
from the current user or registered project owner in an explicit administrative
request. Unscoped background service registration is denied; adopting a saved
user scope permits controlled nested registration. A null profile version
resolves the managed origin thread's persisted version. Per-plugin kinds and
current ownership/project access constrain user metadata reads and mutations.

Administrative/service inspection can read that plugin's metadata across owners,
including disabled-user history. The core registry now has an explicit trusted
administrative metadata mode; adapter actions reuse its existing canonical
mutators. This does not relax execution: current saved-user grants and source
ancestry still govern callbacks and re-enable. Migration 0153 indexes the new
kind/ID metadata reader. No HTTP route, daemon RPC, public job CLI or tenant
execution path is opened by this internal contract. Its audit entry, portable
SDK type exports and Plugin Guide inventory are updated.

Plugin services/restarts and schedule callbacks explicitly enter service scope,
even while an activating administrative request is still active. Administrative
registration and re-enable require live request authority. A separate bounded
request marker prevents an escaped async callback from using an inherited admin
principal after its response completes. Real host tests cover both in-request
service/schedule activation and the escaped-promise case, while ordinary
foreground administrative operations remain available.

The deployed authority fixture now exercises the facade rather than bypassing
it with direct registry calls. It registers two users' definitions/runs, inherits
pinned origin profiles, checks source disable/re-enable, denies foreign sources
and unscoped registration, and adopts parallel saved-user contexts after restart
without browser tokens. A genuine native Qwen MCP call to the ordinary test
plugin verifies it cannot obtain this privileged namespace from the real host.

Workflows/Automations have not yet attached these references to their own durable
objects or changed tenant runtime dispatch. Their actual persistence, scoped
operations, UID execution, notifications and schedule integration remain open;
this increment does not mark the required background stage complete.

Verification: 47 selected server authorization/SDK lifecycle/background tests,
the full 402-test Plugin SDK package, 8 registry tests and 11 Plugin Guide surface
tests pass. Portable SDK declarations and strict DB/server/SDK/guide typechecks
pass, as do changed-file lint/format/diff checks. Real HTTP tests verify that
active administrative activation cannot leak binding authority to services or
cron callbacks, and that an escaped promise keeps its old principal but loses
registration rights after the response. The foreground administrative operation
still succeeds. The final actual Docker build/deployment passes all 61 tasks,
including facade creation/read, current-source authority, restart without browser
tokens and denial of the privileged namespace from a real native Qwen MCP plugin
call. These are not completed personal workflow execution tests. See
`control-plane-phase-26-verification.json`.

## Twenty-seventh increment: native workflow ownership

The builtin Workflows service now stores nullable owner and central authority
references in its existing plugin-owned SQLite runs. Its incremental migration
preserves old history without assigning legacy rows to an arbitrary user. New
managed runs reserve the central binding with their native run ID before
inserting the native record; insertion failure retires that reservation. A
crash before insertion leaves no executable native row. This is an explicit
cross-database reservation protocol, not an atomic cross-database transaction.

Owner predicates apply before native SQL list limits and latest/active queries.
User reads additionally check the binding's kind, native object ID, owner,
project and origin against the row and current project access. Inspect/history,
resume and stop use the same association check. Administrative/service metadata
inspection keeps legacy history visible; resuming an unassigned run is denied.
Cancellation disables its execution binding. Replay compatibility across profile
or tool changes remains required before tenant execution can open.

The internal adapter exposes a dynamic caller identity, scoped project reads
and an executable origin snapshot from its immutable profile. Native workflow
creation no longer obtains execution defaults through unrestricted SDK calls.
A real Docker invocation caught an earlier facade-only test gap: the installed
builtin IDs are `workflows` and `automations`, not `bb--workflows` and
`bb--automations`. Production authorization now imports those IDs from the
builtin registry; tests verify the registry values and reject the old spellings.
Earlier increment reports describe their then-tested fixture scope; they were
not proof of native plugin integration.

On a shared server, managed workflows revalidate their saved execution binding
and fail before QuickJS until a registered-UID evaluator is connected. Unassigned
queued legacy workflows fail with an explicit migration error. Managed
notifications do not fall through to unrestricted thread sends. Standalone
workflow execution remains unchanged. The personal job API, isolated evaluator,
controlled child dispatch, scoped notifications/recovery, definitions,
automations and schedules remain unfinished; the overall background stage stays
unchecked.

Verification: all 253 Workflows tests, 44 selected server security/lifecycle
tests and the full 402-test Plugin SDK package pass. Native consumer contract
tests use the official fake host and real migrated plugin SQLite; they stub
the internal facade rather than claiming to test core authorization. Core
authorization tests use the actual adapter and migrated central SQLite. Tests
cover owner filtering before limits, hidden unassigned records, foreign
inspect/resume/stop denial, missing bindings, real SQLite insert failure and
closed shared-process evaluation. Strict server/SDK/Workflows typechecks,
portable SDK declarations and changed-file lint/format pass. The actual Docker
deployment enables the installed builtin through administrator CLI, starts runs
for two managed origins, verifies native owner/profile/binding records and
confirms their persistence after a server restart. The final build/deployment
passes all 61 tasks. See `control-plane-phase-27-verification.json`.

## Twenty-eighth increment: registered-UID workflow evaluation

Managed pure computation workflows now execute in a separate process under the
registered user's UID/GID, HOME and project cwd. The builtin Workflows service
uses the internal `evaluateWorkflow` adapter and persists successful results and
phase updates in its existing SQLite history. Output schema validation remains
mandatory. No source is evaluated in the service process as a fallback.

The root launcher accepts a fixed `launch-workflow` operation. Its installer
validates root-owned immutable paths and pins the evaluator artifact's SHA-256;
launch rejects changed artifacts or caller-supplied program arguments. The
existing user manifest, safe project traversal, cleared groups,
no-new-privileges, user/PID/mount namespace and per-job descendant supervisor
remain the execution boundary. Workflow processes receive no backend API key.
They use a fixed Node heap cap and the existing bounded QuickJS runtime. This
reuses the process boundary already deployed for Qwen; it does not add an
unrestricted command launcher to the plugin or public API.

The adapter accepts bounded JSON args, parsed body, runtime budgets, deadline
and abort signal. It validates protocol order, frame/output/event limits and
matches the trusted runner's actual UID/HOME/cwd against saved authority. Launch,
events, result and completion recheck the binding; an additional 500 ms check
stops running evaluation after revocation. Cancellation, deadline and protocol
failure call the fixed stop helper and await process close. Log/phase callbacks
run under saved user authority. Pending promises keep the evaluator alive until
completion or explicit cancellation.

A dedicated Turbo build task emits the portable artifact under
`apps/server/.control-plane-runtime/`; generated output is ignored by Git. The
Docker build consumes the same artifact and configures it through the root
installer. Non-Docker installation is documented in `configuration.md`.

Verification: 256 Workflows tests, 44 selected server security/lifecycle tests,
402 Plugin SDK tests and 75 Plugin Guide tests pass, with strict
server/SDK/Workflows/guide typechecks and portable declarations. A byte-by-byte
Unicode pipe test verifies UTF-8 decoding across arbitrary chunk boundaries.
Changed-file lint/format/diff checks and Python compilation pass. Actual Docker tests use the
installed builtin and real CLI for two users, verify computed results and phase
history after restart, deny agent fallback, validate output schemas and cancel
a pending native run while disabling its binding. Additional actual-core
adapter checks cancel a running evaluator, revoke authority while it runs,
expire its deadline and reject an oversized result. Independent root process
inspection verifies external UIDs, PID namespaces, cleared capabilities and
no-new-privileges. Foreign stop/cwd and command override attempts fail; stopping
one user preserves another evaluator, and completed cancellations leave no
running workflow supervisor. The final build/deployment passes all 63 tasks.
See `control-plane-phase-28-verification.json`.

Agent workers and nested workflows still fail explicitly until controlled
bidirectional dispatch, profile/tool-aware replay and worker ancestry checks are
connected. Scoped notifications, restart recovery, personal job surfaces,
definitions, automations and schedules remain open. This increment proves
isolated pure computation, not completion of the background stage or the goal.

## Twenty-ninth increment: workflow worker authority and native dispatch

Migration `0154_nervous_bulldozer` adds a nullable authority reference to native
thread ownership, with a unique index so one worker attempt maps to one thread.
The reference survives deletion of the authority record. Managed Workflows
threads with missing, deleted, disabled, foreign or profile-mismatched worker
bindings cannot execute. The existing create/dispatch/Qwen-context paths perform
these checks; the public thread schema gains no binding/UID/HOME override.

A `workflow-worker` authority record belongs to a workflow-run, its project and
owner, and an immutable approved worker profile. Both the worker profile and the
source profile must remain granted. Worker origins contribute their own binding
to the dependency graph, preventing a new workflow started from a worker from
losing its parent's restrictions. Traversal permits convergent dependencies,
rejects cycles/missing edges and limits the complete graph to 32 bindings.
Builtin plugin IDs are shared domain constants used by the registry and guards.

The builtin-only facade now exposes start/read/send/stop worker operations.
Creation reserves authority before canonical personal-thread creation, keeps the
registered origin environment, and assigns hidden child/lifecycle/plugin metadata
internally. Failure retires the reservation. Reads and actions validate the exact
parent-to-worker relation. User history still requires current project read
access; trusted metadata inspection and safe stop work for disabled users.
Explicit worker stop disables its attempt before canonical native stop. A
service-scoped monitor checks pending/starting/active mapped threads every
500 ms and independently stops those whose current authority has been revoked.
Its shutdown clears the interval and awaits pending work.

Verification: the complete 655-test database suite passes, including migration
rewind/replay. The rewind helper was missing the earlier background-binding
table; it now drops that dependent table before profile/project parents. Tests
verify ownership/binding before notification, unique assignment, worker/source
profile checks, missing binding denial, retained references, convergent graphs
and cycles. There are 27 selected server security/lifecycle tests, 402 Plugin
SDK tests, 256 Workflows tests and 75 Plugin Guide tests passing. Strict
DB/server/SDK/Workflows/guide typechecks, portable declarations and changed-file
lint/format pass.

The actual Docker deployment creates mapped worker records beneath two running
native workflows with a private fixture, then dispatches them through the real
personal CLI, daemon and stock Qwen. Shell probes verify their actual UID/HOME/cwd.
Cancelling one native parent stops its worker while the other user remains
active. Foreign reads and resumed sends after source cancellation are denied;
the latter admits no new user-message event. Binding/source denial remains after
server restart. The complete build/deployment passes all 63 tasks. See
`control-plane-phase-29-verification.json`.

The Docker fixture seeds worker mappings directly; it does not prove successful
`startWorker` through the evaluator. The adapter's ownership/rejection/metadata
and safe-stop paths are tested, while its successful native consumer path is the
next integration step. `agent()` and nested workflow bridges still fail
explicitly. Their bidirectional protocol, profile-aware replay, controller
recovery/notifications, personal job APIs, automations and schedules remain open.
No completion of the background stage or overall goal is claimed here.

## Thirtieth increment: isolated workflow agents and durable result replay

Managed `agent()` calls now cross a bounded bidirectional JSON protocol from the
UID-isolated evaluator into the existing durable Workflows call controller. The
controller creates actual native Qwen workers through the scoped background-job
facade, polls their results and uses scoped send/stop/archive operations. Normal
standalone Workflows keep their existing SDK path. No tenant-controlled native
SDK callback or executable/environment override is exposed. Nested workflows
still fail explicitly in the managed evaluator.

Protocol admission validates ordered request IDs, total and concurrent call
budgets, frame/result sizes, evaluator identity and current owner authority.
Deadlines, cancellation and transport closure abort pending calls and await
cleanup. An initial handshake timeout detects stale evaluator artifacts. Worker
creation subscribes to cancellation immediately after reserving authority; abort
disables that reservation before a delayed host response can admit execution.
Independent worker ownership retains the parent even when cancellation wins
attachment. Finished workers use the existing core single-thread archive
lifecycle after scoped stop and a second parent/worker check.

Managed calls inherit the immutable approved origin profile. Explicit model
selection must match that profile; per-agent profile selection is not exposed
yet. Managed cache identity includes the profile version, so identical model
tuples with different tool/permission policies cannot share a replay identity.
The existing unchanged-prefix replay and structured-result validation are reused.

Verification: 258 Workflows tests, 402 Plugin SDK tests, 75 Plugin Guide tests and
28 selected server security/lifecycle tests pass. A real-database race test
pauses native creation, cancels the request, verifies that authority is disabled
before releasing creation, and admits no new thread. Strict server/SDK/Workflows/
guide typechecks and portable SDK declarations pass, with changed-file lint,
formatting and diff checks.

The actual Docker deployment runs `agent()` through the installed native
Workflows plugin and real Qwen workers for two users. Shell probes verify UID,
HOME and cwd; database checks verify worker ancestry and pinned profile. It
checks structured replies, native cancellation and scoped worker retirement.
Resuming a completed prefix creates no new worker, including after BB restart.
The restart check waits for the builtin plugin to register before invoking its
CLI command. All 63 build/deployment tasks pass. See
`control-plane-phase-30-verification.json`.

Scoped orphan discovery, controller recovery and retries, notifications,
per-agent profile selection, nested workflows, personal job APIs, automations
and schedules remain open. This is an agent-dispatch increment, not completion
of the background stage or the overall goal.

## Thirty-first increment: approved per-agent profiles

Managed workflow source now accepts `agent(prompt, {profileVersionId: "<uuid>"})`.
The version is immutable and must currently be approved for the run's owner.
Omitting the option keeps the originating profile. The selected version supplies
prompt, provider/model/reasoning, permissions, tools and MCP through the existing
canonical worker creation and Qwen policy paths. An explicit model tuple must
match the selected profile. Arbitrary tool/MCP/environment overrides remain
unsupported; standalone workflows reject the managed profile option.

The builtin-only `resolveWorkerProfile` method adopts the saved workflow-run
principal and uses native thread-owner/profile admission. Both parent authority
and selected-profile access are required. Workflows checks selection when
computing cache identity and again after awaiting the preceding replay decision,
before consuming stored results. The selected immutable version contributes to
the managed call cache key and is passed unchanged to worker creation, which
rechecks all grants. The option persists in native call history and traverses the
same isolated JSON bridge as other normalized agent options.

Verification: 260 Workflows tests, 402 Plugin SDK tests, 75 Plugin Guide tests and
29 selected server tests pass. Real-database tests cover foreign parent/profile
IDs, granting and revoking a second profile, and parent-grant loss while the
selected profile remains available. Parser/storage validation rejects malformed
version IDs. Standalone execution rejects the option before spawning a worker.
Strict server/SDK/Workflows/guide typechecks, portable SDK declarations and
changed-file lint/format/diff checks pass.

The actual Docker deployment selects a newer approved profile with an additional
native Qwen tool; the model fixture observes that tool and the native worker is
bound to the exact version. Completed-call replay creates no new thread. The
real administrative CLI disables that selected version; resuming then fails
before replay or worker creation. Re-enabling restores availability. Foreign
versions and conflicting model tuples are denied without creating threads. The
full build/deployment passes all 63 tasks. See
`control-plane-phase-31-verification.json`.

Nested workflows, scoped orphan discovery/recovery, notifications, personal job
APIs, automation/scheduler integration and the other unchecked stages remain
required. This increment does not complete the overall background stage.

## Thirty-second increment: nested workflows in the isolated evaluator

Managed `workflow()` now evaluates one child level inside the existing
registered-UID process. Inline, named `.bb/workflows/<name>.js` and confined
`scriptPath` references use the native source conventions. Child agents call the
same parent controller, immutable profiles and authority graph. The existing
scheduler is shared across VMs, preserving global agent-call and concurrency
limits, causal call order and cancellation. Child arguments/results use the
same bounded JSON/schema validator as the native controller, extracted without
changing standalone validation behavior.

Managed runs separately bound child invocations by `maxAgentCalls` and concurrent
child VMs by `maxConcurrentAgents`; queued launches check cancellation before
source I/O. These are independent ceilings, not extra agent-call charges.
Cancellation is rechecked after VM completion, so a caught abort or `parallel()`
collecting cancelled steps cannot turn the whole run into success. Active nested
cleanup settles before evaluator completion.

The Linux source reader opens the actual cwd, traverses pinned directory file
descriptors through private `/proc/self/fd`, and uses `O_NOFOLLOW` on every
component. Directories require `O_DIRECTORY`; final files must be regular.
`O_NONBLOCK` avoids a FIFO-open wait. Reads are bounded to 512 KiB plus a detection
byte and require valid UTF-8. Lexical traversal, foreign workspace paths and
symlinks are denied without a central SDK or service-UID file reader. This is
source-file confinement, not a general filesystem jail.

Verification: 264 Workflows tests pass, including shared parent/child agent
accounting, nested invocation/VM concurrency limits, schema/depth checks and
cancellation with queued child launches. Strict server/Workflows typechecks and
changed-file lint/format/diff checks pass. Docker uses an owned named workflow
file, dispatches its actual Qwen worker and replays its stored call without a
new thread. It denies traversal into another user's project, symlink files and
directories, oversized/nonregular/invalid-UTF-8 source, Node globals and deeper
nesting. The complete build/deployment passes all 63 tasks. See
`control-plane-phase-32-verification.json`.

Personal job APIs/UI, scoped orphan recovery, retries/notifications, automation
and scheduler integration and the remaining unchecked feature stages are still
required. No completion of the overall background stage is claimed.

## Thirty-third increment: scoped worker discovery and restart recovery

The builtin-only background facade exposes bounded `listWorkers` cursor pages.
The core query joins worker authority, parent workflow-run authority, native
ownership and native threads, checking owner/project/profile/origin consistency.
Current user owner/project access is filtered in SQL before pagination. Trusted
service reconciliation sees registered owners without using the unrestricted
thread SDK. Metadata supplies optional call correlation, never authentication.
Startup includes archived workers to repair interrupted cleanup acknowledgement;
periodic discovery excludes them.

A real plugin SQLite migration adds `workflow_workers.parent_binding_id` and
backfills it from retained runs. New ownership and discovery save this reference
before attachment and preserve it across run-history pruning. Scoped stop/archive
can therefore complete after the run row is gone. Physically deleted native
threads return 404 metadata and idempotent cleanup after parent admission;
existing foreign workers remain denied. Existing cleanup retry/backoff is reused.

Verification: 267 Workflows tests, 402 Plugin SDK tests, 75 Plugin Guide tests and
30 selected server tests pass. Tests cover source-filtered two-user cursor
pagination, optional metadata correlation, archived inclusion, native deletion,
migration backfill and cleanup after pruning without a global SDK fallback.
Strict server/SDK/Workflows/Guide typechecks, portable SDK declarations and
changed-file lint/format/diff checks pass.

Docker starts a real workflow with a completed prefix and a pending Qwen worker,
then restarts BB. The first call replays in the same run and the interrupted call
completes through a different worker attempt. An offline private fixture creates
registered workers with absent run history, including one already archived before
acknowledgement; startup discovers and retires them. The earlier ancestry fixture
now creates corresponding native call rows/metadata so valid active workers are
not mistaken for orphans. All 63 build/deployment tasks pass. See
`control-plane-phase-33-verification.json`.

This proves graceful restart and registered-worker reconciliation. Abrupt-crash
recovery, the remaining provider retry cases, notifications, legacy unassigned
jobs, personal background APIs/UI, automations and schedules remain required.
Interrupted side effects may execute again; no exactly-once or overall background
stage completion is claimed.

## Thirty-fourth increment: workflow recovery after abrupt parent death

The Docker acceptance scenario now starts pending workflow agents for two users
before killing the shared BB server with `SIGKILL`. Both workflows already have
a reusable successful prefix. The process supervisor inspection captures the
UID-isolated workflow evaluator processes as well as actual Qwen processes,
namespace leases and daemon descendants, and verifies that none remain alive
under the captured PID/start identities before BB restarts.

While the server is offline, a private fixture uses the existing profile-access
primitive to revoke one owner's profile. After restart that run fails authority
admission without a new worker binding. The other owner's run replays its first
call in the same run and completes its pending call through a different native
worker. Old attempts are disabled and archived for both owners, including the
owner whose execution profile is no longer granted. The fixture restores the
grant after the assertions. No browser token is used to restore either job.

Verification: strict server typecheck and changed-file lint/format/diff checks
pass. The full real-fork Docker build/deployment passes all 63 tasks, including
all earlier checks and the new crash/current-grant scenario. Existing production
recovery and supervisor paths satisfy these checks without a production policy
change. Unit suites are not rerun for this fixture-only increment. See
`control-plane-phase-34-verification.json`.

The expanded default deployment check has a 240-second inner deadline and a
270-second outer container watchdog; browser-mode deadlines remain unchanged.
This accommodates the additional two-user process/crash/recovery transitions,
without changing execution deadlines or namespace/security restrictions.
Provider retry/correction cases, notifications, personal background APIs/UI,
legacy assignments, automations and schedules remain open. Pending side effects
can execute again; successful-prefix replay is not an exactly-once guarantee.

## Thirty-fifth increment: authoritative failures and bounded structured repair

Managed worker polling now reads the canonical terminal error and nullable
completion sequence through the scoped facade. It compares the latest
system-error/turn-completion sequences so stale failures do not hide a fresh
error, includes bounded provider detail and preserves failed/interrupted
completions even when native status is idle. The existing core error-message
reader shares the same extraction. No daemon wire field or public worker API is
added.

The managed controller consumes idle completions monotonically once and ignores
generic global idle/failed callbacks. It no longer spends multiple structured
repair turns on the same idle snapshot. Explicit interruption, authorization,
permanent HTTP status, unknown-model/unsupported-setting and exhausted
structured-output failures take precedence over transient wording or flags.
Qualifying transient failures use the existing durable retry/backoff counter and
fresh scoped workers; all creation/turn operations retain current-grant checks.
Structured fallback repairs reuse the same worker and session, with at most two
corrective turns.

Verification: 268 Workflows tests, 402 Plugin SDK tests, 75 Plugin Guide tests and
30 selected server tests pass. Real database checks verify owning error detail,
newer completion vs newer system error, idle completion cursors and foreign
rejection. Classification tests reject mixed auth/transient messages, permanent
status with a retry flag, and explicit interruption. Strict server/SDK/Workflows/
Guide typechecks, portable declarations and changed-file lint/format/diff checks
pass.

Docker injects an SSE failure after opening a response stream and verifies one
external retry with a different worker. An HTTP 401 with mixed unavailable
wording creates no retry. A bad structured response is repaired once in the same
worker; persistent invalid output consumes two corrective turns and fails
without provider retries. The completed full build/deployment passes all 63
tasks, including earlier isolation/restart/crash/revocation checks. See
`control-plane-phase-35-verification.json`.

The tested stock Qwen internally keeps retrying some headless HTTP 503 failures;
that is separate from external workflow retries. The acceptance fault does not
pretend to exhaust that internal capacity loop. Corporate-fork behavior,
remaining retry/revocation combinations, notifications, personal background
APIs/UI, legacy assignments, automations and schedules remain required. Pending
side effects may repeat; no overall background-stage completion is claimed.

## Thirty-sixth increment: cancellation/revocation between attempts and commit-time admission

Canonical native message submission now rechecks managed execution authority in
its write transaction after transaction preflight and before appending a client
request or producing outbound queue effects. Waiting-message creation and
explicit queue admission also check authority in their creation transactions.
This closes the gap between an earlier authorization check, asynchronous
preparation and actual message/queue persistence. Core UI/CLI/SDK and scoped
workflow corrections share these paths; no plugin-only sending implementation is
added. Ordinary unmanaged behavior remains covered by regression tests.

Verification: 33 selected server security/lifecycle tests pass, including three
real-SQLite commit/queue tests. A transaction preflight revokes a profile and
submission rejects before events or the outbound callback; rollback preserves
atomicity. A table-driven contract checks both waiting and explicit queue paths
after prior admission loses its grant. Another 200 core/public send, queue,
context-clear, edit, hook, dispatch and drain regressions pass. Strict server
typecheck and changed-file lint/format/diff checks pass.

Docker waits for the second provider-retry backoff before cancelling one run and
revoking the execution profile of another. Both terminate without a third
worker, including after the four-second backoff window has elapsed and the
profile grant has been restored. Repeated stream failures stop at three native
workers and two external retries. Every failed/cancelled attempt is disabled and
archived. The full build/deployment passes all 63 tasks, retaining prior
correction, identity, restart and crash checks. See
`control-plane-phase-36-verification.json`.

The exhaustion scenario explicitly waits up to 60 seconds because three stock
Qwen attempts include harness-internal retry delays. Default/outer deployment
watchdogs are 360/390 seconds; browser-mode uses 390/420 seconds. These are test
budgets, not production execution or retry-policy changes. Commit-time
correction/message denial is verified at the real core transaction boundary;
the Docker backoff scenarios verify live external cancellation/revocation.
Notifications, personal background APIs/UI, legacy assignment, automation and
scheduler integration and the remaining ownership/recovery audit stay open.

The expanded real-fork run measured almost five minutes, so its watchdog leaves
an extra minute of headroom. The `/proc` identity checker handles both `ENOENT`
and `ESRCH` as a vanished process while preserving all other error checks. Touched
core files had pre-existing comments forbidden by the repository lint rule;
these were removed. A TypeScript syntax-tree comparison verifies that the only
semantic edits are the intended guards and the exported canonical test boundary.

## Thirty-seventh increment: scoped workflow completion notifications

Managed Workflows use a first-party `notifyOrigin` adapter instead of discarding
all completion notices. Core derives the origin from the saved run binding,
checks current job/source and origin-profile authority, adopts the owner and
uses the canonical native message submission. No target thread, UID, HOME or
profile override is accepted. The native message remains agent-only.

Generated migration 0155 adds one central acceptance receipt per run binding.
It commits in the same transaction as the native client request. An append
failure rolls it back; a repeated call after lost acknowledgement returns the
existing acceptance without another event. Checks occur before acceptance and
again in the write transaction. Receipt retention is independent of plugin run
history. This guarantees request acceptance deduplication, not exactly-once
provider execution or external side effects.

The plugin marks unauthorized/unavailable notices abandoned. Transient
preparation failures retain its persisted retry/backoff behavior; managed errors
do not fall through to unrestricted SDK thread access. Cancellation disables
authority and prevents a late notification from starting an origin turn.

Verification includes real-SQLite rollback/deduplication/authority contracts,
managed adapter outcomes and transient restart tests, strict typechecks, SDK and
Plugin Guide suites. Docker checks Alice/Bob ownership and agent-only notices,
revoked/cancelled delivery rejection and replay after an offline injection of a
lost plugin acknowledgement. See `control-plane-phase-37-verification.json` for
completed checks. Personal background APIs/UI, automation/scheduler integration,
legacy assignment and the remaining recovery/ownership audit stay open.

The first real deployment exposed a native bridge lifecycle race: while a worker
bridge was initializing without a registered session, an origin-notification
resume with a different bridge/skill hash retired it as idle and sent SIGTERM.
The runtime now retains each bridge key throughout start, resume and staged
rewind construction. Stale cleanup skips both initialization and construction
reservations, releasing obsolete idle processes after the last reservation.
Three real-process tests cover blocked initialization, reference-counted
idempotent release and a reservation acquired while stale cleanup awaits
another process; the existing process/recovery/lifecycle
regression suites remain required. No daemon wire fields change.

Final verification passes 30 server security/plugin-lifecycle, 272 Workflows,
402 Plugin SDK, 75 Plugin Guide and 89 runtime process/recovery/lifecycle tests
(868 total). Strict typechecks, changed-file lint/format and diff checks pass.
The final source builds and deploys in Docker with all 63 tasks successful in
5 minutes 35 seconds, including both users' notices, cancellation/revocation
rejection, crash recovery and the injected acknowledgement-loss replay.

## Thirty-eighth increment: personal workflow run API, SDK and CLI

Personal clients can start an inline workflow in an owned origin thread, list
personal runs, read status/result/paginated history and cancel through
`/control-plane/user/workflows`. The SDK's `workflows` client and
`bb server access workflows` use this limited API. CLI source comes from
`--script`, `--script-stdin` or a local `--file`; optional arguments and terminal
run replay use native Workflows validation and controller behavior.

Core authenticates requests and selects owner/project bindings before list
pagination. Shared project access is insufficient to see another owner's runs.
It derives project/execution context from the origin, checks central identity
again after plugin calls and exposes only fixed builtin RPC operations. The
adapter requires enabled, unremoved builtin provenance and the actual builtin
source/name. General BB/plugin RPC stays administrative. Native Workflows
continues to own its SQLite history and run lifecycle; no duplicate run store or
browser credential is introduced.

Source is bounded to 512 KiB of UTF-8. Arguments are plain JSON bounded to 128 KiB,
32 levels and 10,000 values, checked iteratively before recursive native parsing.
Owner/project/environment/launcher overrides are rejected. Cancellation is
available after profile loss while current project access remains; execution
still requires current grants. Central list cursors can traverse pruned native
history without exposing foreign IDs. History has an exclusive numeric call
cursor, and result responses distinguish unavailable from a JSON null value.

Verification uses the actual native service/RPC handlers and real central/native
SQLite through the limited SDK, including foreign IDs/resume/stop, shared project
membership, grant loss, disabled users and forbidden raw RPC. Its plugin fixture
is bundled at the package boundary and uses the built public SDK; server
TypeScript does not import private plugin sources across root directories.
CLI/SDK/domain and native Workflow suites cover transport and input contracts.
Docker exercises two personal credentials, real selected-profile Qwen workers,
replay, pagination, result/history and cancellation. Completed checks are in
`control-plane-phase-38-verification.json`.

Saved definitions, workflow UI, dedicated progress subscriptions, automations,
schedules, legacy assignment and the remaining execution/recovery audit remain
required before the overall background stage can be marked complete.

The workflow input middleware uses the verified Hono `/workflows/*` pattern,
which covers the root and nested routes. A 4 MiB HTTP envelope leaves space for
JSON escaping while preserving the tighter source/argument limits. A streamed
over-limit request is rejected before binding/native persistence. The actual
client/deployment case also uploads an escaped source and arguments whose HTTP
body exceeds 1 MiB while each value remains within its declared bound. Existing
control-plane input boundaries still require the corresponding root/nested and
streaming audit; this increment does not claim that broader audit complete.

Final verification passes 12 server security/native-plugin-boundary tests,
272 Workflows tests, nine limited-SDK tests, five CLI tests and one bounded-input
contract (299 total). Strict server/CLI/SDK/domain/plugin types and changed-file
lint/format/diff checks pass. The final Docker build/deployment passes all 63
tasks in 6 minutes 12 seconds, including the escaped HTTP envelope and personal
API cancellation of actual running Qwen workers. No full-repository or overall
background-stage completion is claimed.

## Thirty-ninth increment: control-plane body-consuming input boundaries

Administrative profile budgets/guards and personal-thread middleware used the
Hono `/base*` pattern, which did not cover the intended root and nested routes.
They now use `/base/*`. A shared bounded JSON/form reader propagates stream-size
errors before schema parsing, database writes, session issuance or cancellation.
JSON syntax remains a 400 response. Form parsing preserves its original
Content-Type after the bounded read, including ordinary URL-encoded browser
forms, and rejects duplicate fields rather than choosing a value.

All existing body budgets remain unchanged. Both logout endpoints now have a
1 KiB budget; thread/workflow stop and both logouts reject action fields while
accepting an empty body or optional `{}`. The certificate browser-login body
remains strictly empty. Administrative profile module guards also deny a user
principal at root/nested entry points independently of the outer access gate.

The first real-network matrix observed `socket hang up` on a request following an
early oversized-body rejection. The common rejection response now emits JSON
HTTP 413 with `Connection: close`. No client retry or exemption is added. The
normal keep-alive client remains in the Docker matrix and requires HTTP 413,
not a generic connection failure, for every oversized input.

Verification uses real migrated SQLite and root/nested Content-Length/streamed
requests, including valid payloads padded beyond the budget. It asserts that
no profiles, grants, projects, threads, jobs or sessions change. Docker additionally
uses actual client certificates for approval/browser-login bodies, verifies an
oversized exchange does not consume its approved flow, rejects duplicate form
fields and performs valid login/exchange/logout afterwards. Completed evidence
is recorded in `control-plane-phase-39-verification.json`.

This closes the enumerated body-consuming control-plane boundaries. Query/other
request metadata, native BB/daemon admission, personal workflow definitions/UI,
automations, schedules, legacy assignment and remaining recovery checks are
still separate required work. No overall multi-user/background completion is
claimed.

Final verification passes 16 server tests across access, certificate auth,
profiles, threads, workflows and browser context/UI, including the real-SQLite
32-case body-budget matrix and direct profile-module role guards. Strict server
types and changed-file lint/format/diff checks pass. The final Docker build and
deployment pass all 63 tasks in 5 minutes 44 seconds. Its 42 oversized-body probes
require HTTP 413 using the normal keep-alive client and preserve the saved state;
normal certificate approval, login/exchange and the existing actual Qwen,
workflow/restart/crash checks also pass.

## Fortieth increment: personal workflow run workspace

The personal native workspace now has a **Workflows** view in the main content
area, keeping the left project/thread navigation. It uses the existing limited
SDK for personal project runs and pagination, status/phase/errors, JSON result,
paginated agent calls with retry/repair counts, cancellation, inline source/JSON
start and terminal replay. Execution uses the selected owned conversation;
project/read-only views can inspect runs without displaying execution controls.
Replay submits explicit source/arguments to the normal native replay controller.
No new privileged API, persistence table or plugin frontend is introduced.

The authorized project/conversation URL accepts `?view=workflows`; reload keeps
the view and a run can be selected again. Polling refreshes every two seconds
while active. Query keys separate projects/runs; components reset selected run,
source and argument drafts when changing the project/conversation or leaving the
view. A failed read hides cached run/result/history content. Existing bootstrap
and project-access failures unmount the screen. Result JSON is rendered as text,
including an available JSON null. Stop/start failures are explicit and do not
pretend that a requested action succeeded.

The existing personal API, SDK and `bb server access workflows` commands remain
the canonical non-UI surfaces. Saved workflow definitions, dedicated progress
subscriptions, automations/schedules, legacy assignment and the broader execution
and recovery audit remain open. This increment does not complete the composite
background stage.

The real browser deployment also exposed an early-close race in the preceding
body-boundary increment: closing the rejected connection while a 4 MiB upload is
still being written can produce a reset before the client receives HTTP 413.
The common middleware now buffers accepted input only to the existing route cap
and drains rejected input before closing, with an 8 MiB budget and a 500 ms
deadline, cancelling unfinished streams. No oversized bytes reach parsing or
action dispatch. A real TCP regression repeats large Content-Length/chunked
uploads followed by valid requests; stalled/endless stream tests verify bounded
cleanup. The Docker matrix still requires complete HTTP 413 responses and
unchanged persisted state, without retries or accepting a reset as success.

Final verification passes 29 personal UI tests and 18 server security/real-TCP
checks, strict app/server types and changed-file lint/format/diff checks. The
final production Docker/Chrome deployment passes all 63 tasks in 6 minutes
11 seconds, including both certificate users' actual Qwen workflow start,
result/history, replay, pagination after reload, cancellation, foreign-run
read/stop denials, ordinary conversation UI/logout and native restart recovery.
The browser uses isolated temporary certificate contexts outside the host
execution sandbox, which otherwise aborts Chrome before opening a page. The
Docker runtime keeps its original UID, namespaces, readonly mounts and seccomp
constraints. Results are recorded in `control-plane-phase-40-verification.json`.

## Forty-first increment: managed personal workflow definitions

Builtin Workflows gains native definition heads and immutable source/default
argument revisions. A definition's owner/project/origin/profile authority is
stable; native code revisions are separate from that central authority revision.
Saving edits uses an expected revision and one native SQLite transaction.
A conflicting edit does not overwrite content. Exact-revision runs copy saved
source/defaults, optionally overriding arguments, through the normal native
controller and attach the definition binding as their source ancestor. Editing
never substitutes new code into an existing run.

Central authority is reserved before native insertion. A failed insert rolls
back native writes and retires the reservation; a crash-created orphan without
native content cannot run or expose source. Disable/delete modify the central
fence directly, without duplicating mutable enabled/deleted state across two
stores. Existing evaluator/worker/retry guards observe that source ancestry.
Version/run records remain stored; stopping authority does not undo external
side effects. Current project access permits read/disable/delete after profile
loss; saving, executing and re-enabling require current execution grants.

The limited `/control-plane/user/workflow-definitions` API,
`workflows.definitions` SDK, `bb server access workflows definitions` commands
and personal workflow workspace share the same fixed builtin RPC/controller
path. Lists filter central ownership before pagination and return metadata;
get reads source/defaults at a requested or current revision. User calls cannot
choose owner/project/profile/UID/HOME/cwd. Shared project membership does not
expose another user's personal definition. The UI preserves the loaded editing
revision during enable/disable, preventing stale drafts from accidentally
adopting a concurrent version. Project/conversation changes dispose source-load
callbacks. File-based workflow names remain a separate interface.

The Docker fixture adds two-user definition lifecycle, exact/default/null
arguments, source-disable termination of an actual registered-UID evaluator,
foreign-ID denial and owner/version/enabled recovery after restart. Browser
checks add actual Qwen through a saved definition, source editing, loaded-version
execution, reload, enable/disable/delete and foreign requests while it exists.
Overall watchdogs grow with these additional cases (420/450 seconds for normal
inner/outer checks, 480/510 for browser); individual operation waits and kernel
isolation are unchanged. The image includes the new portable verification
module. Administrative definition UX, legacy assignments, automations/schedules
and the broader admission/recovery audit remain unfinished.

Replay of a definition-derived run inherits its stable source binding, including
when requested through the ordinary inline workflow start/resume API. It cannot
strip or replace that ancestry to reuse a disabled/deleted definition's cached
prefix. The previous run may be terminal/cancelled; its saved source authority
still has to permit the new execution. Creating a separate new inline run remains
subject to the ordinary current profile/project permissions.

Administrators can use the authenticated native SDK `plugins.callRpc` or
`bb plugin rpc call workflows <method> --input-file <json-path> --json` for these
same handlers. `controlPlaneDefinitionInventory` accepts
`{"cursor":null,"limit":50}` and optional `projectId`, returns summaries with
`ownerUserId` and `nextCursor`, and respects a user principal if invoked under one.
`controlPlaneDefinitionGet` takes `id` and optional `revision`;
`controlPlaneDefinitionRun` takes `id`, exact `revision` and optional `args`.
Enabled/update/remove handlers use the corresponding ID-based contracts above.
Raw native RPC requires administrative access; personal clients use the limited
API. Administrative run dispatch adopts the saved owner and rechecks that user's
profile/project/source grants. It cannot bypass a disabled source. A logged-out
user's API token remains rejected while an authorized administrative dispatch can
run the still-enabled saved job under that user. Dedicated administrative
definition UI and legacy assignment remain later work.

Final verification passes 273 native Workflow tests, 33 personal UI tests,
18 server security/real-SQLite/TCP tests, two CLI workflow tests and one each for
the limited SDK and bounded domain input (328 total). The native insertion fault
is injected after its head write and rolls back both tables; a separately seeded
reservation-only state cannot read/execute content or allocate a derived run,
and sparse pagination still reaches valid definitions. Both disabled and deleted
source authority prevent ordinary inline resume while authorized historical
results remain readable.

Strict app/server/CLI/SDK/plugin types and changed-file lint/format/diff checks
pass. Production browser Docker passes all 63 tasks in 7 minutes 9 seconds;
normal `--network none` Docker passes all 63 in 5 minutes 58 seconds. The latter
verifies real Qwen shell UID/HOME/cwd, source-disable termination and disappearance
of the command processes; a read-only SQLite check also confirms that its worker
row exists and is archived. Final image rebuild includes the stricter explicit
row-existence assertion and current guides. Administrative native inventory
shows both owners, Bob's revoked credential stays rejected, and administrative
run dispatch adopts Bob's saved authority after logout. Completed evidence is
in `control-plane-phase-41-verification.json`; the overall goal remains open.

## Forty-second increment: native administrative definition management

The builtin Workflows plugin registers a native navigation panel at
`/plugins/workflows/definitions` in full administrative BB. It lists owner UUIDs,
projects and revisions with project filtering and cursor pagination, creates
from a server-authorized project/origin, loads historical/current content,
saves a new revision, runs the loaded saved revision/defaults, and controls
central enabled/deleted authority. The panel shares the existing native
`controlPlaneDefinition*` RPC contract, SDK `plugins.callRpc` and
`bb plugin rpc call workflows ...` surface. No alternate executor, new database
migration, daemon wire or public Plugin SDK member is introduced.

The loaded editing revision remains the compare-and-swap expectation across
enable/disable. Run deliberately excludes unsaved editor source/arguments and
requires the explicit saved revision. Refresh errors remove cached metadata and
the editor; source reads are fenced after unmount. An unconfigured ordinary BB
reports missing managed authority without offering an active editor. Personal
clients retain their limited API and cannot load this native plugin frontend.
Administrative execution still adopts the saved owner and rechecks source,
project and profile grants; disabling a source denies administrative run too.

Verification and the stage commit are recorded in
`control-plane-phase-42-verification.json`. Automations, schedules, legacy
assignment and the broader admission/recovery audit remain open.

Stage verification passes all 277 native Workflows tests (17 files, including
four new panel scenarios), strict plugin types, changed-file lint with no new
errors, formatting and diff checks. Real Chrome first exposed the full BB
onboarding gate and a nested-textarea accessible-label mismatch; the fixture now
uses the existing Skip setup action when present, and the product uses separate
explicit labels. The browser watchdog grows to 540/570 seconds for the additional
administrative cases; individual operation waits remain unchanged.

The production browser Docker deployment passes all 63 tasks in 7 minutes
20 seconds with zero uncaught page errors. Administrative CRUD for Alice/Bob,
historical/default-argument execution and actual SQLite owner bindings, stale
CAS denial, disabled-source denial, reload and logout revocation all pass.
Existing personal Qwen conversations, definition execution, foreign-ID denial,
namespace/UID checks and recovery scenarios remain passing. This frontend
increment uses that complete browser deployment; a second standalone normal
network-none deployment was not repeated. The feature list remains open beyond
this completed administrative-definition UI increment.

## Forty-third increment: native automation agent authority

The builtin automation controller now records owner/source authority and native
immutable definition versions, captures execution with run claims, and uses
kernel `automation-worker` creation for manual and cron/once agent dispatch.
The native SDK/RPC/CLI/UI management path shares this controller. User-principal
native metadata/mutations/history are owner-scoped even for shared projects;
administrative native calls derive the owner from a managed project/origin.
An unowned legacy record cannot fall back to shared-service execution.

Explicit pause fences descendant workers. Provider/model/reasoning/permission
must match the origin's approved pinned profile. Arbitrary host/worktree,
target-thread reuse, service-tier and managed script modes reject before
execution. The limited personal automation API/UI and isolated shell runtime
remain later work. This is the agent execution/ownership increment, not the
completion of the composite background stage.

Native idle runtime release is shared with core and preserves owned history,
Qwen session IDs and binding authority. A newer active turn is retained,
including in another environment. Host protocol 253 records that semantic
change. No central schema migration is needed for the added worker enum value;
Drizzle generation confirms no SQL change. Plugin SQLite appends its own
three-table migration using the existing storage API.

Verification is recorded in `control-plane-phase-43-verification.json` after
tests and real Docker checks complete. The overall feature list remains open.

The Docker investigation exposed retained completed Qwen runtimes and an OOM
kill in the constrained test VM. Completed-run cleanup now records the observed
sequence and actual release acknowledgement; it retries a still-idle release
and retains a new interactive turn. The acceptance check waits for that
acknowledgement, continues the same owned Qwen session, and checks both its ID
and previous model context. Source pause checks that actual command PIDs exit.
A separate shutdown race claimed a once job after daemon shutdown had begun.
Core now quiesces all background services before stopping that daemon, keeping
SDK cleanup live and preventing late service activation/restart. Unit coverage
checks simultaneous abort and still-live storage; the real offline due-time
case verifies recovery without consuming the job during shutdown.

All selected checks pass: 277 Workflows tests, 143 Automations tests, 27 server
security/lifecycle tests, 19 database tests, 40 daemon dispatch tests and eight
SDK public-type tests (514 total). Strict server/daemon/SDK/DB/Automations/Plugin
Guide types pass. The full default Docker deployment passes all 63 tasks in
7 minutes 14 seconds, including two real registered-UID Qwen actors, concurrent
once schedules, idempotency, process termination, checkpoint/history continuity
and an offline once schedule after restart. This increment did not add personal
automation API/UI or script execution, and did not rerun browser acceptance;
the composite stage and broader admission/recovery audit remain open.

## Forty-fourth increment: personal automation read API

Personal credentials now reach only fixed GET routes for automation list,
metadata and paginated run history. The server checks central owner/current
project access before native plugin access, carries the user principal into the
builtin controller, validates reply identities and rechecks access afterwards.
The plugin must retain builtin provenance and be enabled. No plugin ID, owner,
execution configuration, path or credential is accepted from this interface.

The SDK `automations.list/get/history` and `bb server access automations`
commands share this API. List pagination uses central binding cursors; history
uses native opaque run cursors. Both are bounded and owner-scoped at the data
source. Metadata and run projections strip execution settings, prompts, output
and private native fields. Thread IDs link to the existing owned conversation
API. Bounded native batch reads omit reserved roots without definitions while
advancing binding cursors; direct metadata reads of incomplete definitions return 404. Unauthenticated reads reject; foreign IDs remain opaque, shared-project
membership does not expose another owner's records, and unknown/mutation/native
RPC routes remain closed. Responses disable caching.

This read increment does not complete personal automation creation, editing,
manual dispatch, cancellation or UI. Isolated scripts, legacy assignment and
the broader background admission/recovery audit remain required. Verification
will be recorded in `control-plane-phase-44-verification.json` after focused
checks and the full Docker deployment.

Verification: 143 native Automations tests, six server security tests and one
SDK and CLI test each pass (151 selected tests). Strict server/SDK/CLI/plugin
types, changed-file lint and formatting pass. The full normal Docker deployment
passes all 63 tasks in 7 minutes 9 seconds, including actual two-user Qwen jobs,
owner-filtered CLI reads, empty-page cursor traversal over an incomplete reserved
root, foreign-ID/override denials and restart/crash recovery. Alice retains
personal read access after restart; Bob's deliberately revoked credential still
returns 401 while his saved offline schedule executes under his registered UID.

The initial full run exposed the incomplete native-definition case. Bounded
native batch reads fix that case without deleting registry evidence or loading
all definitions. A second run caught the fixture's attempt to use a credential
that an existing logout scenario had intentionally revoked; the final fixture
preserves that revocation and asserts denial. Temporary diagnostics were not
shipped. `control-plane-phase-44-verification.json` records the full deployment
proof and remaining scope. Browser acceptance was not rerun for this read API
increment; personal automation mutations/UI and the composite stage remain open.

## Forty-fifth increment: personal automation management

Limited API/SDK/CLI operations now create and edit agent definitions, read
editable prompt/revision details, pause/resume, run idempotently, stop one run
and delete an owned source. Creation derives all execution identity/profile
settings from an owned approved origin; no caller-supplied UID, HOME, cwd,
provider/model/tools/MCP or environment fields are accepted. Metadata list/get
keep their existing field shape; definition detail and mutation responses carry
revision information. Expected native revisions protect personal edits, and
configuration/version rows commit atomically through the same native controller.

A run stop persists cancellation intent before cleanup. Acknowledgement follows
fencing and process stop; unfinished cleanup remains running, blocks another
single-flight run and is retried by reconciliation after controller restart.
A separate cancelled terminal state preserves the source schedule and failure
budget, with native history/status presentation. Stop during worker attachment
returns 409; source pause remains the fence for pending dispatch. This does not
complete the full background admission/cancellation/crash audit.

The Docker acceptance scenario creates/edits/pause-resumes/manual-runs through
both users' limited CLI, checks native immutable prompt versions and rejects
foreign writes and stale revisions. It also checks individual cancellation of
actual registered-UID commands while the other user's command survives, source
deletion cleanup, bounded JSON input and the existing schedule/restart/crash
scenarios. Verification passed: 156 selected tests, strict types across four
packages, changed-file lint and formatting, and all 63 normal Docker deployment
tasks in 7 minutes 27 seconds. A two-barrier regression covers cancellation
arriving during failed-provider cleanup; removing the final intent recheck makes
that regression fail. Real SQLite controller restart retries pending cancellation.
The Docker fixture waits for both parsed command proof and process discovery to
avoid observing a PID before its proof file is written.

`control-plane-phase-45-verification.json` records the deployment proof and
limits. Browser acceptance was not rerun. Personal automation UI, managed
scripts, legacy assignment and the remaining feature sequence stay open.

## Forty-sixth increment: personal automation workspace

The protected personal BB application now opens Automations alongside Workflows
in the main workspace, retaining the native project/thread sidebar. Selection is
stored in the URL and reloads through owner-scoped definition/history reads.
Creation takes its approved agent profile from the current conversation. Once
schedules use browser-local date/time input; recurring schedules store an
explicit cron expression and timezone. The editor keeps its original revision
and unsaved draft across polling and conflicts. Reloading saved automation is
an explicit discard/rebase operation.

The section supports pause/resume, idempotent manual dispatch, paginated history,
individual stop, conversation navigation and confirmed deletion. Cleanup controls
remain available without execution permission; creation, edits, resume and new
runs do not. Access errors hide cached prompts, history and controls. Project
changes abort mutation requests and fence late callbacks; unacknowledged manual
run retries retain their idempotency key while the section remains mounted.

This increment uses the phase-45 API/SDK/CLI without new native plugin APIs,
central/native migrations or daemon protocol changes. Verification and limits
are recorded in `control-plane-phase-46-verification.json`. Dedicated change
subscriptions, managed scripts, legacy assignment and the broader background
admission/recovery audit remain open.

Verification passes 27 personal UI tests, strict app types (five Turbo tasks),
changed-file lint/formatting and all 63 Docker/browser deployment tasks in
8 minutes 57 seconds. Chrome 155 uses separate certificate contexts for both
owners. Each creates and revises a schedule, pause-resumes, runs actual Qwen
commands under the registered UID/HOME/cwd, reloads the selected definition,
opens the worker conversation, stops an actual hanging command and confirms
deletion. Foreign reads and mutations return 404. Existing administrative,
workflow, logout, restart and actual crash-recovery cases also pass.

The browser checks caught implicit labels including select-option text and a
saved textarea value after reload; explicit useId/htmlFor associations fix both
while retaining exact label checks. Reload now fetches fresh server state before
replacing the draft. The wrapping toolbar passes a 390-pixel layout check; desktop
and narrow screenshots were visually inspected. This is not a complete mobile
interaction audit. No test watchdog was increased or workflow scenario skipped.
The image personal bundle matches the locally built artifact byte for byte.

## Forty-seventh increment: background execution inventory

[The background inventory](control-plane-background-inventory.md) maps native and
central persistence, public/personal/native/plugin entry points, workers,
queue/retry wakeups, generic plugin cron/services, notifications, daemon/tool
callbacks and actual code-execution identities. Generic plugin cron rows have no
personal owner field and callbacks run in explicit service scope. Queue rows
carry thread references and execution state; owner authority is resolved through
the thread, not through an independent queue owner field. These are distinct from
owned native automation/workflow definitions and their central source bindings.

Managed script automation remains rejected. The standalone runner can use
service-side interpreter/environment/storage facilities and is not an acceptable
fallback for tenant code. The inventory records the next runtime's launcher,
bounded input/output, durable process/cancel identity, grant/restart and cleanup
acceptance requirements before exposing it in the limited API/SDK/CLI/UI.

This is an inventory/documentation stage, with no runtime behavior, schema or
protocol changes. Only the inventory checklist item closes; the composite
background stage, isolated script runtime, machine RPC, queue/retry and broader
role/source propagation audit remain open. Verification passes 15 existing
real-SQLite security tests across five files (10 Turbo tasks) and all 63 normal
Docker deployment tasks in 7 minutes 24 seconds. All 47 inventory source links,
formatting and diff checks pass. The deployment retains the managed-script
rejection, actual two-owner jobs, schedules, restart and crash scenarios.
`control-plane-phase-47-verification.json` records the complete proof. No new
runtime tests or typecheck pass were needed for this documentation-only stage;
browser acceptance remains the phase-46 baseline.
