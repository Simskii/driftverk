# Driftverk

For an independent installation, start with [Self-hosting](SELF_HOSTING.md).
Driftverk-owned code is MIT licensed. Bundled third-party software keeps its own
terms; see [Third-party software](THIRD_PARTY.md).

Driftverk is a control plane for isolated development environments and coding agents. An environment starts from an OCI image, runs as a system container on dedicated compute, and can later be captured as a reusable filesystem snapshot.

The first use case is parallel work in a monorepo. Alice, Bjorn, and multiple agents should be able to work at the same time without sharing filesystems, databases, ports, or nested Docker state.

## Product model

```text
OCI image -> isolated sandbox -> filesystem snapshot -> new sandbox
```

- An **image** is a clean OCI/Docker source. Driftverk defaults to `driftverk-dev:1`, a development image with Node.js 22, Git, Corepack, Python, build tools, SSH client, and Docker. Each Compute agent builds and caches this image on first use. `DEFAULT_SANDBOX_IMAGE` can select another image.
- A **sandbox** is a running development container. The user can optionally choose a GitHub repository and a setup command before creating it. GitHub and Docker Compose remain optional.
- A **snapshot** is a captured sandbox filesystem that can create more sandboxes with the same tools and files from its writable filesystem. Mounted volumes and process memory are not captured; nested Docker data requires separate validation on the chosen Sysbox host.
- A **project prebuild** installs a saved project setup in a fresh builder, pins its GitHub commit, and captures the filesystem before runtime variables, initialization commands, startup services or volume mounts. New environments reuse that snapshot and initialize their own data.
- Docker Compose is useful *inside* a sandbox when a project needs several services. It is not Driftverk's source model.

The MVP exposes only the container runtime class. Production compute is intended to use Sysbox so a sandbox can run its own Docker daemon without being a normal privileged Docker-in-Docker container. VM runtimes can be added behind the same control-plane contract later.

## Deployment architecture

The live control plane runs as a Docker Compose project behind Dokploy Traefik. Compute remains a separate Compose project and moves to a dedicated or customer-owned host for production use:

```text
Internet
  -> Dokploy Traefik (HTTPS)
      -> React SPA + Node.js/Hono JSON API
          -> Better Auth
          -> Resend
          -> PostgreSQL
          -> leased compute-job API

Compute host
  -> Driftverk Compute agent
      -> Docker Engine + Sysbox
          -> isolated sandbox containers
              -> nested Docker workloads
```

The control-plane host owns HTTP, authentication, product state, and the job queue. The compute host owns Docker and sandbox lifecycle. The web app never receives the Docker socket, and the Compute agent never receives database credentials. It talks to the control plane over HTTPS with an organization-bound bearer token.

Cloudflare can remain DNS, proxy, WAF, and DDoS protection, but it is not required to run the application.

The current internal compute test runs on the control-plane VPS with the standard `runc` runtime. This proves the queue and container lifecycle, but not the intended isolation boundary. PostgreSQL currently runs on the control-plane host. Add and test its backup and restore procedure before the database becomes business-critical.

## Implemented in this slice

- Docker Compose control plane with Caddy, Node.js/Hono, PostgreSQL, and health checks.
- Better Auth email/password accounts, email verification, sessions, sign-out, and password reset.
- Resend delivery in production and console email previews in local development.
- A React control panel for environments, snapshots, OCI registries, detected ports, logs, and metrics.
- A platform-admin customer overview with primary contact, account age, environment activity, environment health, hosting mode, and Compute agent status.
- Image and ready-snapshot source selection when creating an environment.
- Optional auto-generated environment names, encrypted environment variables, and persisted lifecycle policies.
- Hot filesystem snapshot capture with a brief container pause, plus restore from local OCI images or checksummed OCI archives in customer-owned S3-compatible storage.
- Runtime detail tabs for lifecycle logs, metrics, ports, and an authenticated interactive web terminal.
- Encrypted private-registry credentials used only by the trusted compute agent.
- PostgreSQL-backed leased compute jobs with progress, retry, and failure reporting.
- A separate compute agent that can create, start, stop, and delete OCI sandboxes through Docker.
- A strict browser content security policy and origin checks on product mutations.
- An organization-scoped bearer API for environment lifecycle operations, with idempotency and audit records.
- Durable command executions with separate stdout/stderr, cursor replay and SSE, exit codes, cancellation, bounded artifacts, and a local Node.js SDK in [`sdk/`](./sdk/README.md).
- Project setup creation, replacement and deletion through API, MCP and SDK, plus prebuild lookup by ID. Scripts can define a project, build it and create working environments without using the panel.
- A stateless Streamable HTTP MCP server at `/mcp`, with OAuth 2.1 for ChatGPT and bearer API keys for other customer AI clients.

