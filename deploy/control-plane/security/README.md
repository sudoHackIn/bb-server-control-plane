# Agent process namespaces

`moby-default-seccomp.json` is the unmodified Moby default profile from commit
`4b8214fc4971e06172938a1f1554ccff6647ee80`:
https://github.com/moby/profiles/blob/4b8214fc4971e06172938a1f1554ccff6647ee80/seccomp/default.json.
The adjacent Apache 2.0 license applies to that file.

Generate the deployment profile from the repository root:

```sh
node scripts/control-plane-seccomp.mjs /secure/bb-seccomp.json
```

The generator preserves the default deny action and all original rules. It adds
`unshare` only for USER, PID+MOUNT and USER+PID+MOUNT flags, and `mount` only for
recursive-private propagation and a nosuid/nodev/noexec proc mount. Other namespace
flags, `setns`, privileged containers and `CAP_SYS_ADMIN` are not enabled.

Start the execution container with `--security-opt seccomp=/secure/bb-seccomp.json`
and `--security-opt systempaths=unconfined`. The second option removes Docker's
global proc submount masks which otherwise prevent the unprivileged namespace
from mounting its own proc. This is not `seccomp=unconfined`. The root filesystem
can remain read-only, and the default Docker capability set is sufficient. Do not
publish the Docker socket or host proc mounts to agents.

The root-owned launcher first drops to the registered UID/GID, clears groups and
sets no-new-privileges. It then creates a user namespace mapping that same numeric
UID/GID, a PID namespace and a private mount namespace, and mounts proc for that
PID namespace before execing the fixed Qwen CLI. The CLI and all its tools see
their own job's processes, including their own argv, but cannot enumerate BB,
root supervisors or another job through proc. This is process-metadata isolation,
not a filesystem jail or a network boundary. HOME/project permissions and central
server admission remain necessary. The BB service and supervisors intentionally
retain the outer process view. Untrusted code must only enter through this launch
boundary; do not offer tenant shell access in the outer namespace.

On a non-Docker Linux host, install util-linux with `unshare` and enable
unprivileged user namespaces in the kernel and applicable LSM policy. If this is
unavailable, launch fails; there is no fallback to UID-only execution. Every job
gets a separate PID namespace while concurrent jobs for the same user share HOME.
`BB_AGENT_JOB_ID` is a non-secret random diagnostic identity, distinct from the
Qwen session ID. Root supervisors retain outer PID/start-time leases for stopping
the complete tree and detecting service death.

The Docker deployment check tests both the actual launcher's failure under the
default seccomp profile and successful native Qwen execution under the derived
profile. Hostile native tools scan their own proc views during concurrent jobs;
the root observer verifies those jobs really exist in its outer proc view and
checks cancellation/parent-death cleanup with outer PIDs.
