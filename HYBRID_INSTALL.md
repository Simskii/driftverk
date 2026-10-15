# Install Driftverk compute in a customer environment

This guide installs a customer-owned Driftverk compute host while the control plane remains hosted by Driftverk. Environments execute on the customer's Linux host. Snapshots start on local disk; private S3-compatible storage can be configured later.

To run the control plane on your own domain too, follow [Self-hosting Driftverk](SELF_HOSTING.md). The enrollment installer uses the domains returned by that control plane.

An organization can connect multiple compute hosts. Install one Compute agent stack per dedicated host. Environments stay on their assigned host; adding a host does not migrate existing containers.

## Health and recovery

The current Compute agent reports Docker connectivity, Sysbox socket availability, gateway HTTP health and data-tunnel connectivity every 15 seconds. The host watchdog runs independently through `driftverk-watchdog.timer`. It checks Docker, Sysbox and the three installed Compose services. New jobs wait while any required check fails or a health report becomes stale. Existing jobs are not cancelled.

Compute hosts and environment details show each host's latest checks, recovery messages, report time and agent version. These are shared host checks, not continuous application-readiness tests. Version information shows the version served by the control plane and the `sudo driftverk-agent update` command; updates are run on the host, not remotely from the portal.

The watchdog starts failed Docker units and restarts failed Sysbox through its top-level unit only when no Sysbox containers are running. It never restarts a running Docker daemon. It restarts unhealthy infrastructure containers by their exact Compose container ID; stopped services are left stopped. Docker's existing `unless-stopped` policy handles crashed container processes. A silent tunnel connection is terminated and reconnected automatically. Stop and delete jobs remain available when Docker is healthy; new starts, snapshots and command executions wait for recovery.

Recovery is limited to three attempts per service, with increasing delays. The budget persists across watchdog restarts. Inspect `journalctl -u driftverk-watchdog.service` and `/var/lib/driftverk/health/status.json` when intervention is required. After correcting the cause, remove only that service's `.retry` file in `/var/lib/driftverk/health/` to grant a new recovery budget. Stopped environment containers are never automatically resumed by the watchdog.

Deploy control-plane migration `0029_compute_health.sql` and the new server before updating agents. The installer installs and enables the host watchdog and configures `HOST_HEALTH_FILE`. Manually managed Compose installations must install the watchdog to enable host recovery. Without `HOST_HEALTH_FILE`, agents still run their own dependency checks but cannot repair host systemd services. Portal health reporting currently covers Hybrid hosts.

## Guided installation

For a clean customer host running Ubuntu 22.04 or 24.04 on amd64, run:

```bash
curl -fsSL https://app.driftverk.com/install/agent | sudo bash -s --
```

Choose Hybrid when creating the organization, or choose **Use my own servers** in **Settings** before connecting hosts or creating environments. The installer adds `jq`, Docker Engine, Docker Compose v2, and the pinned Sysbox runtime when they are missing. It never removes conflicting Docker packages and will not install Sysbox while existing containers are present. It uses the server hostname and shows a ten-minute code and a link to `app.driftverk.com/connect`. A workspace administrator signs in and approves the connection. The permanent Compute agent token is returned directly to the installer and stored in `/opt/driftverk/.env.compute` with restricted permissions.

Keep the installer running until it reports completion. The browser approves enrollment; the command on the host downloads, configures, and starts the Compute agent stack.

If teams will run Compose projects, also test a repository with a root `compose.yaml`. Driftverk starts Docker inside the Sysbox environment without exposing the host Docker socket. Confirm that all services start, health checks pass, and published HTTP ports appear in the environment. The host uses Docker Compose v2 to manage Driftverk infrastructure. The current development environment uses Docker Compose v1 for the nested repository project, so projects that require v2 features need a compatible custom image. A successful host `docker compose` command does not verify nested Compose inside a customer environment.

New installs default to local snapshot storage and ask no storage questions. Local snapshots depend on retaining that server. Configure S3 later using the settings below, then run `sudo driftverk-agent restart`. Existing installations keep their storage configuration when updated.