The public API guide is in [`control-plane/docs/api.md`](./control-plane/docs/api.md). Its OpenAPI 3.1 contract is in [`control-plane/docs/openapi.yaml`](./control-plane/docs/openapi.yaml). The running control plane serves them at `/v1/docs` and `/v1/openapi.yaml`.

To install the Compute agent on a customer-owned VPS, follow [`HYBRID_INSTALL.md`](./HYBRID_INSTALL.md). The same guided procedure is available in the control-plane documentation under **Hybrid installation**.

Organization creation includes a Cloud or Hybrid choice. Workspace admins can connect multiple dedicated hosts from **Compute hosts** without platform-admin intervention. The installer defaults to local storage and browser approval; after connecting, the browser starts a test environment and verifies its private preview. Environment creation supports automatic or explicit host placement through the panel, API and MCP. Updated Hybrid agents report CPU/RAM capacity for admission checks. Environments and volumes retain host ownership; compatible S3 snapshots can restore across hosts. This does not provide automatic host failover or disk quotas.

Auto-stop uses authenticated incoming preview requests and WebSocket application data, plus terminal and SSH session traffic. Background CPU, disk and network activity, platform health checks, and protocol keepalives do not reset the timer. Queued or running tracked executions prevent auto-stop. For quiet jobs launched directly through SSH, disable auto-stop or run them through the executions API. The agent rechecks activity immediately before shutdown; activity after shutdown is committed waits for the existing stop/wake flow. Shutdown sends SIGTERM, waits up to 30 seconds, then force-stops, retaining container files and volumes. Deploy the control plane before updating compute agents for the shutdown authorization handshake. Auto-delete remains a cleanup backstop; auto-archive, ephemeral deletion, quotas including disk limits, snapshot retention, and the in-sandbox Driftverk agent are not yet implemented. The compute agent sends bounded container logs, runtime metrics, activity, and listening TCP ports to the control plane. The preview gateway converts those detected ports into private, time-limited HTTP and WebSocket URLs; it does not require the project or its ports to be declared in advance. The web terminal exchanges a short-lived, account-authorized ticket for a Docker TTY on the environment's compute node. The SSH gateway maps an authenticated workspace key and environment name to the current container. Snapshots are OCI artifacts: local storage remains the development default, while hybrid installations can export compressed, checksummed archives to customer-owned S3-compatible storage and restore them on another configured compute host.

The Compute agent runs a conservative image janitor every 15 minutes. It removes old, unreferenced Docker layers, old temporary snapshot and restore directories, and old Driftverk snapshot images that the control plane confirms are no longer needed. Local snapshot storage keeps tagged snapshot images while a building or ready local snapshot record exists. S3-backed snapshots may be evicted from the local Docker cache because they can be downloaded again. Images referenced by any container or active snapshot transfer are always left in place. The janitor never runs a blanket `docker system prune`.

Hybrid Compute agents keep an outbound WebSocket connection to the central data gateway. The gateway routes preview HTTP, web-terminal WebSockets, and centrally terminated SSH sessions by a signed ticket's `compute_node_id`. Customer hosts do not expose ports 2222, 8081, or 2223.

## Repository setup and templates

The create-environment page accepts a GitHub repository and branch, size presets, and an optional setup command. Public repositories work without authentication. For private repositories, each user, including workspace members, connects their own GitHub account and chooses which repositories the Driftverk GitHub App may read. Connections belong to the user across workspaces. Repository selection, prebuilds, and cloning use the initiating user or environment creator’s connection, provided they still belong to the workspace. Access and refresh tokens are encrypted with user-scoped context and included in `secrets:rotate`.

Migration `0031_personal_github_connections.sql` preserves legacy workspace connections but stops using them. Their owners were not recorded, so existing users must reconnect GitHub once after upgrading. Outstanding workspace OAuth authorizations must also be restarted.

Register the GitHub App with repository **Contents: read**, set its callback URL to `${BETTER_AUTH_URL}/api/github/callback`, and enable **Request user authorization during installation**. GitHub disables the optional Setup URL for this mode and sends the user to the authorization callback after installation. Set `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_APP_SLUG` on the control plane. No webhook permission is required for repository selection and cloning.

