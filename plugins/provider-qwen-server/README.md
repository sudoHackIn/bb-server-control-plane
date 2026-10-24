# Qwen Server

Run Qwen Code on a shared Linux server under each registered user's numeric UID, GID and private HOME. Native BB threads keep their history while the control plane determines the permitted project directory and execution identity.

This provider requires the fork's managed runtime, private execution-context socket and fixed privileged launcher. It is disabled by default. Enable it only on a configured shared server; installing this plugin alone does not provision users or authorize arbitrary workspaces.

The privileged launcher drops supplementary groups and enables no-new-privileges, then creates a separate user/PID/mount namespace for each job, mapping the same numeric UID/GID. The agent's proc view excludes BB and other jobs, including their command lines. Concurrent jobs for one user still share HOME. Namespace failure prevents execution; there is no UID-only fallback. Unix permissions protect private user and service data; HOME is not a filesystem jail. Docker requires the repository's derived seccomp profile and proc-mount configuration, documented in `deploy/control-plane/security/README.md`. See the bundled Qwen Server skill and the repository's shared-server feature plan for verification status and remaining profile, tool and MCP authorization work.
