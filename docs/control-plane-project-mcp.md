# Project MCP configuration

Increments 61–62 provide centrally approved connectors, per-user grants,
project connection records, encrypted personal credentials and server-owned
remote tool execution through native Qwen. Connections default to disabled.
Owners may explicitly activate with `enabled:true` when their current credential
matches the connector revision. Active records report `executionState:"enabled"`;
connection lists report `executionSupported:true`. These flags describe enabled
configuration, not a successful remote authentication probe. Project UI and actual
shared-project workspace execution remain required for the complete feature.

## Stored authority and contracts

Migration 0157 creates separate connector, access, credential and connection
tables in the shared BB SQLite database. Connectors accept a fixed
streamable-HTTP/bearer descriptor with slug, name and an approved endpoint. No
shell command, arbitrary transport, credential-bearing URL, query or fragment is
accepted. HTTPS is required except literal HTTP loopback for tests. This catalog
is configuration, not evidence that an upstream corporate SDK supports a given
transport.

Administrative connector changes use revision CAS and advance the revision.
Personal credentials and project connections pin the connector revision. A change
does not silently send a previously saved credential to a new endpoint. Current
user and connector grants are checked when saving a credential and again after
asynchronous key access before the database write. Project configuration requires
the current `owner` role; readers may inspect shared-project metadata but cannot
change it. Each reader's readiness uses only that reader's credential binding.
Project and connector revocation are reflected in subsequent requests.

Credential writes and revocation use CAS. Revocation retains a revision tombstone
rather than resetting to zero; a stale tab cannot replace or delete a newer token.
Project configuration changes and removal also require the current revision.
Unknown fields, identity overrides, arbitrary parameters and query fields are
rejected. Catalog lists use exclusive UUID cursors and a 1–100 item limit.

## Secret storage

Credentials are AES-256-GCM ciphertext in SQLite. Associated data binds encryption
version, user UUID, connector UUID, connector revision and credential revision.
Copying ciphertext to another user/connector/revision fails authentication. API,
SDK and CLI responses return configuration metadata and readiness, never token
values or ciphertext. Malformed CLI stdin produces a generic error without the
input excerpts that a raw JSON.parse exception could contain.

The private 32-byte key is stored in `BB_DATA_DIR/control-plane-mcp-key`, owned by
the server account with mode 0600 in its private directory. Key creation is
serialized in the process. Symlinks, permissive modes, invalid key bytes and
non-private directories are refused. A missing key is not recreated while any
encrypted credential exists. Preserve the BB data volume and this key together in
backups; losing the key requires restoring it or explicitly discarding affected
credentials. The server-owned key primitive lives in `@bb/secret-storage`; no new
server filesystem lint exception or access to user workspace files is added.

The private credential resolver repeats current authority and exact saved-row
checks after key I/O. It is not an HTTP endpoint and does not accept an owner from
user tool arguments. Runtime resolution derives the owner from the saved
thread context and rechecks grants and revisions before each call. Browser tokens
are not credential bindings. Tokens are never sent to the daemon or Qwen job.

## API, SDK and CLI

Administrative routes live under `/control-plane/admin/mcp/connectors`: list/get,
POST create, PUT `/:id` for revision-protected update and PUT
`/:id/access/:userId` with `{ "allowed": true|false }`. Personal routes use
`/control-plane/user/mcp/connectors` for the granted catalog and
`/:id/credential` for metadata, PUT and DELETE. The project list/configure path is
`/control-plane/user/projects/:projectId/mcp`; DELETE `/:connectionId` removes an
exact revision. Mutations accept only strict JSON and have a 64 KiB body cap.
These routes do not grant personal clients access to native BB APIs or plugins.

`createControlPlaneClient(...).admin.mcp` exposes `list`, `get`, `create`, `update`
and `grant`. Its personal `mcp` client exposes `list`, `get`, `credential`,
`setCredential`, `revokeCredential`, `connections`, `configure` and `remove`.
All responses are parsed through shared domain schemas. The matching
`bb server access mcp` commands are documented in `bb guide machines`; secret
input is stdin-only and output is JSON metadata. `configure` accepts
`connectorId`, `connectorRevision`, `expectedRevision` and optional `enabled`
(default false). Connection changes use revision CAS. Disabling/removing a
connection invalidates existing tool bindings.

No new Plugin SDK member is added. Protocol 255 signals the changed dynamic-tool
semantics to host daemons; Plugin SDK remains 0.6.80.

## Native execution

Approved profiles opt in with `mcpServers:["project"]` and `tools:["mcp:*"]` or
exact `mcp:<connector-slug>:<remote-tool-name>` selectors. Only explicitly selected
connections are resolved. Migration 0158 stores immutable tool bindings tied to
the thread, profile version, connection/connector/credential revisions and remote
definition. Descriptions travel through the existing provider-owned BB MCP tool
bridge; the central service performs network calls with the saved owner's PAT.
Opaque names, including the native prefix, fit within 64 characters so the pinned
Qwen CLI preserves them.

Every call requires the authenticated host, exact saved active thread/turn/native
session, current project/profile/connector grants and matching revisions. The
server re-fetches the remote tool definition, compares its snapshot and validates
arguments before invoking it. A 250ms authority poll aborts pending requests after
revocation, and checks repeat before returning the result. No automatic effectful
retry or rollback of completed external operations is promised. Catalog changes
require restarting the native Qwen session; stale bindings fail explicitly.

The approved Streamable HTTP endpoint supports JSON and request-response SSE.
Redirects, cookies, arbitrary headers/commands and persistent server-initiated
subscriptions are disabled. Raw network errors are suppressed and catalog/result
values containing the current PAT are rejected. Limits: 16 active connections per
project, 128 tools, four catalog pages, 32KiB per definition, 64KiB arguments,
1MiB per HTTP response, 30 seconds per operation, four simultaneous operations per
user and 16 per server.

## Evidence and remaining delivery

Real migrated-SQLite HTTP/SDK tests cover catalog and project grants, shared
read-only metadata, distinct personal secrets, CAS and tombstones, connector
revision changes, key loss/modes, asynchronous revocation, namespace injection and
body limits. Secret-storage tests exercise key creation races, symlinks, malformed
keys and unsafe directories. The SDK's existing automation definition test now
narrows the agent/script union before reading an agent prompt.

Docker verifies the actual limited API and built CLI for both users, encrypted
storage and server-account credential resolution. The execution fixture launches
two real stock Qwen CLI sessions, selects one remote tool per approved profile,
checks each service request's distinct personal bearer token and consumes the
actual remote result in the next model turn. It also resumes Bob's saved Qwen
session after server restart. Unit/integration tests exercise JSON/SSE, forged
turn/session/foreign bindings, schema drift, redirects, PAT reflection and active
grant revocation. See the [configuration evidence](control-plane-phase-61-verification.json)
and [execution evidence](control-plane-phase-62-verification.json).

The local model backend and remote MCP endpoint are deterministic test services;
this does not establish corporate CLI/SDK support. The complete combined Docker
acceptance, shared-project execution/workspace policy and project UI remain open.
Do not equate `configured` or `enabled` with a working authenticated connection.