The Compute agent clones into `/workspaces/<repository>`, runs the setup command there, and only then reports the environment ready. Editor links open that directory. Git credentials arrive over stdin and are supplied to Git temporarily; they are not saved in the checkout, environment variables, or templates. Git push and later private fetches require separate authentication inside the environment. Disconnecting GitHub removes the stored connection; it does not delete existing checkouts.

The default development image is built once per host and cached. Its first build needs access to Docker Hub and Debian package repositories and can take several minutes. Docker is installed in the image; running a nested daemon still requires the supported Sysbox host and starting the daemon inside the environment. Coding-agent CLIs can be installed through the setup command. Custom images used for repository setup need Git, a POSIX shell, coreutils `timeout`, base64 and CA certificates.

Setup commands have a 15-minute limit and must be safe to rerun after failure. Completed setup is skipped on a create retry. Failed setup retains the container, and **Start environment** retries the unfinished creation. Existing checkout paths are never overwritten: when restoring a snapshot that already contains the repository, leave repository setup empty to preserve that checkout.

**Save as template** stores source image or snapshot, repository, branch, setup command, CPU/RAM and idle timeout. Templates are workspace-scoped configuration records. Environment variable values, volume mounts and other lifecycle options are not copied. Snapshots remain separate filesystem captures.

Deploy the control plane before updating Compute agents. Creation jobs requiring repository setup, a setup command, or `driftverk-dev:1` wait for an agent advertising `development-setup-v1`; older agents continue handling existing image-only workloads. Migration `0021` adds nullable fields and new tables without changing existing environments.

## Shared compute resources

Environment CPU and RAM sizes are runtime limits, not dedicated allocations. Scheduling reserves one quarter of the CPU limit. A 1 GiB RAM limit reserves 256 MiB; larger RAM limits reserve half their size. RAM placement leaves the greater of 512 MiB or 10% of host memory for the OS and compute services. Running and starting environments count toward reservations, including active provisioning leases. Existing environments use the same derived reservations without changing their Docker limits.

The container form defaults to a 1 vCPU / 1 GiB limit; development environments default to 2 vCPU / 4 GiB. Reservations control admission, not guaranteed physical memory. Concurrent bursts can still exhaust RAM. Billing continues to use the selected limits.

## Billing

 New Cloud organizations receive a one-time $30 welcome credit. Cloud uses the public per-second compute/storage rates with 5 GiB storage included. Hybrid costs $199/month for two hosts, plus $49 per extra host. The optional agreed pilot costs $299 for 30 days without automatic renewal. Billing uses Stripe Checkout, signed webhooks, a shared organization balance and database-enforced start limits. Existing pilot organizations keep complimentary access. See [billing setup and validation](./control-plane/docs/billing.md) before enabling paid Cloud compute.

## Local control plane

Requirements: Docker with Compose v2 and a local PostgreSQL instance. The
local setup reuses PostgreSQL on the Mac instead of starting the bundled
PostgreSQL service. Use a separate database, for example `driftverk`, and set
`POSTGRES_PASSWORD` in `.env` to the password for the local `driftverk` role.

```bash
cp .env.example .env
docker compose -f compose.yaml -f compose.local.yaml up -d --build control-plane
```

The local override connects the container to `host.docker.internal:5432`.
Open `http://localhost:3000`. Caddy is not needed for local testing.

The default `compose.yaml` still starts its own PostgreSQL service and remains
available for the self-contained control-plane deployment.

Local email uses `EMAIL_MODE=console`. Verification and password-reset links are written to the control-plane container log:

```bash
docker compose logs -f control-plane
```

The checked-in `.env.example` contains placeholders only. Use unique random values for every password, signing secret, compute token, and encryption key. Never commit `.env` or reuse `BETTER_AUTH_SECRET` for another purpose.

`SECRET_ENCRYPTION_KEYS` is an ordered keyring. To rotate it, deploy a new key first while retaining the old key after it, run `docker compose exec control-plane npm run secrets:rotate`, verify that the command completes, and only then remove the old key in a later deployment. The first startup with checksum support baselines migrations already recorded in the database; after that, changing an applied migration makes startup fail instead of silently accepting schema drift.

