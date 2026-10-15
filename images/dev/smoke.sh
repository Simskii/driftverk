#!/bin/sh
set -eu
test -n "${SHELL:-}" && test -x "$SHELL"
for tool in git gh ssh gcc make jq rg unzip curl wget less nano vim tmux python3; do command -v "$tool"; done
node --version
npm --version
pnpm --version
bun --version
codex --version
claude --version
python3 -m pip --version
python3 -m venv /tmp/driftverk-venv-smoke
rm -rf /tmp/driftverk-venv-smoke
uv --version
git lfs version
docker --version
dockerd --version
docker compose version
docker buildx version
tailscale version
tailscaled --version
test ! -s /var/lib/tailscale/tailscaled.state
