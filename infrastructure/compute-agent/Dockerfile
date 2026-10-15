FROM node:22-alpine
COPY LICENSE /usr/share/driftverk/LICENSE

RUN apk add --no-cache docker-cli openssh-keygen iproute2 util-linux fuse3 rclone
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY executions.mjs execution-worker.py index.mjs resolve-access.mjs websocket-activity.mjs image-cleanup.mjs data-tunnel.mjs ssh-loopback.mjs tunnel-protocol.mjs docker-runtime.mjs snapshot-storage.mjs volume-storage.mjs preview-gateway.mjs preview-status-page.mjs web-terminal.mjs ./
COPY health.mjs ./
COPY agent-terminal.mjs agent-connection.mjs agent-sessions.mjs ./
COPY persistent-terminal.mjs ./
COPY runtime-probe.mjs ./
CMD ["node", "index.mjs"]