GitHub Actions remains the image builder. It must hand Driftverk an immutable GHCR digest from a secret-free build job; a separate trusted job calls Driftverk with a repository-scoped key. See [`control-plane/docs/github-actions.md`](./control-plane/docs/github-actions.md) before enabling pull-request automation.

Platform administration is separate from an organization's `admin` role and is controlled by the server-only `is_platform_admin` user flag. A platform administrator sees **Admin** in Driftverk Cloud and can inspect the primary customer contact, recent environment activity and environment health. The same view controls hybrid hosting and shows Compute agent connection status. Customer S3 credentials are never entered in Driftverk Cloud.

Useful checks:

```bash
npm run control:check
npm run control:test
npm run compute:test
docker compose config --quiet
```

Set `CONTROL_PLANE_TEST_DATABASE_URL` to a local test database when running `npm run control:test` to include the PostgreSQL queue regression test. The queue test uses session-local temporary tables; wake/access tests use a unique fixture schema that is removed afterwards. Existing application tables are not changed. Without that variable, these database tests are skipped.

## Production control plane

Set at least these values in the instance-local `.env`:

```dotenv
NODE_ENV=production
APP_DOMAIN=app.driftverk.com
HTTP_PORT=80
HTTPS_PORT=443
BETTER_AUTH_URL=https://app.driftverk.com
TRUSTED_ORIGINS=https://app.driftverk.com
AUTH_ALLOW_SIGN_UP=false
AUTH_REQUIRE_EMAIL_VERIFICATION=true
EMAIL_MODE=resend
RESEND_API_KEY=re_...
EMAIL_FROM=Your service <noreply@example.com>
SIGNUP_NOTIFICATION_EMAIL=
INSTALLATION_MODE=hosted
```

`APP_DOMAIN` and `BETTER_AUTH_URL` must describe the same public origin. The `driftverk.com` sending domain is verified in Resend. Use a sending-only API key restricted to that domain. Production startup fails if `EMAIL_MODE=resend` does not have `RESEND_API_KEY`, and authentication waits for Resend so delivery failures are not reported as successful sends.

Set `AUTH_ALLOW_SIGN_UP=true` when customers should be able to create accounts. After email verification, a new user is asked to create an organization and becomes its admin. Users who accept an organization invitation join that organization instead.

New invitation emails include a signed proof of the invited address. Registering or signing in through that link verifies the matching address and joins the invited organization without a second verification email. Expired or cancelled invitations cannot verify an address. Older invitation links still use the normal email-verification flow; resend the invitation to provide the streamlined flow.

Ports 80 and 443 serve the panel and central data gateway. Central port 2222 serves product SSH at `ssh.app.driftverk.com`; keep the host's operator SSH on port 22 restricted to the operators' addresses. PostgreSQL and the HTTP Node ports bind to loopback on the host. Store `SSH_TOKEN_SECRET` separately from the preview and terminal signing secrets and persist the central `ssh-host-keys` volume so clients see a stable host fingerprint.

Point `ssh.app.driftverk.com` directly at the Driftverk gateway host with a DNS-only record. Cloudflare's normal HTTP proxy does not forward SSH traffic on port 2222.

### Deployment behind Dokploy

When the host already runs Dokploy, keep Caddy stopped and let Dokploy's Traefik own ports 80 and 443. Set `PUBLIC_HOSTNAME`, `BETTER_AUTH_URL`, and `TRUSTED_ORIGINS` to the same hostname, then start the application with the Dokploy override:

```bash
docker compose -f compose.yaml -f compose.dokploy.yaml up -d --build postgres control-plane
```

The override joins only the control plane to `dokploy-network` and adds the HTTP-to-HTTPS and Let's Encrypt routes. PostgreSQL remains on the private Compose network and its host port stays bound to loopback. In Cloudflare, point an unproxied `A` record at the host first so Traefik can obtain the origin certificate. Enable the Cloudflare proxy after HTTPS has been verified.

## Compute EC2

Interactive SSH shells with a PTY and web terminals use tmux when it is installed
in the environment. Reconnecting attaches to the same shell after a transport,
gateway, or agent interruption. Each environment has one shared SSH session and
one separate shared web session; simultaneous clients of the same kind see and
control the same terminal. These sessions are not private per workspace member.
Use tmux windows for separate shells. `exit` ends the shell; disconnecting leaves
it running. Container stop/restart and auto-stop still end these processes.
SSH exec commands, including editor bootstrap commands, and port forwarding are
unchanged. Custom images without tmux use a regular shell and display a warning.
The Driftverk Dev image already includes tmux. Existing shells started before
this change cannot be adopted; reconnect after the agent update to start one.

