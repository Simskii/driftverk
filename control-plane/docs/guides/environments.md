# Lifecycle and storage

Stopping an environment preserves its files. Deleting it removes its writable filesystem. Choose the right storage before putting recoverable data in an environment.

## What survives?

| State | Stop and resume | Delete environment |
| --- | --- | --- |
| Writable environment files | Preserved in the same container | Removed |
| Running processes and memory | End on stop | End on deletion |
| Separately managed volumes | Retained | Retained separately |
| Existing snapshots and prebuilds | Retained separately | Retained separately |
| Stored execution output and artifacts | Retained under execution limits | Retained under execution limits |

A retained volume or local snapshot still depends on its host. Host loss is different from stopping or deleting one environment.

## Resume and access

Resume starts the same container. Preview, SSH and web-terminal access can wake an environment stopped automatically after inactivity. An explicit Stop keeps it stopped until you choose Start in the web interface or run `driftverk start <environment>`. The startup command runs again, followed by readiness checks. Processes launched only from an interactive shell do not restart automatically.

## Change environment size

An organization admin can change CPU and memory under **Settings → Size**. Stop the environment, choose a preset or custom limits, save, then start it again. Files and mounted volumes are preserved. The new limits apply on the next start, subject to host capacity. Disk storage is shared and has no per-environment size limit.

Compute hosts must run the updated Compute agent to apply changed limits to existing environments.

## SSH and Tailscale

In environment **Settings**, **Allow SSH connections** controls access through
Driftverk's SSH gateway. It starts enabled. Turning it off rejects new SSH
connections and closes existing gateway connections within a few seconds,
including forwarded ports. Logs and the web terminal remain available in the app.

The current Driftverk Dev image includes Tailscale, installed but logged out.
Choose **Set up Tailscale**, then **Authorize in Tailscale** to join your tailnet
without opening a terminal. Existing environments need Tailscale and Python 3
installed. Setup uses Tailscale SSH and your tailnet's access rules. It preserves
Driftverk SSH access so you can test Tailscale before turning the gateway off.

Tailscale only works while the environment is running. Its connections do not
reset auto-stop or wake a stopped environment. Disable auto-stop if you need
continuous access. Compute agent 0.2.1 or later resumes Tailscale when Driftverk
restarts a configured environment. Hybrid hosts can update with
`sudo driftverk-agent update`.

## Connect with the CLI

The native CLI supports macOS, Linux and Windows on Intel/AMD 64-bit and ARM64.
Python and WSL are not required. Connections use your system's OpenSSH client
(`ssh` and `ssh-keygen`).

On macOS or Linux, run this in your terminal. The installer requires `curl` and
`sha256sum` or `shasum`:

```bash
curl -fsSL https://app.driftverk.com/install/cli | sh
```

On Windows, run this in PowerShell:

```powershell
irm https://app.driftverk.com/install/cli.ps1 | iex
```

Windows installs into `%LOCALAPPDATA%\Driftverk\bin` and adds it to your user
PATH. Install the OpenSSH Client from Windows Optional Features if `ssh` or
`ssh-keygen` is missing. macOS and Linux install into `/usr/local/bin`, using
`sudo` when needed. Set `DRIFTVERK_BIN_DIR` to use another directory.

To update, rerun the installer for your platform, then run `driftverk version`.

The installer replaces the CLI executable and keeps your saved login and SSH key.
If you originally used `DRIFTVERK_BIN_DIR`, use the same directory when updating.
There is currently no `driftverk update` command.

Run `driftverk create`. Your browser opens for login or signup when needed.
Match the terminal code and approve the CLI. The command creates a personal
workspace if you have none and registers a dedicated SSH key automatically.
Your active organization is preserved. Use `driftverk org` to switch it.

Use `driftverk login --no-browser` on a remote machine and open the printed URL
on another device. Codes expire after ten minutes. The CLI stores a revocable
session token locally. Run `driftverk logout` to revoke it, or
`driftverk login` again when the session expires. The CLI never asks for your password.
You can also run `driftverk org` and `driftverk key` separately.

Run `driftverk create` inside a GitHub checkout to detect its `origin` repository
and name. The CLI checks whether your current branch exists on origin and uses
that remote branch. If it is not published, push it first or choose another remote
branch when prompted. Detached checkouts require `--branch` explicitly.

The environment clones from GitHub. It does not upload your local folder,
uncommitted changes, untracked files, or unpushed commits. The CLI reports local
changes and when your local commit differs from the remote branch. Use `--branch`
to explicitly select a remote branch and skip automatic branch inspection.