To inspect the installer before running it, download it to a file first:

```bash
curl -fsSL https://app.driftverk.com/install/agent -o driftverk-agent-install.sh
less driftverk-agent-install.sh
sudo bash driftverk-agent-install.sh
```

Running the installer again reuses the existing local Compute agent identity and refreshes the version-matched compute files. The manual procedure below remains useful for troubleshooting and installations that cannot download files from the control plane.

The installer also adds `/usr/local/bin/driftverk-agent`:

```bash
sudo driftverk-agent status
sudo driftverk-agent update
sudo driftverk-agent logs
sudo driftverk-agent restart
sudo driftverk-agent doctor
```

`update` and `restart` recreate only the Compute agent services. Environment containers run independently in Docker and remain running while the agent reconnects.

When moving an existing installation from direct SSH to the central tunnel, deploy the central data gateway and add `SSH_TOKEN_SECRET` first. Then run `sudo driftverk-agent update`. Compose leaves the retired local `ssh-gateway` container running as a fallback. After a central SSH session has passed, close the customer's inbound port 2222 and remove the orphan with:

```bash
sudo docker compose --env-file /opt/driftverk/.env.compute -f /opt/driftverk/compose.compute.yaml up -d --remove-orphans
```

## Architecture and responsibility

```text
Driftverk control plane
  -> authenticated compute jobs over HTTPS
Customer compute host
  -> Docker + Sysbox sandbox runtime
  -> snapshot OCI image cache
  -> customer-owned S3 bucket (durable snapshot source)
```

The compute agent receives lifecycle jobs but does not receive database credentials for the control plane. The customer owns the compute host, its Docker daemon, snapshot bucket, encryption policy, access logs, and retention policy.

This is an installation-wide configuration. One compute deployment uses one snapshot bucket and credential identity. Do not use one customer's credentials in a shared multi-customer compute process.

The control plane issues an organization-bound Compute agent token. It is shown once, stored only as a hash by Driftverk, and limits job claims to the selected organization. The customer's S3 credentials remain on the compute host.

The Compute agent also opens an outbound WebSocket to Driftverk's central data gateway. Preview HTTP, web-terminal, and SSH sessions return over that connection, so ports 2222, 8081, and 2223 stay private.

## 1. Prerequisites

Prepare a clean, dedicated Ubuntu 22.04 or 24.04 amd64 host with:

- `curl`, `sudo`, and systemd. The guided installer adds Docker Engine, Docker Compose v2, `jq`, and Sysbox when needed.
- Enough local disk for the Docker image plus temporary uncompressed and compressed snapshot archives. Budget at least twice the largest expected snapshot in the configured snapshot temporary directory.
- Outbound HTTPS to the Driftverk control plane, the customer's S3 endpoint, and required OCI registries.
- No inbound product ports. Preview, web-terminal, and SSH traffic use the outbound data tunnel. Individual sandbox ports must remain private.

The workspace administrator chooses **Hybrid** during organization creation, then opens **Compute hosts** and runs the installation command on each server. Platform administrator access is not required. The manual token configuration below is for troubleshooting existing installations; guided enrollment delivers the token directly to the server.

Choose the hosting mode before creating the organization's first environment. Moving existing environments between Driftverk-managed and customer-managed hosts requires a separate migration workflow and is therefore blocked by the admin interface.

The generated values include:

- `CONTROL_PLANE_URL`
- An organization-bound, one-time `COMPUTE_AGENT_TOKEN`
- The assigned `COMPUTE_NODE_ID`
- The assigned preview domain and panel hostname

The generated node ID and token belong together. Do not change the node ID or reuse the token for another organization.

## 2. Create the S3 bucket and access policy

Create a private bucket in the customer's account. Enable default encryption and block public access. Object versioning is recommended when the provider supports it.