Runtime telemetry checks command execution with a five-second deadline. Three
consecutive `unsafe procfs detected ... operation not permitted` failures can
queue one recovery start for a running development environment. Recovery uses
the existing lifecycle queue, skips environments with active jobs or executions,
and restarts only a confirmed Sysbox runtime. The database records a one-hour
recovery budget; a repeated failure within that hour marks the environment degraded.
Unknown errors and timeouts never authorize a restart. A recovery restart ends
processes in the environment and reruns its configured startup flow.

SSH uses the existing pending-start response while recovery is queued, waiting
up to 45 seconds. Longer recovery still requires a client reconnect. Existing
SSH sessions cannot survive an environment restart. Recovery events appear in
environment logs; this does not send an external operator notification.

Deploy migration `0044_runtime_recovery.sql` and the control plane before updating
compute agents. Agents must advertise `runtime-recovery-v1` to claim recovery jobs.
The installer also excludes Sysbox from automatic `needrestart` service restarts;
schedule those restarts during maintenance with environments stopped.

Install Docker and Sysbox on a compatible Linux host, then create `.env.compute` from `.env.compute.example` and run:

```bash
docker compose --env-file .env.compute -f compose.compute.yaml up -d --build
```

`sudo driftverk-agent update` compares the downloaded bundle with the installed files and rebuilds only the affected service. A preview-gateway or web-terminal change therefore leaves the Compute agent and its active SSH tunnels running. Changes to the Compute agent itself still restart that service and interrupt its active sessions.

The compute host needs outbound HTTPS access to the control plane, central data gateway, and OCI registries. Preview, web-terminal, and SSH traffic return over the agent's outbound connection. It needs no inbound product ports, and individual sandbox ports remain private. Mounting `/var/run/docker.sock` gives the trusted compute services root-equivalent control of that host, which is why compute belongs on a dedicated instance outside the test deployment.

For a customer-owned compute node with customer-owned S3 snapshot storage, follow [HYBRID_INSTALL.md](./HYBRID_INSTALL.md). The S3 configuration belongs to the customer compute agent; it is not sent to the shared control plane.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for component names, Docker networks, request routing, job leasing, environment lifecycle, snapshot flow, and the current multi-host boundary.

Production preview URLs use a DNS-01 wildcard certificate for `preview.app.driftverk.com` and `*.preview.app.driftverk.com`. The files in `infrastructure/preview-tls` install a daily systemd renewal job using lego and make the resulting certificate available to Dokploy's watched Traefik configuration. Store the zone-scoped Cloudflare token only on the host in `/etc/driftverk/preview-cloudflare.env`; it needs `Zone:DNS:Edit` and `Zone:Zone:Read` for `driftverk.com` and must never be committed.

Users do not receive host SSH access or a separately exposed port for every sandbox. Product SSH terminates centrally at `ssh.app.driftverk.com:2222`. The gateway authenticates a public key stored by a workspace member and expects `<workspace-slug>.<environment-name>` as the SSH username. The control plane checks membership, resolves the assigned compute node, and issues a short-lived ticket. The Compute agent exchanges that ticket before attaching the session through Docker on its local host. Direct `docker exec` remains an operator-only fallback. A sandbox image may still run `sshd` when a workload specifically requires it, but it remains reachable only on the private compute network.

Do not claim nested-Docker isolation until the chosen EC2 AMI, kernel, Docker version, and Sysbox runtime have passed a real host test. On macOS, leave `DOCKER_RUNTIME` empty for local lifecycle testing; that validates orchestration, not the production isolation boundary.

`ALLOW_UNTRUSTED_CODE` defaults to `false`, so machine-created pull-request code fails closed even if an API key or workflow has already been configured. Enable it only after the production compute boundary, outbound network policy, instance metadata protection, limits, and teardown have been verified on the real host.

### Moving the temporary compute agent

The current internal test runs `driftverk-compute` on the control-plane VPS with the standard `runc` runtime. This proves the queue and container lifecycle, but it does not provide the intended nested-Docker isolation.

Before moving compute, stop or delete active test environments because Docker runtime IDs belong to one host. Then stop the old agent:

```bash
docker compose -p driftverk-compute -f compose.compute.yaml down
```

