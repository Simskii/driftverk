# Driftverk compute agent

The compute agent runs on a Linux host with Docker. It claims persisted jobs from the Driftverk control plane, reports container metrics, and owns the local container lifecycle. Environments with auto-stop enabled are stopped by the control plane after no authenticated preview, terminal or SSH activity for the configured period, provided no tracked execution is queued or running. CPU and I/O metrics do not reset this timer. Preview WebSocket ping/pong and SSH keepalives do not count. Quiet untracked jobs require auto-stop to be disabled. Before stopping, the agent requests final authorization from the control plane, then sends SIGTERM with a 30-second grace period. Deploy the control plane before updating agents.

The compute agent supports public and private OCI image sources. It captures filesystems as OCI images and can restore from the local Docker image store or from compressed, checksummed archives in an S3-compatible bucket. Local storage is intended for development; customer hybrid installations should use S3 as the durable source.

Every 15 minutes the agent runs an image janitor. It removes dangling layers older than seven days, expires temporary snapshot and restore directories after one hour, and removes old tagged Driftverk snapshot images only after the control plane confirms that no environment or local snapshot record needs them. Active snapshot transfers are excluded from temporary cleanup. With S3 snapshot storage, old unused images are evicted from the local cache and can be restored again. The janitor does not remove images used by any container and does not run a blanket Docker system prune.

The Compute agent accepts node-bound SSH session tickets over its outbound data tunnel and attaches accepted sessions to the selected local environment container. The customer host does not publish a product SSH port.

## Run locally

Create a shared token and add it to the control-plane `.env` as `COMPUTE_AGENT_TOKEN`. Then run:

```bash
CONTROL_PLANE_URL=http://localhost:3000 \
COMPUTE_AGENT_TOKEN=replace-with-the-same-token \
COMPUTE_NODE_ID=local-docker-1 \
node infrastructure/compute-agent/index.mjs
```

The agent uses the normal Docker runtime by default. On a prepared Linux host, set `DOCKER_RUNTIME=sysbox-runc` to create system containers without privileged Docker-in-Docker:

```bash
DOCKER_RUNTIME=sysbox-runc SANDBOX_NETWORK=driftverk-sandboxes node infrastructure/compute-agent/index.mjs
```

Do not describe the default Docker runtime as a nested-Docker security boundary. The production host must install and validate Sysbox, or use a dedicated-kernel runtime such as Kata.

For the dedicated compute EC2 instance, the preferred process is the repository's separate Compose project:

```bash
cp .env.compute.example .env.compute
docker compose --env-file .env.compute -f compose.compute.yaml up -d --build
```

The compute-agent container mounts the Docker socket and therefore has root-equivalent control of the compute host. Do not run the control plane, PostgreSQL, or unrelated workloads on that host.

Private registry credentials exist in memory only while the agent logs in and pulls the image. It uses a temporary Docker config directory and deletes it after the pull.

Snapshot S3 credentials remain on the compute host. See [`../../HYBRID_INSTALL.md`](../../HYBRID_INSTALL.md) for bucket permissions, environment variables, installation, and the required cross-host restore drill.

The SSH host key lives in the Go SSH gateway's `ssh-host-keys` volume. The SSH frontend routes channels through the central data gateway to compute agents. User private keys never leave their computers. See [SSH gateway operations](../ssh-gateway/README.md).
