# Hybrid installation

Run environments on your own dedicated Linux host while Driftverk handles accounts, configuration and lifecycle jobs. Install one agent stack per host; adding hosts does not migrate existing environments.

## Requirements

Prepare a clean Ubuntu 22.04 or 24.04 amd64 VPS with `curl`, `sudo` and systemd. The installer adds jq, Docker Engine, Docker Compose v2 and the pinned Sysbox runtime when needed.

Allow outbound HTTPS to `app.driftverk.com`, Docker's package repository, GitHub Releases, required OCI registries and your S3 endpoint if used. Preview, terminal and SSH traffic use an outbound data tunnel; keep environment ports private.

Allow disk space for images, writable environments and temporary snapshot archives. Budget at least twice the largest snapshot for snapshot temporary storage.

## Install and authorize

Choose Hybrid for your organization, or choose **Use my own servers** in **Settings**. On the dedicated VPS, run:

```bash
curl -fsSL https://app.driftverk.com/install/agent | sudo bash -s --
```

The installer displays a ten-minute code and an authorization URL. Open it, sign in as an administrator, verify the organization and host, and approve the connection. Keep the installer running until it reports completion.

It will not remove conflicting Docker packages or install Sysbox while existing containers are present. Resolve those conditions on the intended dedicated host before retrying.

The host configuration is `/opt/driftverk/.env.compute`. It contains the agent token and may contain S3 credentials. Keep it private.

## Verify the host and an environment

```bash
sudo driftverk-agent status
sudo driftverk-agent doctor
```

Check that the services run, Docker and Sysbox checks pass, and the host appears connected in Compute hosts. Then create an environment, run a terminal command, open an HTTP preview and test SSH if your team uses it.

For Compose projects, test a repository with a root Compose file and verify its services and health checks. Host health alone does not prove those paths work.

## Durable snapshots

Snapshots begin on local disk and depend on keeping that host. To use a private S3 bucket, set these values in the host configuration and restart the agent:

```dotenv
SNAPSHOT_STORAGE_DRIVER=s3
SNAPSHOT_S3_BUCKET=your-private-bucket
SNAPSHOT_S3_REGION=eu-north-1
SNAPSHOT_S3_PREFIX=driftverk/snapshots
```

Prefer an instance role on AWS. Other S3-compatible providers also need `SNAPSHOT_S3_ENDPOINT` and scoped AWS access credentials in the host configuration.

Use the same endpoint, region, bucket and prefix on hosts sharing snapshots. Existing local snapshots do not move automatically; capture new snapshots after changing storage. Volumes stay attached to their original host.

Test recovery by creating a file in a clean environment, taking a snapshot, restoring a separate environment and reading the file. To verify S3 recovery independently of local cache, restore on another compatible host.

## Updates and recovery

```bash
sudo driftverk-agent logs
sudo driftverk-agent update
sudo driftverk-agent restart
sudo driftverk-agent doctor
```

Update and restart recreate the Compute services; environment containers run independently and stay running while the agent reconnects. Keep agents current with the control plane, especially before using new execution or storage features.

The host watchdog performs bounded recovery attempts. Inspect host checks in Compute hosts and run:

```bash
sudo journalctl -u driftverk-watchdog.service --no-pager -n 100
```

Resolve the reported cause before restarting services repeatedly. See [Troubleshooting](/docs/troubleshooting).

## Responsibilities and removal

You maintain the Linux host, Docker, host capacity, bucket permissions, backups and retention. Driftverk operates the hosted control plane and delivers authenticated jobs and access connections. S3 credentials remain on your host.

Before disconnecting or replacing a host, export needed data and restore-test snapshots. Stop or delete its environments while it can still acknowledge jobs. Revoking an agent connection does not erase the customer's server or its data.
