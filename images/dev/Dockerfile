FROM node:24-bookworm@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2
COPY LICENSE /usr/share/driftverk/LICENSE

ENV SHELL=/bin/bash

ARG CODEX_VERSION=0.154.0
ARG CLAUDE_VERSION=2.1.263
ARG BUN_VERSION=1.4.2
ARG PNPM_VERSION=12.3.4
ARG UV_VERSION=0.12.10
ARG DOCKER_VERSION=5:29.8.0-1~debian.12~bookworm
ARG CONTAINERD_VERSION=2.3.4-2~debian.12~bookworm
ARG COMPOSE_VERSION=2.40.3-1~debian.12~bookworm
ARG BUILDX_VERSION=0.37.0-1~debian.12~bookworm
ARG TAILSCALE_VERSION=1.102.3

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget git git-lfs gh openssh-client build-essential \
    python3 python3-pip python3-venv jq ripgrep unzip zip less nano vim tmux \
    procps sudo iproute2 iputils-ping dnsutils tini \
    chromium xvfb x11vnc openbox novnc websockify x11-utils fonts-liberation ffmpeg wmctrl \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    docker-ce="${DOCKER_VERSION}" docker-ce-cli="${DOCKER_VERSION}" \
    containerd.io="${CONTAINERD_VERSION}" docker-compose-plugin="${COMPOSE_VERSION}" docker-buildx-plugin="${BUILDX_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

# Install the client and daemon only. Tailnet authorization happens per environment.
RUN curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg -o /etc/apt/keyrings/tailscale.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/tailscale.gpg] https://pkgs.tailscale.com/stable/debian bookworm main" > /etc/apt/sources.list.d/tailscale.list \
    && apt-get update && apt-get install -y --no-install-recommends tailscale="${TAILSCALE_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
    "bun@${BUN_VERSION}" "pnpm@${PNPM_VERSION}" && npm cache clean --force \
    && python3 -m venv /opt/uv && /opt/uv/bin/pip install --no-cache-dir "uv==${UV_VERSION}" \
    && ln -s /opt/uv/bin/uv /usr/local/bin/uv && ln -s /opt/uv/bin/uvx /usr/local/bin/uvx \
    && git lfs install --system

# Preserve legacy project commands while using the maintained Compose plugin.
RUN printf '#!/bin/sh\nexec docker compose "$@"\n' > /usr/local/bin/docker-compose \
    && chmod +x /usr/local/bin/docker-compose
COPY docker.sh /usr/local/bin/docker
COPY start-docker.sh /usr/local/bin/driftverk-start-docker
COPY smoke.sh /usr/local/bin/driftverk-dev-smoke
COPY desktop/browser.py /usr/local/bin/driftverk-browser
COPY desktop/prompt.py /usr/local/bin/driftverk-prompt
COPY desktop/demo.mjs /usr/local/bin/driftverk-browser-demo
COPY desktop/viewer/ /opt/driftverk-browser/viewer/
RUN chmod +x /usr/local/bin/driftverk-browser /usr/local/bin/driftverk-prompt /usr/local/bin/driftverk-browser-demo \
    && ln -s /usr/share/novnc /opt/driftverk-browser/viewer/novnc
RUN chmod +x /usr/local/bin/docker /usr/local/bin/driftverk-* && /usr/local/bin/driftverk-dev-smoke

LABEL org.opencontainers.image.title="Driftverk Dev" \
      org.opencontainers.image.description="Development tools with on-demand Docker Compose" \
      driftverk.system-image="dev"
ENV DISABLE_AUTOUPDATER=1
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