Before creating, review the organization, environment name, repository, branch,
and image. Outside a GitHub checkout, choose an empty environment or the example
app. Use `--empty` to skip repository detection and use the default Dev image,
or `--example` to start the example directly. The Dev image supplies development
tools; your repository is added separately during creation.

Creation waits for readiness, prints connection commands, and offers guided
agent, shell, or editor setup in an interactive terminal. Use `--no-connect` to
finish after creation, then `driftverk connect NAME` to resume guided setup.
Use `driftverk ssh NAME` for a direct shell or `driftverk ssh-config NAME` to
configure an SSH host for your editor.

The dedicated key is stored under `$XDG_CONFIG_HOME/driftverk/id_ed25519`,
or `~/.config/driftverk/id_ed25519`. Existing SSH keys are left in place.
Use `driftverk setup` to prepare access without creating an environment,
or `driftverk create --no-browser` to print the login URL on a remote machine.
Connect to an environment by name:

```bash
driftverk ssh api
```

Run a single command by adding it after `--`:

```bash
driftverk ssh api -- npm test
```

Run `driftverk cost` for your organization's balance and current hourly usage.
Stopped environments can still incur storage charges.

Run `driftverk fork api experiment` to capture a snapshot and start a separate
environment from it. The snapshot is retained in the dashboard and may incur
storage charges. Mounted volumes and running processes are not cloned.

If your key can access the same environment name in more than one organization,
qualify it as `organization/environment`.

Use **Sign out** before capturing a snapshot so the snapshot cannot copy the
environment's tailnet identity. The base image contains no Tailscale login state.

## Preview ports

Set an optional default port under **Ports and preview** when creating an environment, or change it later in **Settings**. Use the port inside the environment, such as `3000` or `5173`. The app must listen on `0.0.0.0`.

Without a default, Driftverk uses a detected listener on a common web port. If none is found, choose a port from the **Ports** tab. Preview links expire after one hour and can be opened by anyone with the full link. Setting a default does not start a service or restrict which ports can be previewed.

## Automatic cleanup

Auto-stop measures inactivity from preview, terminal and SSH traffic. Tracked executions and current protected web agent sessions keep an environment running. Web agent protection has a one-hour deadline and a renewable host lease; see [Agents](/docs/agents). Background CPU or disk activity alone does not prevent auto-stop; disable it for quiet jobs launched directly through SSH.

Auto-delete measures total lifetime and can delete a running environment, but waits for queued or running tracked executions. Explicit deletion can request cancellation and queue container removal. Cleanup needs the assigned compute host to be online.

Auto-archive is not implemented. The API's `disk_gb` field does not enforce a filesystem quota; environments share host storage.

## Snapshots and prebuilds

Snapshots capture filesystem state, not process memory or mounted volumes. Local snapshots restore on the same host. S3 snapshots can restore on another host with compatible storage settings.

New snapshots also save startup and readiness commands, their working directory, CPU and memory limits, and preview settings. These defaults belong to the snapshot and do not change when its source environment changes. Review them when launching a separate environment. Clone, install, and data initialization commands are not inherited. Configure variables and volume mounts for the new environment.

Older snapshots remain usable but have no saved launch defaults. Enter the working directory and startup command if the app needs them.

Snapshots can retain runtime variables and credentials already present in the container or written to files. Only capture them when copying that state is intentional. Prefer a clean project prebuild for reusable dependencies and inject variables into each new environment.

A filesystem snapshot is not necessarily an application-consistent database backup. Use the database's backup and restore tools for important data, including databases running inside Compose.

## Command results

Tracked executions retain stdout, stderr and declared artifacts independently of the environment. Output is limited to 1 MiB per stream. Declare up to four regular-file artifacts, each at most 128 KiB.

The control plane retains up to 1,000 executions per organization. Completed records older than seven days are removed when a new execution is submitted. Explicit execution deletion removes its stored output and artifacts. Export results you need to keep.

## Billing while stopped

For Cloud, CPU and memory charges stop on an acknowledged stop or deletion. Storage can remain billable while an environment is stopped, and separately retained storage can outlive it. Setup and initialization run on compute and can be billable; failed setup may leave that compute running.

Hybrid customers maintain and pay for their own hosts. Stopping an environment does not cancel the host provider's bill. Use the organization's Billing page for its current plan and rates.

## Member access

Organization admins can access every environment. Organization creators use the admin role. Members can create one personal environment when member creation is enabled. Access to that environment is assigned automatically. They can also access environments an admin assigns to them.

In **Team**, select **Manage access** for a member and select their environments. You can also manage the members of an environment in its settings. Changes save immediately. Accept an invitation before assigning access. New members and new environments have no member assignments by default.

