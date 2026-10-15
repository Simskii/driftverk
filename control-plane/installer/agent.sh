#!/usr/bin/env bash
set -euo pipefail

DEFAULT_CONTROL_PLANE_URL='https://app.driftverk.com'
CONTROL_PLANE_URL="${DRIFTVERK_CONTROL_PLANE_URL:-$DEFAULT_CONTROL_PLANE_URL}"
INSTALL_DIR="${DRIFTVERK_INSTALL_DIR:-/opt/driftverk}"
SYSBOX_VERSION="0.7.1"
SYSBOX_AMD64_SHA256="9d6d5484f980d0a17f86c492c1262015c2afb66280bdb97215b79fde6a0261c5"
apt_updated=false
bootstrap_host_checked=false
sysbox_package=""

fail() { printf '\nError: %s\n' "$1" >&2; exit 1; }
status() { printf '  %-32s %s\n' "$1" "$2"; }
json() { jq -r "$1"; }
enrollment_domains() {
  local response="$1" registered_url="$2"
  panel_hostname="$(printf '%s' "$response" | jq -r --arg url "$registered_url" '.panel_hostname // ($url | capture("^https?://(?<host>[^/:]+)").host)')"
  preview_domain="$(printf '%s' "$response" | jq -r --arg host "$panel_hostname" '.preview_domain // ("preview." + $host)')"
  [[ "$panel_hostname" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail "Invalid panel hostname in enrollment response."
  [[ "$preview_domain" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail "Invalid preview domain in enrollment response."
}
cleanup() {
  [ -z "$sysbox_package" ] || [ ! -f "$sysbox_package" ] || rm -f "$sysbox_package"
  return 0
}
trap cleanup EXIT

require_bootstrap_host() {
  [ "$bootstrap_host_checked" = false ] || return 0
  [ -r /etc/os-release ] || fail "Automatic dependency installation requires Ubuntu 22.04 or 24.04 on amd64."
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = "ubuntu" ] || fail "Automatic dependency installation supports Ubuntu 22.04 and 24.04 only. Install Docker, Compose, jq, and Sysbox manually on this host, then rerun the installer."
  case "${VERSION_ID:-}" in
    22.04|24.04) ;;
    *) fail "Automatic dependency installation supports Ubuntu 22.04 and 24.04 only. This host reports ${PRETTY_NAME:-an unsupported Ubuntu version}." ;;
  esac
  [ "$(dpkg --print-architecture 2>/dev/null)" = "amd64" ] || fail "Automatic dependency installation currently supports amd64 only."
  command -v systemctl >/dev/null || fail "Automatic dependency installation requires systemd."
  bootstrap_host_checked=true
}

apt_update() {
  [ "$apt_updated" = false ] || return 0
  DEBIAN_FRONTEND=noninteractive apt-get update </dev/null
  apt_updated=true
}

apt_install() {
  require_bootstrap_host
  apt_update
  DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" </dev/null
}

ensure_host_tools() {
  local packages=()
  command -v curl >/dev/null || packages+=(curl)
  command -v jq >/dev/null || packages+=(jq)
  command -v sha256sum >/dev/null || packages+=(coreutils)
  [ "${#packages[@]}" -eq 0 ] || apt_install ca-certificates "${packages[@]}"
}

docker_conflicts() {
  local package conflicts=()
  for package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
    dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null | grep -q '^installed$' && conflicts+=("$package")
  done
  [ "${#conflicts[@]}" -eq 0 ] || fail "Conflicting Docker packages are installed: ${conflicts[*]}. This installer will not remove packages automatically. Prepare a clean Ubuntu host or remove the conflicts yourself."
}

install_docker() {
  require_bootstrap_host
  docker_conflicts
  apt_install ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc || fail "Could not download Docker's repository key."
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt_updated=false
  apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker >/dev/null || fail "Docker was installed but could not be started."
}

ensure_docker() {
  if ! command -v docker >/dev/null; then
    printf 'Installing Docker Engine and Docker Compose...\n'
    install_docker
  fi
  if ! docker info >/dev/null 2>&1 && command -v systemctl >/dev/null; then
    systemctl start docker >/dev/null 2>&1 || true
  fi
  docker info >/dev/null 2>&1 || fail "Docker is installed but is not running or cannot be reached."
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required. The installer will not replace an existing Docker installation automatically."
}

ensure_sysbox() {
  docker info --format '{{json .Runtimes}}' | grep -q 'sysbox-runc' && return
  require_bootstrap_host
  [ -z "$(docker ps -aq)" ] || fail "Sysbox is missing and this Docker host already contains containers. The installer will not restart Docker on a host with existing workloads. Use a clean dedicated host or install Sysbox manually."
  printf 'Installing Sysbox %s...\n' "$SYSBOX_VERSION"
  sysbox_package="$(mktemp /tmp/driftverk-sysbox.XXXXXX.deb)"
  curl -fsSL "https://github.com/nestybox/sysbox/releases/download/v${SYSBOX_VERSION}/sysbox-ce_${SYSBOX_VERSION}.linux_amd64.deb" -o "$sysbox_package" || fail "Could not download Sysbox ${SYSBOX_VERSION}."
  printf '%s  %s\n' "$SYSBOX_AMD64_SHA256" "$sysbox_package" | sha256sum -c - >/dev/null || fail "The downloaded Sysbox package failed checksum verification."
  apt_update
  DEBIAN_FRONTEND=noninteractive apt-get install -y "$sysbox_package" </dev/null
  rm -f "$sysbox_package"
  sysbox_package=""
  docker info --format '{{json .Runtimes}}' | grep -q 'sysbox-runc' || fail "Sysbox was installed but Docker does not report the sysbox-runc runtime."
}

printf '\nDriftverk Compute agent setup\n\n'
[ "$(id -u)" -eq 0 ] || fail "Run this installer with sudo."
ensure_host_tools
# Sysbox cannot preserve active container registrations across a daemon restart.
# Keep library-triggered needrestart restarts for Sysbox in planned maintenance.
if [ -d /etc/needrestart/conf.d ]; then
  cat > /etc/needrestart/conf.d/driftverk.conf <<'EOF'
push @{$nrconf{blacklist_rc}}, qr(^sysbox(?:-fs|-mgr)?(?:\.service)?$);
EOF
fi
ensure_docker
ensure_sysbox

status "jq" "OK"
status "Docker Engine" "OK"
status "Docker Compose" "OK"
status "Sysbox runtime" "OK"

existing_env="${INSTALL_DIR}/.env.compute"
if [ -f "$existing_env" ]; then
  new_registration=false
  printf '\nExisting Compute agent configuration found. Reusing it.\n'
  agent_name="$(hostname -s 2>/dev/null || hostname)"
  compute_token="$(sed -n 's/^COMPUTE_AGENT_TOKEN=//p' "$existing_env")"
  compute_node_id="$(sed -n 's/^COMPUTE_NODE_ID=//p' "$existing_env")"
  registered_url="$(sed -n 's/^CONTROL_PLANE_URL=//p' "$existing_env")"
  [ -n "$compute_token" ] && [ -n "$compute_node_id" ] && [ -n "$registered_url" ] || fail "The existing .env.compute is incomplete."
  CONTROL_PLANE_URL="$registered_url"
else
  new_registration=true
  default_name="$(hostname -s 2>/dev/null || hostname)"
  agent_name="$default_name"

  start_response="$(curl -fsS -X POST "${CONTROL_PLANE_URL}/api/compute-agent-setup/start" -H 'content-type: application/json' --data "$(jq -cn --arg name "$agent_name" '{name:$name}')")" || fail "Could not contact the Driftverk control plane."
  device_code="$(printf '%s' "$start_response" | json '.device_code')"
  user_code="$(printf '%s' "$start_response" | json '.user_code')"
  verification_url="$(printf '%s' "$start_response" | json '.verification_uri_complete')"
  interval="$(printf '%s' "$start_response" | json '.interval')"

  printf '\nOpen this URL in a browser:\n%s\n\nConfirm code: %s\n\nWaiting for authorization' "$verification_url" "$user_code"

  deadline=$((SECONDS + 600))
  while [ "$SECONDS" -lt "$deadline" ]; do
    response_file="$(mktemp)"
    http_status="$(curl -sS -o "$response_file" -w '%{http_code}' -X POST "${CONTROL_PLANE_URL}/api/compute-agent-setup/poll" -H 'content-type: application/json' --data "$(jq -cn --arg code "$device_code" '{device_code:$code}')")" || true
    response="$(<"$response_file")"
    rm -f "$response_file"
    if [ "$http_status" = "200" ]; then break; fi
    if [ "$http_status" != "428" ]; then
      message="$(printf '%s' "$response" | jq -r '.error // "Authorization failed"' 2>/dev/null || true)"
      fail "$message"
    fi
    printf '.'
    sleep "$interval"
  done
  [ "${http_status:-}" = "200" ] || fail "The setup code expired before it was approved."

  compute_token="$(printf '%s' "$response" | json '.compute_agent_token')"
  compute_node_id="$(printf '%s' "$response" | json '.compute_node_id')"
  registered_url="$(printf '%s' "$response" | json '.control_plane_url')"
  enrollment_domains "$response" "$registered_url"
  printf ' approved.\n'
fi

if [ "$new_registration" = true ]; then
  s3_bucket="${SNAPSHOT_S3_BUCKET:-}"
  s3_region="${SNAPSHOT_S3_REGION:-eu-north-1}"
  storage_driver="local"
  [ -n "$s3_bucket" ] && storage_driver="s3"
fi

install -d -m 0755 "$INSTALL_DIR/infrastructure/compute-agent"
update_compute=false
update_preview=false
update_terminal=false
download_bundle_file() {
  local file="$1" affects="$2" downloaded
  downloaded="$(mktemp)"
  curl -fsS "${CONTROL_PLANE_URL}/install/bundle/${file}" -o "$downloaded" || {
    rm -f "$downloaded"
    fail "Could not download ${file}."
  }
  if [ ! -f "${INSTALL_DIR}/${file}" ] || ! cmp -s "$downloaded" "${INSTALL_DIR}/${file}"; then
    install -m 0644 "$downloaded" "${INSTALL_DIR}/${file}"
    case "$affects" in
      all) update_compute=true; update_preview=true; update_terminal=true ;;
      compute) update_compute=true ;;
      preview) update_preview=true ;;
      terminal) update_terminal=true ;;
    esac
  fi
  rm -f "$downloaded"
}

