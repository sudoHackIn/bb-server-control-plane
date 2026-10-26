# Shared-server environment provider policy

Increment 60 closes the core environment-provider lifecycle path for registered
user workspaces. A provider plugin runs as trusted central server code. A saved
provider ID is not evidence that its create/restore/remove callbacks execute under
a user's Unix identity. The fixed native workspace worker from increment 59 does
not wrap arbitrary plugin callbacks.

## Current admission

Core refuses environment-provider selection, preparation and recovered operation
contexts for managed projects. It also refuses operator projects whose current
local source, proposed path, existing path or path claim lies inside any
registered HOME or projects root. Namespace protection remains after user
disablement or project-grant revocation. An unknown subdirectory cannot become a
service-account provider workspace. Ordinary operator projects outside registered
namespaces keep their existing provider behavior.

Admission runs before provider input/machine selection and validation. Availability
matching excludes protected projects. Availability, input validation, request
validation, existing-path selection and create/restore/remove callbacks repeat
authority checks inside the actual plugin invocation, after asynchronous bridge
preparation. Current saved environment/project/source data is checked rather than
trusting an earlier context snapshot. Path claims and returned paths are checked
before binding; a host wait is followed by a check inside the binding transaction.

This is mandatory core policy and does not depend on an optional access plugin.
It introduces no public endpoint, SDK member, CLI command, wire field or migration.
Host protocol remains 254 and Plugin SDK remains 0.6.80. Existing administrative
provider selection and cleanup requests receive
`403 managed_environment_provider_denied` when this policy applies. Personal
clients still cannot access the full native API.

## Legacy lifecycle and recovery

Old managed rows may retain a provider ID even though new managed workspaces use
native manual environment metadata. The provisioning/recovery and lifecycle
sweepers quarantine these rows before callbacks or service-account teardown.
Creating rows become `error` with a `Needs operator review` status message. Removal
becomes `failed`, clears automatic retirement and does not consume removal retries.
If a lifecycle sweep reaches a creating row first, it also moves creation to
`error`; sweeper order cannot leave an indefinitely creating workspace.

Quarantine preserves path, path claim, provider identity and resource metadata.
It neither deletes user files nor guesses that an external resource was removed.
Repeated sweeps do not rewrite identical quarantine state. Explicit native cleanup
and `bb environment cleanup --recover` recheck the same policy and cannot bypass
it. A previously valid callback admission can become invalid while its plugin
bridge is preparing; the callback is refused at invocation. Already completed
plugin or filesystem effects are not rolled back.

There is no automatic conversion of unknown legacy resources. An administrator
must inspect their actual state and establish a supported registered workspace
without executing the old callback as the service account. New personal project
provisioning, native Qwen threads and UID-scoped Git remain supported and are
included in the deployment regression checks.

## Evidence and boundary

Real migrated-SQLite tests cover two owners, disabled users, normalized namespace
aliases, direct selection/preparation, recovered contexts, availability and
legacy create/restore/remove. Tests change a persisted source at the actual bridge
boundary to verify that create, restore, remove and availability do not use stale
admission. Lifecycle-first ordering and repeated quarantine preserve resources
without retry consumption. Existing provider orchestration tests verify ordinary
operator creation, restore and removal.

The Docker fixture installs a real central provider. Its ordinary operator remove
callback must write a trace, proving that the provider is actually registered and
running. Both users' legacy creation/removal records and an operator record
pointing into a registered HOME must be quarantined without such callbacks.
Actual native cleanup/recovery HTTP requests are denied. Paths, claims, resources
and quarantine survive a real restart; the trace still contains only the control
callback. See [the verification record](control-plane-phase-60-verification.json).

Central plugins, the daemon and root remain trusted for assigned runtimes. This
policy constrains core's invocation of environment providers; it cannot sandbox
arbitrary server code that directly uses Node filesystem/process APIs. Supporting
user-controlled provider code would require a separate supported execution
contract. This increment does not complete composite workflow/automation/schedule
acceptance, project MCP credentials, reusable agents or wider UI/cache acceptance.