On the dedicated EC2 host, install and validate Sysbox, copy `compose.compute.yaml` and `infrastructure/compute-agent`, set the same control-plane URL and compute token in `.env.compute`, and start the agent with `DOCKER_RUNTIME=sysbox-runc`. New queued jobs are then claimed by that host. Persisted environments move later by capturing a snapshot to durable storage and restoring it on the new compute host; Docker containers themselves are not copied between hosts.

## Repository structure

```text
control-plane/                 Control-plane app and PostgreSQL migrations
infrastructure/compute-agent/  Docker lifecycle agent for a compute host
compose.yaml                   Control-plane Compose project
compose.dokploy.yaml           Traefik routing override for a Dokploy host
compose.compute.yaml           Compute-node Compose project
Caddyfile                      HTTPS reverse proxy
infrastructure/data-gateway/   Central hybrid preview and terminal relay
TODO.md                        Current implementation order and boundaries
```

See [TODO.md](./TODO.md) for the next implementation slice.

## Stop, resume, snapshots, and access

Stop ends container processes while retaining its writable filesystem. Resume starts the same container and runs its startup command again; it does not resume RAM or manually launched processes. Configure the application to start with the container if preview should recover automatically. A development server launched only in an interactive shell must be started again after stop.

Opening a valid, unexpired preview URL, connecting with an authorized SSH key, or opening the web terminal wakes a stopped environment. Concurrent requests share one start job. Access during a stop waits for that stop before queuing the start. Deleted environments and failed starts are not automatically retried. Preview waits up to 45 seconds for authorization, container startup, and a listening port; it does not wait for port telemetry. Session input/output updates activity so an active SSH or terminal user is not dependent on CPU thresholds alone.

The Compute agent reserves one serial worker for resume jobs and another for create, stop, delete, and snapshot. Telemetry runs separately. Idle job polling defaults to 500 ms; this is a queue delay bound when the relevant worker and host are available, not a startup-time guarantee. Deploy the control plane before the updated Compute agent because the workers require the operations filter.

Snapshots briefly pause a running container during filesystem capture, then let it continue. Restoring creates a separate environment. Local snapshots stay on their source compute host; S3 snapshots can restore on another compatible host and reuse a locally cached image. Capture/upload and uncached restore/download time depend on image size, disk, and network. Mounted volume contents and running processes are not part of the snapshot. Environment variables already present in the container may be retained, so only snapshot values that are safe to copy into future environments. A pause of the outer environment does not provide an application-consistent backup of databases running in nested Compose services. Use the database's backup mechanism and validate restore behavior on the production Sysbox host before relying on those workloads in snapshots.

## Repository-first project setup and readiness

Daily navigation centers on **Environments** and **Project setups**. Workspace infrastructure, snapshots, integrations and team management are available from **Settings**; their existing URLs still work.

Creation opens a modal with three sources: **Repository**, **Snapshot**, and **Image**. Repository is the default path: choose a GitHub repository and branch, then review the detected project setup. Snapshot restores a saved environment filesystem. Image starts directly from a public or authenticated OCI image. Names are generated automatically. Project commands and infrastructure options remain collapsed until they are needed. Saved project setups are reusable creation defaults, not another environment type.

**Detect project setup** reads root files from the selected branch without executing repository code. For JavaScript projects it suggests npm, pnpm, or Yarn commands. For a Compose project, Driftverk checks these standard root filenames in order:

1. `compose.yaml`
2. `compose.yml`
3. `docker-compose.yaml`
4. `docker-compose.yml`

When a Compose file is present, Driftverk starts its complete project with `docker-compose up -d --build`. This happens during creation and again on resume. An explicit startup command overrides automatic Compose startup, so projects that need a different command do not need a separate Compose switch. Published HTTP ports are discovered through normal environment telemetry.

Compose runs through a nested Docker daemon inside the environment; Driftverk does not mount the compute host's Docker socket into customer code. This requires the Driftverk development image, or a compatible custom image containing Docker and Compose, on a Sysbox-capable compute host. The current development image uses Docker Compose v1. Compose files that require Compose v2 features need a compatible custom image until the development image moves to v2.

The automatic readiness check waits until every Compose container is either healthy or running. Add service health checks when a running process does not mean the application is ready. Without a health check, a running container is considered ready. Inspect `/var/log/driftverk-dockerd.log` if the nested daemon fails, and `/var/lib/driftverk/setup-<environment-id>/startup.log` or `readiness.log` when project startup fails.