Personal SSH keys identify their owner. The same key works across that user's assigned environments. Environment lists, direct environment requests, telemetry, SSH, web terminal, personal MCP reads, execution output and artifacts follow these assignments. Members can start, stop, and delete their personal environment. Only admins manage assigned environments and organization configuration. Personal MCP connections for members expose read operations for accessible resources; organization API keys remain admin-managed automation credentials and stop authenticating if their issuing user loses admin membership.

Removing an assignment blocks new Driftverk connections, including SSH and terminal tickets issued before removal. Existing sessions must be closed separately. Personal preview links created after this change are checked against the issuer's current access. Older preview links and organization automation links retain their existing expiry behavior. Tailscale connections follow the tailnet's access rules.

Migration `0045_environment_members.sql` creates the assignment table. It does not grant existing members automatic access; admins must assign their environments. Apply the migration with the control-plane release. No compute-agent or gateway restart is required for this control-plane change.

### Personal environments for members

Each member can create one personal environment per workspace, from the browser
or `driftverk create --empty`. Repository creation is also supported. Stopped,
failed, and deleting environments count until deletion finishes. Environments
assigned by an admin do not consume this allowance.

In **Team → Member environments**, admins can disable member creation and choose
the CPU and memory for new personal environments. Creation is enabled by default,
using Driftverk Dev, 1 vCPU, 2 GB memory, 40 GB disk, and 15-minute auto-stop.
The workspace pays for usage. Changing these settings does not resize or remove
existing environments. Custom images, snapshots, shared mounts, organization
secrets, and organization agent credentials remain admin-controlled. Members can
connect an agent themselves after creation.

The CLI shows **Driftverk Dev** for the maintained image instead of its registry
reference. Explicit custom images retain their reference in the summary.
Migration `0049_member_self_service.sql` adds the policy and a database-enforced
one-environment limit. Existing environments are not automatically classified as
personal environments.

## CLI commands

Create from your current GitHub checkout, an explicit repository, an image,
or a snapshot. A repository can be combined with a custom image:

```sh
driftverk create
driftverk create scratch --empty
driftverk create demo --example
driftverk create api --repository owner/repo --branch main
driftverk create api --repository owner/repo --image node:24 --branch main
driftverk create api --image node:24
driftverk create api --snapshot SNAPSHOT_ID
driftverk connect api
driftverk ssh api
driftverk ssh api -- npm test
driftverk ssh-config api
driftverk ls
driftverk logs api
driftverk stop api
driftverk start api
driftverk fork api experiment
driftverk cost
driftverk whoami
driftverk org
driftverk preview api --port 3000
driftverk browser api
driftverk desktop api
driftverk desktop api --stop
driftverk prompt api "Test checkout in the open browser" --record --output checkout.mp4
driftverk delete api
driftverk version
```

`browser`, `desktop` and `prompt` require a desktop-enabled image. They share the
environment's Chromium session; `prompt --record` saves an MP4 of the agent task.
See [Browser and desktop](/docs/desktop) for prerequisites, flags and recovery.

New Driftverk Dev images include these tools; older environments are unchanged.
The desktop stops after five minutes without viewers or a managed prompt.
`desktop --stop` stops only desktop services. `driftverk stop api` stops the whole
environment. A persistent browser profile and recordings remain on disk, and
snapshots can copy them. Review them before sharing a snapshot.

`--image` by itself creates an environment without cloning your current repository.
`--branch` requires an explicit or detected repository. When using `--repository`
without `--branch`, GitHub's default branch is used. `--snapshot` and `--example`
cannot be combined with `--image`.

For an already authenticated noninteractive session, pass `--yes` to accept the
creation summary. If no GitHub repository is detected, an explicit source is
required. `--yes` never silently falls back from an unpublished branch.

```sh
driftverk create api --repository owner/repo --branch main --yes --no-connect
```

Private repository creation requires a connected GitHub account. Automatic
branch inspection also requires local Git access to origin; `--branch` selects
a remote branch explicitly without that inspection. Logs show recent entries.
Create follows progress until the environment is ready. Other lifecycle commands
queue operations; use `ls` to check completion.

Cancelling the creation summary creates no environment. After creation has been
submitted, Ctrl+C stops the CLI wait, not the environment. Check `driftverk ls`
and `driftverk logs NAME` before retrying. When ready, run `driftverk connect NAME`.
If the name already exists, connect to it or choose another name. Remove an
unwanted environment with `driftverk delete NAME`; deletion requires typing its
name. Failed setup may leave billable compute running.

Preview prints a bearer link with its expiry. API commands operate in the
organization selected with `driftverk org`. `driftverk cost` shows organization
billing information; stopped environments can still incur storage charges.
