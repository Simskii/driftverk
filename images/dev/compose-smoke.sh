#!/bin/sh
set -eu
# Run inside a disposable Sysbox environment or privileged CI container.
# In CI only, mount an anonymous volume at /var/lib/docker to avoid overlay-on-overlay.
! pgrep -x dockerd
docker compose version
docker run --help >/dev/null
! pgrep -x dockerd
mkdir -p /tmp/driftverk-compose-smoke
cd /tmp/driftverk-compose-smoke
cat > compose.yaml <<'COMPOSE'
services:
  web:
    image: nginx:1.28-alpine
    ports:
      - "127.0.0.1:18080:80"
COMPOSE
trap 'docker compose down --volumes' EXIT
docker compose config --quiet
! pgrep -x dockerd
mkdir -p /run/docker/containerd
printf '%s' "$$" > /run/docker/containerd/containerd.pid
docker compose up -d
pgrep -x dockerd
attempts=0
until curl --fail --silent http://127.0.0.1:18080/ >/dev/null; do
  attempts=$((attempts + 1))
  test "$attempts" -lt 30
  sleep 1
done
printf 'Compose service responded over HTTP\n'
