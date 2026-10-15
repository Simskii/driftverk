FROM node:22-alpine
COPY LICENSE /usr/share/driftverk/LICENSE

WORKDIR /app
COPY infrastructure/data-gateway/package.json infrastructure/data-gateway/package-lock.json ./
RUN npm ci --omit=dev
COPY infrastructure/data-gateway/server.mjs infrastructure/data-gateway/protocol.mjs infrastructure/data-gateway/preview-status-page.mjs infrastructure/data-gateway/ssh-bridge.mjs ./

USER node
EXPOSE 3001 3002
CMD ["node", "server.mjs"]
