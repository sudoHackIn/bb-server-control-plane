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
- [ ] Add our limited public API for projects, thread start/send/stop/status/result/events and model/agent selection. A user token never grants access to the full BB API.
- [ ] Bind thread ownership before provisioning; enforce project, source-thread, parent-thread and environment grants. Select UID/HOME/cwd from the registry.
- [ ] Filter lists, search, bootstrap data and events at their data sources; verify subscription ownership and access revocation.
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
- [ ] Scope list/search/get, create/edit/delete, enable/disable, manual run/cancel and resume/replay operations to the authenticated user. Apply the same rules to the UI, API, CLI and plugin RPC. Administrators retain full visibility and management.
- [ ] At each actual start, retry, resume and scheduled execution, resolve the saved owner and recheck current project/profile/provider/model/tools/MCP permissions. Select UID/GID, HOME and project cwd from the registry. Never inherit the scheduler's administrative privileges or persist a browser token as the job's authority. Missing or revoked authority must prevent execution with an explicit status.
- [ ] Propagate verified ownership and execution context to every child/worker thread and nested workflow. Scope history, results, artifacts, logs, event subscriptions and notifications. Cached/replayed results must remain subject to the same access checks.
- [ ] Persist timezone, next execution, enabled/status state and restart recovery with their owner. Define concurrency, duplicate-trigger and retry behavior per job; do not assume workflow replay provides exactly-once side effects. A valid saved job may outlive a browser token, but not revoked execution permissions.
- [ ] Migrate existing unowned objects explicitly: assign an owner through an administrative migration or disable execution until assigned. Never treat an absent owner as public access or administrative authority.

### Required acceptance checks

- [ ] Alice and Bob can independently create and manage their workflows, automations and schedules; each sees only authorized personal objects. An administrator can inspect and manage both.
- [ ] Foreign IDs, forged owner/parent IDs, shared project membership and direct API/CLI/plugin RPC calls cannot bypass ownership checks or subscribe to another user's events/results.
- [ ] Concurrent scheduled jobs for different users run with the correct actual UID/GID, HOME and project cwd; child threads and workflow workers preserve that context.
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
docker run --rm -i \
  --mount type=volume,src=bb-control-plane-data,dst=/srv/bb \
  --entrypoint node bb-control-plane:local configure.mjs \
  --data-dir /srv/bb --origin https://agents.example.com --login operator \
  < /secure/admin-password
docker run --detach --name bb-control-plane \
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