download_bundle_file compose.compute.yaml all
for file in Dockerfile LICENSE package.json package-lock.json; do
  download_bundle_file "infrastructure/compute-agent/${file}" all
done
for file in index.mjs executions.mjs execution-worker.py image-cleanup.mjs data-tunnel.mjs ssh-loopback.mjs tunnel-protocol.mjs docker-runtime.mjs runtime-probe.mjs snapshot-storage.mjs volume-storage.mjs; do
  download_bundle_file "infrastructure/compute-agent/${file}" compute
done
download_bundle_file infrastructure/compute-agent/resolve-access.mjs all
download_bundle_file infrastructure/compute-agent/persistent-terminal.mjs all
for file in preview-gateway.mjs preview-status-page.mjs; do
  download_bundle_file "infrastructure/compute-agent/${file}" preview
done
download_bundle_file infrastructure/compute-agent/web-terminal.mjs terminal
download_bundle_file infrastructure/compute-agent/agent-terminal.mjs terminal
download_bundle_file infrastructure/compute-agent/agent-sessions.mjs agent-sessions
download_bundle_file infrastructure/compute-agent/agent-connection.mjs terminal
download_bundle_file infrastructure/compute-agent/websocket-activity.mjs preview
download_bundle_file infrastructure/compute-agent/health.mjs none

