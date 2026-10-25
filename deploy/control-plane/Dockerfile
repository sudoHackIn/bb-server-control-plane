FROM node:22.23.4-bookworm-slim AS dependencies
WORKDIR /opt/bb
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22.23.4-bookworm-slim
WORKDIR /opt/bb
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git util-linux python3 sudo acl && rm -rf /var/lib/apt/lists/* && mkdir -p /srv/bb && chown node:node /srv/bb
COPY launcher /opt/bb-control-plane/launcher
COPY --from=dependencies /opt/bb/node_modules ./node_modules
COPY workflow-evaluator.mjs /opt/bb-control-plane/workflow-evaluator.mjs
RUN python3 -I /opt/bb-control-plane/launcher/install.py --service-user node --users-root /srv/agent-users --qwen-cli /opt/bb/node_modules/@qwen-code/sdk/dist/cli/cli.js --workflow-evaluator /opt/bb-control-plane/workflow-evaluator.mjs --script-runtime node-esm
COPY package.json ./
COPY server ./apps/server/dist
COPY app ./apps/app/dist
COPY cli ./apps/cli/dist
COPY host-daemon ./apps/host-daemon/dist
COPY --chown=node:node control-plane-tool-plugin /srv/bb-tool-fixture
COPY inherited-source-check.mjs check-control-plane-script-automations.mjs script-runner-check.mjs check-control-plane-script-jobs.mjs script-job-client.mjs check-control-plane-automations.mjs workflow-worker-check.mjs workflow-evaluator-check.mjs check-control-plane-workflows.mjs check-control-plane-workflow-definitions.mjs job-bindings-check.mjs check-control-plane-approvals.mjs check-control-plane-user-threads.mjs check-control-plane-browser-handshake.mjs ./
COPY configure.mjs deployment-check.mjs namespace-denial.mjs check-control-plane-user-deployment.mjs check-control-plane-qwen-jobs.mjs check-control-plane-managed-runtime.mjs check-control-plane-daemon-requests.mjs check-control-plane-message-sources.mjs qwen-job-client.mjs qwen-server-query.mjs qwen-runtime-fixture.mjs ./
ENV NODE_ENV=production BB_DATA_DIR=/srv/bb BB_SERVER_PORT=8080 BB_SERVER_BIND_HOST=0.0.0.0 BB_CONTROL_PLANE_REQUIRED=1 BB_TELEMETRY=0
USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
