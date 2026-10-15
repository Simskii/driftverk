#!/bin/sh
set -eu
# This daemon belongs to the environment. Never mount the host Docker socket.
if /usr/bin/docker info >/dev/null 2>&1; then exit 0; fi
mkdir -p /var/log /run
# Concurrent agent commands must share one daemon startup.
exec 9>/run/driftverk-docker.lock
flock -w 40 9
if /usr/bin/docker info >/dev/null 2>&1; then exit 0; fi
# /run survives a container stop/start. A stale PID may now belong to an
# unrelated process, so verify its command before letting Docker reuse it.
clear_stale_pid() {
  file=$1
  expected=$2
  if [ -f "$file" ]; then
    pid=$(cat "$file")
    case "$pid" in ''|*[!0-9]*) actual='' ;; *) actual=$(cat "/proc/$pid/comm" 2>/dev/null || true) ;; esac
    if [ "$actual" != "$expected" ]; then rm -f "$file"; fi
  fi
}
clear_stale_pid /run/docker.pid dockerd
clear_stale_pid /run/docker/containerd/containerd.pid containerd
nohup dockerd > /var/log/driftverk-dockerd.log 2>&1 < /dev/null 9>&- &
attempts=0
until /usr/bin/docker info >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 30 ]; then
    echo 'Environment Docker failed to start. See /var/log/driftverk-dockerd.log; a supported Sysbox host is required.' >&2
    tail -30 /var/log/driftverk-dockerd.log >&2
    exit 1
  fi
  sleep 1
done
