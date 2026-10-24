# Qwen Server

Run Qwen Code on a shared Linux server under each registered user's numeric UID, GID and private HOME. Native BB threads keep their history while the control plane determines the permitted project directory and execution identity.

This provider requires the fork's managed runtime, private execution-context socket and fixed privileged launcher. It is disabled by default. Enable it only on a configured shared server; installing this plugin alone does not provision users or authorize arbitrary workspaces.

The privileged launcher drops supplementary groups and enables no-new-privileges. Unix permissions protect private user and service data; HOME is not a filesystem jail. See the bundled Qwen Server skill and the repository's shared-server feature plan for verification status and remaining profile, tool and MCP authorization work.
