FROM node:22.23.4-bookworm-slim AS dependencies
WORKDIR /opt/bb
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22.23.4-bookworm-slim
WORKDIR /opt/bb
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git util-linux && rm -rf /var/lib/apt/lists/* && mkdir -p /srv/bb && chown node:node /srv/bb
COPY --from=dependencies /opt/bb/node_modules ./node_modules
COPY package.json ./
COPY server ./apps/server/dist
COPY app ./apps/app/dist
COPY cli ./apps/cli/dist
COPY configure.mjs deployment-check.mjs ./
ENV NODE_ENV=production BB_DATA_DIR=/srv/bb BB_SERVER_PORT=8080 BB_SERVER_BIND_HOST=0.0.0.0 BB_CONTROL_PLANE_REQUIRED=1 BB_TELEMETRY=0
USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
