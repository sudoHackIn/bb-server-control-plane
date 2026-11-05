FROM node:22.23.4-bookworm-slim AS dependencies
WORKDIR /opt/bb
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22.23.4-bookworm-slim AS beads
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}"; case "$arch" in arm64) checksum=f4ee6eb3ec79bb2d7eb9d717c73efbcb6fa763cc70f726b4d055b72afdd68ad5 ;; amd64) checksum=175c26904bde3ff9168d2282ff6b56f17b17f60c22fa5acb3dacc9fb3465303a ;; *) exit 1 ;; esac; curl -fsSL "https://github.com/gastownhall/beads/releases/download/v1.3.4/beads_1.3.4_linux_${arch}.tar.gz" -o /tmp/beads.tar.gz && echo "$checksum  /tmp/beads.tar.gz" | sha256sum -c - && tar -xzf /tmp/beads.tar.gz -C /usr/local/bin bd && /usr/local/bin/bd version

FROM node:22.23.4-bookworm-slim
COPY --from=beads /usr/local/bin/bd /usr/local/bin/bd
WORKDIR /opt/bb
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git util-linux python3 sudo acl && rm -rf /var/lib/apt/lists/* && mkdir -p /srv/bb && chown node:node /srv/bb
COPY launcher /opt/bb-control-plane/launcher
COPY --from=dependencies /opt/bb/node_modules ./node_modules
COPY workflow-evaluator.mjs /opt/bb-control-plane/workflow-evaluator.mjs
COPY workspace-worker.mjs /opt/bb-control-plane/workspace-worker.mjs
RUN python3 -I /opt/bb-control-plane/launcher/install.py --service-user node --users-root /srv/agent-users --qwen-cli /opt/bb/node_modules/@qwen-code/sdk/dist/cli/cli.js --workflow-evaluator /opt/bb-control-plane/workflow-evaluator.mjs --script-runtime node-esm --workspace-worker /opt/bb-control-plane/workspace-worker.mjs
COPY package.json ./
COPY server ./apps/server/dist
COPY app ./apps/app/dist
COPY cli ./apps/cli/dist
COPY host-daemon ./apps/host-daemon/dist
COPY --chown=node:node control-plane-tool-plugin /srv/bb-tool-fixture
COPY inherited-source-check.mjs check-control-plane-script-automations.mjs script-runner-check.mjs check-control-plane-script-jobs.mjs script-job-client.mjs check-control-plane-automations.mjs workflow-worker-check.mjs workflow-evaluator-check.mjs check-control-plane-workflows.mjs check-control-plane-workflow-agents.mjs check-control-plane-webhooks.mjs check-control-plane-task-sources.mjs check-control-plane-workflow-definitions.mjs job-bindings-check.mjs check-control-plane-approvals.mjs check-control-plane-user-threads.mjs check-control-plane-inspections.mjs check-control-plane-browser-handshake.mjs ./
COPY check-control-plane-native-maintenance.mjs check-control-plane-maintenance-queue.mjs check-control-plane-project-maintenance.mjs check-control-plane-uid-leases.mjs check-control-plane-project-access.mjs mcp-credential-check.mjs check-control-plane-project-mcp.mjs check-control-plane-provider-lifecycle.mjs check-control-plane-workspace.mjs configure.mjs deployment-check.mjs namespace-denial.mjs check-control-plane-user-deployment.mjs check-control-plane-qwen-jobs.mjs check-control-plane-managed-runtime.mjs check-control-plane-daemon-requests.mjs check-control-plane-message-sources.mjs qwen-job-client.mjs qwen-server-query.mjs qwen-runtime-fixture.mjs ./
ENV NODE_ENV=production BB_DATA_DIR=/srv/bb BB_SERVER_PORT=8080 BB_SERVER_BIND_HOST=0.0.0.0 BB_CONTROL_PLANE_REQUIRED=1 BB_TELEMETRY=0
USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
