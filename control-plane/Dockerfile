FROM golang:1.26-alpine AS cli-build
WORKDIR /src/cli
COPY cli ./
COPY LICENSE /src/LICENSE
COPY scripts/third-party-go.go /src/scripts/third-party-go.go
RUN sh build.sh

FROM node:22-alpine AS build
WORKDIR /app
COPY control-plane/package.json control-plane/package-lock.json ./
RUN npm ci
COPY control-plane/tsconfig.json ./
COPY control-plane/vite.config.ts control-plane/docs-plugin.ts ./
COPY control-plane/src ./src
COPY cli/skills /cli/skills
COPY control-plane/docs ./docs
COPY control-plane/web ./web
COPY scripts/third-party-npm.mjs /scripts/third-party-npm.mjs
COPY scripts/third-party-licenses /scripts/third-party-licenses
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV TMPDIR=/dev/shm
WORKDIR /app
COPY LICENSE /usr/share/driftverk/LICENSE
COPY control-plane/package.json control-plane/package-lock.json ./
RUN npm ci --omit=dev && npm install --global @openai/codex@0.154.0 && npm cache clean --force
COPY scripts/third-party-npm.mjs /scripts/third-party-npm.mjs
COPY scripts/third-party-licenses /scripts/third-party-licenses
RUN node /scripts/third-party-npm.mjs /app /usr/share/driftverk/THIRD_PARTY_NOTICES.txt && rm -rf /scripts
COPY --from=build /app/dist ./dist
COPY control-plane/docs ./docs
COPY control-plane/migrations ./migrations
COPY control-plane/installer ./installer
COPY --from=cli-build /src/control-plane/installer/bin ./installer/bin
COPY compose.compute.yaml ./compute-agent-bundle/compose.compute.yaml
COPY infrastructure/compute-agent ./compute-agent-bundle/infrastructure/compute-agent
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