Other languages, nested monorepo packages, and Dev Containers require explicit commands or a compatible custom image in this version. Detection never guesses the HTTP port. Source image or snapshot, host placement, resource limits, volumes, and lifecycle options remain under **Advanced settings**.

The authenticated panel creation endpoint accepts two optional fields in addition to `setup_command`:

- `startup_command`: starts services in the workspace on creation and resume. A background supervisor supports foreground servers. A live process marker prevents launching a duplicate server during a creation retry. Commands that detach their own services must be safe to rerun.
- `readiness_command`: a shell check inside the environment. Exit code 0 passes. Each attempt has a 10-second limit and the complete check has a 2-minute limit. Creation and resume do not report success until this check passes. This checks the application inside the container, not the external preview gateway, and is not continuous health monitoring.

For example, use `npm ci`, your project's `npm run dev` command with the appropriate `0.0.0.0` binding, and `curl -fsS http://127.0.0.1:<actual-port>/ >/dev/null`. Commands run as the sandbox's root user, as existing setup commands do. Custom images need `sh`, coreutils `timeout`, `awk`, and the tools used by the commands. Do not put credentials in commands or project setups.

Project setups save all three commands. Existing setups and environments remain valid with no startup or readiness command. Without a readiness command, the UI explicitly leaves app readiness unverified. API/MCP creation retains its existing image-based contract; this release adds command configuration to panel creation and reusable setups.

Failure keeps the container and checkout. **Inspect in terminal**, **Show project output** in the connected terminal, and **Retry setup** are available on the environment detail page. Command output stays inside `/var/lib/driftverk/setup-<environment-id>/` as `setup.log`, `startup.log`, and `readiness.log`; arbitrary output is not copied into control-plane error messages. Inspect these files for diagnostics, including when setup scripts may have printed sensitive values. Setup logs are overwritten on an install retry, readiness logs on each check attempt, and startup logs on each service launch. They do not have automatic size rotation in this version.

Deploy the control plane and migration `0023_project_readiness.sql` before updating compute agents. Jobs with startup/readiness commands require the `project-readiness-v1` capability on both creation and resume; older agents can still stop or delete those environments. After an unexpected host/container restart, use **Start environment** to rerun startup and readiness; this release does not supervise project recovery independently of the compute job lifecycle.

Additional local runtime verification, with `driftverk-dev:1` already present on the local Docker engine:

```bash
DRIFTVERK_RUNTIME_QA=1 node --test infrastructure/compute-agent/project-readiness.integration.test.mjs
```

This creates and removes its own network-isolated test container. It checks a working HTTP app, creation retry, install preservation and service startup after stop/resume. It does not validate the production Sysbox boundary or the external preview route.

### Configure SSH tools

Run `driftverk ssh-config jacob-vm` to add an environment from the active
organization to `~/.ssh/config`. The command reuses the CLI's dedicated SSH key
and registers it through the normal setup flow when needed. For an organization
named `example-project`, the host alias is `driftverk-example-project.jacob-vm`:

```bash
driftverk ssh-config jacob-vm
ssh driftverk-example-project.jacob-vm
```

Select that alias in an editor or tool that imports OpenSSH hosts. Rerunning the
command updates its managed block without duplicating it. Existing configuration
is backed up before changes; unrelated entries are preserved. A conflicting
manually configured alias or a symlinked config is left for manual resolution.
This configures SSH access only; it does not configure editor session persistence
or change the environment's auto-stop settings.

### Guided agent setup

In an interactive terminal, `driftverk create` now continues into guided setup
after the environment is ready. It configures an SSH alias and offers Codex,
a remote shell, or finishing setup for an SSH-compatible editor.
Use `driftverk create --no-connect` to stop after creation; non-interactive
creation also skips the wizard. Resume with `driftverk connect <environment>`.

The Codex path checks that Codex and tmux are installed, reuses an existing
remote login, or runs `codex login --device-auth` remotely. The CLI shows the
one-time code and opens the official device-login page locally. Use
`--no-browser` to open the link yourself. Device-code login must be enabled
for the OpenAI account or workspace. Credentials stay in the environment.

After login, Enter opens or reattaches a dedicated tmux Codex session.
Disconnecting SSH leaves that session running while the environment stays up.
Disable auto-stop for quiet unattended tasks; this wizard does not change that
setting. Editor authentication and session behavior depend on the editor.