if [ "$new_registration" = true ]; then
  umask 077
  cat > "${INSTALL_DIR}/.env.compute" <<EOF
CONTROL_PLANE_URL=${registered_url}
COMPUTE_AGENT_TOKEN=${compute_token}
COMPUTE_NODE_ID=${compute_node_id}
COMPUTE_AGENT_VERSION=0.1.0
DATA_GATEWAY_URL=${registered_url/http/ws}/api/tunnel/agent
DOCKER_RUNTIME=sysbox-runc
SANDBOX_NETWORK=driftverk-sandboxes
DRIFTVERK_EDGE_NETWORK=driftverk-edge
POLL_INTERVAL_MS=2000
TELEMETRY_INTERVAL_MS=15000
PREVIEW_GATEWAY_PORT=8081
PREVIEW_DOMAIN=${preview_domain}
WEB_TERMINAL_PORT=2223
PANEL_HOSTNAME=${panel_hostname}
SNAPSHOT_STORAGE_DRIVER=${storage_driver}
SNAPSHOT_S3_BUCKET=${s3_bucket}
SNAPSHOT_S3_REGION=${s3_region}
SNAPSHOT_S3_PREFIX=driftverk/snapshots
SNAPSHOT_S3_ENDPOINT=
SNAPSHOT_S3_FORCE_PATH_STYLE=false
SNAPSHOT_TEMP_DIR_HOST=/var/lib/driftverk/snapshot-tmp
VOLUME_STORAGE_DRIVER=${storage_driver}
VOLUME_S3_BUCKET=${s3_bucket}
VOLUME_S3_REGION=${s3_region}
VOLUME_S3_PREFIX=driftverk/volumes
VOLUME_S3_ENDPOINT=
VOLUME_S3_FORCE_PATH_STYLE=false
VOLUME_MOUNT_ROOT_HOST=/var/lib/driftverk/volumes
VOLUME_CACHE_ROOT_HOST=/var/lib/driftverk/volume-cache
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_SESSION_TOKEN=
EOF
elif ! grep -q '^DATA_GATEWAY_URL=' "${INSTALL_DIR}/.env.compute"; then
  printf '\nDATA_GATEWAY_URL=%s/api/tunnel/agent\n' "${registered_url/http/ws}" >> "${INSTALL_DIR}/.env.compute"
fi