Grant the compute identity access only to the selected Driftverk prefixes. Volumes need list, read, write and delete access because developers can change files through the mounted directory. For AWS S3, a suitable policy is:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:AbortMultipartUpload",
        "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::CUSTOMER_BUCKET/driftverk/snapshots/*",
        "arn:aws:s3:::CUSTOMER_BUCKET/driftverk/volumes/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::CUSTOMER_BUCKET",
      "Condition": {
        "StringLike": {
          "s3:prefix": [
            "driftverk/snapshots/*",
            "driftverk/volumes/*"
          ]
        }
      }
    }
  ]
}
```

On AWS, prefer an EC2 instance role so long-lived access keys are not stored in the environment file. For another S3-compatible provider, create a dedicated access key limited to the bucket and prefix.

Do not configure an automatic bucket lifecycle deletion policy yet. Deleting an object that is still referenced by the control plane makes that snapshot unrestorable. Retention coordination is a separate feature.

## 3. Prepare the host

Copy this repository or the supplied deployment bundle to the host. From the `driftverk-panel` directory, create the private sandbox and edge networks if they do not already exist:

```bash
docker network create driftverk-sandboxes
docker network create driftverk-edge
sudo install -d -m 700 /var/lib/driftverk/snapshot-tmp
sudo install -d -m 700 /var/lib/driftverk/volume-cache
sudo install -d -m 755 /var/lib/driftverk/volumes
mountpoint -q /var/lib/driftverk/volumes || sudo mount --bind /var/lib/driftverk/volumes /var/lib/driftverk/volumes
sudo mount --make-rshared /var/lib/driftverk/volumes
```

The Driftverk default edge network is `driftverk-edge`. It connects the Compute agent stack internally and does not require a reverse proxy on a hybrid host.

Copy the environment template and restrict it to the host administrator:

```bash
cp .env.compute.example .env.compute
chmod 600 .env.compute
```

## 4. Configure the compute node

Set the control-plane and runtime values in `.env.compute`:

```dotenv
CONTROL_PLANE_URL=https://app.driftverk.com
COMPUTE_AGENT_TOKEN=dvr_replace-with-the-one-time-agent-token
COMPUTE_NODE_ID=agent_replace-with-the-generated-id
COMPUTE_AGENT_VERSION=0.2.0
DOCKER_RUNTIME=sysbox-runc
SANDBOX_NETWORK=driftverk-sandboxes
DRIFTVERK_EDGE_NETWORK=driftverk-edge

PREVIEW_DOMAIN=preview.app.driftverk.com
PANEL_HOSTNAME=app.driftverk.com
```

Enable customer-owned snapshot storage:

```dotenv
SNAPSHOT_STORAGE_DRIVER=s3
SNAPSHOT_S3_BUCKET=customer-driftverk
SNAPSHOT_S3_REGION=eu-north-1
SNAPSHOT_S3_PREFIX=driftverk/snapshots
SNAPSHOT_TEMP_DIR_HOST=/var/lib/driftverk/snapshot-tmp

