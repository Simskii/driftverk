#!/usr/bin/env bash
# Runs on the host, independently of Docker and the compute agent.
set -euo pipefail
INSTALL_DIR="${DRIFTVERK_INSTALL_DIR:-/opt/driftverk}"
STATE_DIR="${DRIFTVERK_HEALTH_DIR:-/var/lib/driftverk/health}"
install -d -m 0755 "$STATE_DIR"
exec 9>"$STATE_DIR/lock"
flock -n 9 || exit 0
checks='[]'
now=$(date +%s)
add() { checks=$(jq -c --arg service "$1" --arg status "$2" --arg message "$3" '. + [{service:$service,status:$status,message:$message}]' <<<"$checks"); }
recover() {
  local service="$1" attempts=0 next=0
  shift
  if [ -f "$STATE_DIR/$service.retry" ]; then read -r attempts next < "$STATE_DIR/$service.retry"
  else
    # Publish the failed check before recovery so agents stop admitting new work.
    printf '0 %s\n' "$((now + 30))" > "$STATE_DIR/$service.retry"
    add "$service" recovering 'Failure detected. Waiting 30 seconds before recovery.'
    return
  fi
  if (( attempts >= 3 )); then add "$service" unhealthy 'Recovery attempts exhausted. Administrator action required.'; return; fi
  if (( now < next )); then add "$service" recovering "Waiting before recovery attempt $((attempts + 1))"; return; fi
  attempts=$((attempts + 1))
  printf '%s %s\n' "$attempts" "$((now + 60 * (2 ** attempts)))" > "$STATE_DIR/$service.retry"
  # Docker is only started if failed. Sysbox restart requires no live Sysbox containers.
  if timeout 20 "$@"; then
    add "$service" recovering "Started service, verifying on next check. Attempt $attempts of 3."
  else add "$service" unhealthy "Service start failed. Attempt $attempts of 3."; fi
}
for service in docker; do
  state=$(systemctl is-active "$service" 2>/dev/null || true)
  if [ "$state" = active ]; then
    if timeout 5 docker info >/dev/null 2>&1; then add "$service" healthy ''; else add "$service" unhealthy 'Docker is unresponsive. Automatic restart is unsafe for running environments.'; fi
  elif [ "$state" = failed ]; then recover "$service" systemctl start "$service"
  else add "$service" unhealthy 'Service is stopped. Start it explicitly if this was not intentional.'; fi
done
runtime=$(sed -n 's/^DOCKER_RUNTIME=//p' "$INSTALL_DIR/.env.compute" | head -n 1)
if [ "$runtime" = sysbox-runc ]; then
  if systemctl is-active --quiet sysbox-fs && systemctl is-active --quiet sysbox-mgr; then
    add sysbox healthy ''
  else
    # A daemon start loses registration for live containers. Require an empty runtime.
    ids=$(timeout 5 docker ps -q) || ids=unknown
    safe=true
    if [ "$ids" = unknown ]; then safe=false
    elif [ -n "$ids" ]; then
      runtimes=$(timeout 5 docker inspect --format '{{.HostConfig.Runtime}}' $ids) || runtimes=sysbox-runc
      if grep -qx sysbox-runc <<<"$runtimes"; then safe=false; fi
    fi
    if [ "$safe" = false ]; then add sysbox unhealthy 'Sysbox is unavailable with active environments. Administrator action required.'
    elif [ "$(systemctl is-active sysbox-fs 2>/dev/null || true)" = failed ] || [ "$(systemctl is-active sysbox-mgr 2>/dev/null || true)" = failed ]; then recover sysbox systemctl restart sysbox
    else add sysbox unhealthy 'Sysbox is stopped. Start it explicitly if this was not intentional.'; fi
  fi
fi
for service in compute-agent preview-gateway web-terminal; do
  container=$(timeout 5 docker compose --env-file "$INSTALL_DIR/.env.compute" -f "$INSTALL_DIR/compose.compute.yaml" ps -aq "$service") || container=''
  if [ -z "$container" ]; then add "$service" unhealthy 'Service container is missing.'; continue; fi
  state=$(timeout 5 docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container") || state=unknown
  if [ "$state" = 'running healthy' ]; then add "$service" healthy ''
  elif [ "$state" = 'running unhealthy' ]; then recover "$service" docker restart --time 5 "$container"
  elif [ "$state" = 'running starting' ] || [ "$state" = 'restarting ' ]; then add "$service" recovering 'Waiting for service to become healthy.'
  else add "$service" unhealthy 'Service is stopped or lacks a health check. Check installation and logs.'; fi
done
# Recovery budgets persist across restarts. An administrator can remove a specific
# .retry file after fixing the cause to permit three more attempts.
jq -n --argjson checked_at "$((now * 1000))" --argjson checks "$checks" '{checked_at:$checked_at,checks:$checks}' > "$STATE_DIR/status.json.tmp"
chmod 0644 "$STATE_DIR/status.json.tmp"
mv "$STATE_DIR/status.json.tmp" "$STATE_DIR/status.json"
printf '%s\n' "$checks"
