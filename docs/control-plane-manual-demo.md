# Local manual Docker demo

The manual demo runs the built shared server, supervised daemon and real Qwen
CLI with a deterministic local OpenAI-compatible model fixture. Replies are
demonstration text; this does not verify a live model or corporate Qwen login.
Project MCP connectors remain planned work.

Current local instance:

- Container: `bb-control-plane-demo`.
- User entry: `https://127.0.0.1:8086/control-plane/user/login`.
- Administrator entry: `https://127.0.0.1:8086/control-plane/login`.
- Administrator login: `operator`; local demo password:
  `demo-local-operator-password`.
- User certificates: CN `alice` and CN `bob`; PKCS#12 password: `bb-demo`.
- Certificates and screenshots for this instance:
  `/Users/vladislav/.bb/thread-storage/thr_xyrcnuphrn/manual-demo/`.
- Certificates expire seven days after generation. Import `ca.crt` as the trusted
  local demo CA and import `alice.p12` or `bob.p12` as a client identity. Open
  exactly the IP address above. Use separate browser profiles or restart the
  browser when switching client identities; cookie logout alone does not clear
  the browser's TLS certificate selection.

Both users have a provisioned HOME, a personal `Demo` project, an approved profile
and a welcome conversation. The personal UI exposes conversations, Workflows and
Automations, including inline Node scripts and output. The model fixture does not
generate tool calls; script automations can execute actual code under the user's
registered UID. Administrator access opens the full native BB interface.

The bootstrap entrypoint is `deploy/control-plane/demo.mjs`. It uses real login,
provisioning, project, profile and thread APIs; database access only reads user
IDs and daemon readiness. The server runs as UID 1000; the root container wrapper
is only bootstrap/supervision. The model fixture listens on container loopback.
The published UI port binds host loopback only.

Data survives container stops in named Docker volumes:
`bb-control-plane-demo-data`, `bb-control-plane-demo-users` and
`bb-control-plane-demo-launcher`. Temporary runtime files live in `/tmp` tmpfs.
The security options match the existing namespace-enabled Docker verification
fixture. No `--privileged` or host filesystem workspace mount is used.

Stop and start the existing instance:

```sh
docker stop --time 60 bb-control-plane-demo
docker start bb-control-plane-demo
```

Rebuilding `bb-control-plane:local` alone does not replace this container's image.
Keep its data volumes when recreating it. Its read-only entrypoint bind mount
points to this checkout; keep this checkout available while using the demo.