VOLUME_STORAGE_DRIVER=s3
VOLUME_S3_BUCKET=customer-driftverk
VOLUME_S3_REGION=eu-north-1
VOLUME_S3_PREFIX=driftverk/volumes
VOLUME_MOUNT_ROOT_HOST=/var/lib/driftverk/volumes
VOLUME_CACHE_ROOT_HOST=/var/lib/driftverk/volume-cache
```

For AWS with an instance role, leave `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` empty.

For an S3-compatible provider, also configure its endpoint and credentials:

```dotenv
SNAPSHOT_S3_ENDPOINT=https://objects.customer-provider.example
SNAPSHOT_S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=replace-with-scoped-access-key
AWS_SECRET_ACCESS_KEY=replace-with-scoped-secret-key
```

Some providers support virtual-host addressing and should use `SNAPSHOT_S3_FORCE_PATH_STYLE=false`. Use the setting documented by the customer's storage provider.

Never commit `.env.compute`, copy it into an image, or send it to the control plane.

## 5. Start the customer compute deployment

Validate the rendered Compose model, then build and start the services:

```bash
docker compose --env-file .env.compute -f compose.compute.yaml config --quiet
docker compose --env-file .env.compute -f compose.compute.yaml up -d --build
docker compose --env-file .env.compute -f compose.compute.yaml ps
```

Inspect the compute-agent log without publishing the environment file:

```bash
docker compose --env-file .env.compute -f compose.compute.yaml logs --tail=100 compute-agent
```

A healthy agent logs `compute_agent_started`, begins polling with its configured node ID, and appears as **Connected** in Driftverk Cloud within a minute. Authentication errors indicate a control-plane URL, token, revoked Compute agent, or node-ID mismatch. S3 configuration errors stop the compute agent immediately instead of silently falling back to local storage.

## 6. Prove snapshot and cross-host restore

Do not consider the installation complete after the containers merely start. Perform this drill:

1. Create an environment from a clean OCI image.
2. Add a uniquely named file inside the environment.
3. Create a snapshot in Driftverk and wait until its state is `Ready`.
4. Confirm that a `.oci.tar.gz` object exists under the configured bucket prefix and is private.
5. Record the object size and confirm its metadata contains `sha256`.
6. Remove the corresponding local `driftverk/snapshot-...` Docker image from the compute host, or use a second compute host configured for the same customer bucket.
7. Create a new environment from the snapshot.
8. Confirm that the unique file exists and that the restored environment starts successfully.
9. Review the compute-agent log for checksum, download, Docker load, or permission errors.

This proves upload, durable storage, download, checksum verification, Docker image loading, and environment creation. A successful upload alone is not restore proof.

## Snapshot behavior and limitations

- A Driftverk snapshot is an immutable OCI/Docker image captured with a brief container pause.
- S3 is the durable source; the Docker image store may retain a local cache.
- Restore accepts only objects in the configured bucket and prefix.
- The control plane's artifact reference carries the SHA-256 checksum, and every downloaded archive plus its object metadata must match it before Docker loads the image.
- Docker commit does not include host-mounted volumes. Back up those volumes separately.
- Pausing and committing a container is filesystem-crash-consistent, not automatically application-consistent. Quiesce databases or use their native backup tools before relying on a snapshot for database recovery.
- Snapshot object deletion and coordinated retention are not implemented in this installation slice.

## Updating or stopping the node

Before updating, check that no compute job is running. Rebuild from the approved Driftverk version:

```bash
docker compose --env-file .env.compute -f compose.compute.yaml up -d --build
```

To stop the node without deleting Docker images or snapshot objects:

```bash
docker compose --env-file .env.compute -f compose.compute.yaml down
```

Stopping the node makes its environments unavailable until the node returns. It does not remove customer data from S3.

## Multiple compute hosts

Run one compute-agent stack per dedicated host. Do not run several compute-agent processes against the same Docker socket.

Deploy the control plane and its `0022_multi_host.sql` migration before updating agents or connecting additional hosts. Existing host identities and environment assignments are preserved.

Choose a host when creating an environment, or leave **Automatic** selected. Updated agents report CPU and RAM; new creates and starts wait until those resources fit alongside existing reservations. This is admission control for Driftverk environments, not disk quota enforcement or accounting for unrelated host workloads. Older agents without capacity reports retain legacy behavior, so update all hosts before relying on capacity checks.

First claim fixes the environment's host. An offline host's existing environments wait for it to reconnect; they are never silently moved. Preview, terminal and SSH use the environment's node-bound gateway route. Stop and delete remain available even when a host is at capacity.

Local snapshots restore on their source host. Cross-host S3 restore requires matching endpoint, region, bucket and prefix configuration, reported by updated agents as a non-secret fingerprint. Snapshots captured before this metadata was available remain on their source host until recaptured. Volume mounts remain pinned to one host, including S3-backed volumes, because cross-host writable volume coordination is not implemented.

Removing a host from **Compute hosts** revokes its identity but does not uninstall software or erase files. The operation is blocked while the host owns environments, local snapshots or volumes. Host failure recovery and automatic migration are separate operations.
