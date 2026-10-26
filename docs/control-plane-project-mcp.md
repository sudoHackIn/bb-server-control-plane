# Project MCP configuration

Increment 61 adds the management foundation for project MCP: centrally approved
connectors, per-user connector grants, project connection records and encrypted
personal credentials. It does not activate remote tools. Connections are stored
with `enabled: false`, return `executionState: "not_activated"`, and connection
lists return `executionSupported: false`. An `enabled` input is rejected rather
than silently accepted. Actual provider delivery, live revocation, the project UI
and two-user remote MCP calls remain required for the full feature.

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
user tool arguments. Subsequent runtime integration must derive that owner from
the saved thread/run context. Browser tokens are not credential bindings.

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
input is stdin-only and output is JSON metadata. No new Plugin SDK member or
daemon wire field is added. Protocol remains 254; Plugin SDK remains 0.6.80.

## Evidence and remaining delivery

Real migrated-SQLite HTTP/SDK tests cover catalog and project grants, shared
read-only metadata, distinct personal secrets, CAS and tombstones, connector
revision changes, key loss/modes, asynchronous revocation, namespace injection and
body limits. Secret-storage tests exercise key creation races, symlinks, malformed
keys and unsafe directories. The SDK's existing automation definition test now
narrows the agent/script union before reading an agent prompt.

Docker must verify the actual limited API and built CLI for both users, ciphertext
at rest, server-account resolution using the production credential service,
restart, shared-project metadata, revocation and rejected activation/identity
injection. This is configuration acceptance, not a remote MCP provider-to-tool
round trip. See [the verification record](control-plane-phase-61-verification.json).

The next execution stage must resolve enabled, authorized connections from saved
user/project context at start and resume, enforce profile restrictions, send only
the matching user's credentials through a supported provider/tool adapter, and
verify real remote tools, redirects, failures and active revocation in Docker.
The shared-project execution/workspace policy must be verified separately from
read-only connection metadata. Ship the project UI with those actual states;
do not equate `configured` with a working or authenticated remote connection.