install -d -m 0700 /var/lib/driftverk/snapshot-tmp /var/lib/driftverk/volume-cache
install -d -m 0755 /var/lib/driftverk/health
curl -fsS "${CONTROL_PLANE_URL}/install/watchdog" -o "${INSTALL_DIR}/watchdog.sh" || fail "Could not download the host watchdog."
bash -n "${INSTALL_DIR}/watchdog.sh"
chmod 0755 "${INSTALL_DIR}/watchdog.sh"
agent_version=$(curl -fsS "${CONTROL_PLANE_URL}/install/version") || fail "Could not retrieve agent version."
if ! grep -q '^HOST_HEALTH_FILE=' "${INSTALL_DIR}/.env.compute"; then
  printf '\nHOST_HEALTH_FILE=/host-health/status.json\n' >> "${INSTALL_DIR}/.env.compute"
fi
[[ "$agent_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Invalid agent version."
if grep -q '^COMPUTE_AGENT_VERSION=' "${INSTALL_DIR}/.env.compute"; then
  if [ "$(sed -n 's/^COMPUTE_AGENT_VERSION=//p' "${INSTALL_DIR}/.env.compute")" != "$agent_version" ]; then
    sed -i "s/^COMPUTE_AGENT_VERSION=.*/COMPUTE_AGENT_VERSION=${agent_version}/" "${INSTALL_DIR}/.env.compute"
    update_compute=true
  fi
else
  printf '\nCOMPUTE_AGENT_VERSION=%s\n' "$agent_version" >> "${INSTALL_DIR}/.env.compute"
  update_compute=true
fi
install -d -m 0755 /var/lib/driftverk/volumes
if command -v mountpoint >/dev/null && ! mountpoint -q /var/lib/driftverk/volumes; then
  mount --bind /var/lib/driftverk/volumes /var/lib/driftverk/volumes
fi
mount --make-rshared /var/lib/driftverk/volumes || fail "Could not enable shared mount propagation for volumes."
if command -v systemctl >/dev/null; then
  cat > /etc/systemd/system/driftverk-volume-mounts.service <<'EOF'
[Unit]
Description=Prepare shared mount propagation for Driftverk volumes
After=local-fs.target
Before=docker.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'mountpoint -q /var/lib/driftverk/volumes || mount --bind /var/lib/driftverk/volumes /var/lib/driftverk/volumes'
ExecStart=/bin/mount --make-rshared /var/lib/driftverk/volumes
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable driftverk-volume-mounts.service >/dev/null
  cat > /etc/systemd/system/driftverk-watchdog.service <<EOF
[Unit]
Description=Driftverk host health and bounded recovery
After=network.target

[Service]
Type=oneshot
Environment="DRIFTVERK_INSTALL_DIR=${INSTALL_DIR}"
ExecStart=/bin/bash "${INSTALL_DIR}/watchdog.sh"
TimeoutStartSec=150
EOF
  cat > /etc/systemd/system/driftverk-watchdog.timer <<'EOF'
[Unit]
Description=Check Driftverk host health every 15 seconds

[Timer]
OnBootSec=30
OnUnitInactiveSec=15
AccuracySec=1

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now driftverk-watchdog.timer >/dev/null
fi
docker network inspect driftverk-sandboxes >/dev/null 2>&1 || docker network create driftverk-sandboxes >/dev/null
docker network inspect driftverk-edge >/dev/null 2>&1 || docker network create driftverk-edge >/dev/null

cd "$INSTALL_DIR"
docker compose --env-file .env.compute -f compose.compute.yaml config --quiet
services=()
[ "$update_compute" = false ] || services+=(compute-agent)
[ "$update_preview" = false ] || services+=(preview-gateway)
[ "$update_terminal" = false ] || services+=(web-terminal)
if [ "${#services[@]}" -gt 0 ]; then
  docker compose --env-file .env.compute -f compose.compute.yaml up -d --no-deps --build "${services[@]}"
else
  printf 'Compute services are already current.\n'
fi
curl -fsS "${CONTROL_PLANE_URL}/install/agent-cli" -o "${INSTALL_DIR}/driftverk-agent" || fail "Could not download the Compute agent CLI."
install -m 0755 "${INSTALL_DIR}/driftverk-agent" /usr/local/bin/driftverk-agent

printf '\nInstallation complete.\n\n'
printf 'Continue in Driftverk: %s/hosts\nSnapshots use this server unless you configure S3 storage.\n' "$registered_url"
status "Compute agent" "$agent_name"
status "Node ID" "$compute_node_id"
status "Configuration" "$INSTALL_DIR/.env.compute"
printf '\nManage the installation with:\n  sudo driftverk-agent status\n  sudo driftverk-agent update\n  sudo driftverk-agent doctor\n\n'
