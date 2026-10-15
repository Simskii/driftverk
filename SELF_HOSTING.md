# Self-hosting Driftverk

Run your own control plane and connect dedicated compute hosts. This guide uses `dev.example.com` for the panel, `preview.dev.example.com` for preview addresses and `ssh.dev.example.com` for SSH. Replace these examples consistently with domains you own.

The control plane needs Docker Engine, Compose v2, persistent disk, a PostgreSQL backup plan and public HTTPS. Compute needs a dedicated supported Sysbox host. Local `runc` tests do not prove the production isolation boundary. Keep `ALLOW_UNTRUSTED_CODE=false` until your host and network boundary have been verified.

## Configure the control plane

Clone the repository on the control-plane host. Copy `.env.example` to `.env`, set permissions to `600`, and replace every secret placeholder. Generate independent random secrets with `openssl rand -base64 32`. `SECRET_ENCRYPTION_KEYS` needs a key identifier followed by `=` and a base64-encoded 32-byte key, for example `2026-10=<generated-key>`. Retain old keys until the documented rotation succeeds.

Set these installation values:

```dotenv
NODE_ENV=production
INSTALLATION_MODE=self-hosted
APP_DOMAIN=dev.example.com
PUBLIC_HOSTNAME=dev.example.com
BETTER_AUTH_URL=https://dev.example.com
TRUSTED_ORIGINS=https://dev.example.com
PREVIEW_DOMAIN=preview.dev.example.com
SSH_PUBLIC_HOST=ssh.dev.example.com
SSH_PUBLIC_PORT=2222
HTTP_PORT=80
HTTPS_PORT=443
AUTH_ALLOW_SIGN_UP=true
AUTH_REQUIRE_EMAIL_VERIFICATION=true
EMAIL_MODE=resend
RESEND_API_KEY=<your-resend-key>
EMAIL_FROM=Driftverk <hello@example.com>
SIGNUP_NOTIFICATION_EMAIL=<your-operations-address>
ALLOW_UNTRUSTED_CODE=false
```

Self-hosted mode allows organizations to use their own compute without configuring Stripe. Stripe settings are for hosted billing. `COMPUTE_AGENT_TOKEN` remains a required installation secret; guided enrollment issues separate organization-bound tokens. Leave GitHub App fields empty unless you need repository integration. If configured, create your own GitHub App with Contents read permission, user authorization enabled and callback `https://dev.example.com/api/github/callback`.

Start with a new PostgreSQL database. The first startup binds it to its installation mode; later mode changes are rejected. Existing organizations cannot be converted to self-hosted mode by changing an environment variable. Keep hosted production data in its original database.

If you require your own signup terms, set `OPERATOR_TERMS_URL` and `OPERATOR_TERMS_VERSION` together, and optionally `OPERATOR_PRIVACY_URL`. These must be your published documents, not Driftverk's hosted-service terms. The signup flow has no required operator terms when these fields are absent.

For an internal evaluation, `EMAIL_MODE=console` prints verification/reset links to the control-plane log. Treat those logs as sensitive. For a public installation use Resend with a verified sender domain and test actual email delivery.

## DNS and wildcard HTTPS

Point `dev.example.com`, `ssh.dev.example.com` and `*.preview.dev.example.com` to the control-plane edge. Expose TCP 80/443 for HTTP/HTTPS and the configured SSH port. Keep PostgreSQL and gateway backend ports private. Wildcard DNS alone does not provide wildcard TLS.

The default `Caddyfile` proxies the panel, tunnel and terminal paths, and accepts preview hosts over HTTP for an upstream TLS edge. Stock Caddy cannot automatically obtain wildcard certificates through DNS challenge without an additional DNS provider module. For standalone Caddy, obtain and renew a certificate covering `*.preview.dev.example.com` with your DNS provider's ACME tooling. Keep its key private and create this local, untracked `Caddyfile.self-hosted`:

```caddyfile
dev.example.com {
    encode zstd gzip
    handle /api/tunnel/* {
        reverse_proxy data-gateway:3001
    }
    handle /api/terminal* {
        reverse_proxy data-gateway:3001
    }
    handle {
        reverse_proxy control-plane:3000
    }
}

*.preview.dev.example.com {
    tls /etc/caddy/preview-tls/fullchain.pem /etc/caddy/preview-tls/privkey.pem
    encode zstd gzip
    reverse_proxy data-gateway:3001
}
```

Create a local `compose.self-hosted.yaml` override:

```yaml
services:
  caddy:
    volumes:
      - ./Caddyfile.self-hosted:/etc/caddy/Caddyfile:ro
      - ./preview-tls:/etc/caddy/preview-tls:ro
```

Store the wildcard certificate and key as `preview-tls/fullchain.pem` and `preview-tls/privkey.pem`. Restrict key access to the host administrator and Caddy, and exclude this directory from version control and image builds. Caddy obtains the panel certificate automatically. Renew the preview certificate before expiration, then reload Caddy. An upstream TLS edge must preserve the original Host header and proxy WebSocket upgrades for previews, `/api/tunnel/*` and `/api/terminal*`.

For Dokploy/Traefik, combine `compose.yaml` with `compose.dokploy.yaml`, set `PUBLIC_HOSTNAME`, and configure this escaped preview host expression in `.env`:

The Dokploy override defaults to `INSTALLATION_MODE=hosted` for compatibility with hosted deployments. Your `.env` must explicitly set `INSTALLATION_MODE=self-hosted` for a new self-hosted database.

```dotenv
PREVIEW_HOST_REGEXP=^[0-9]+-[a-z0-9-]+[.]preview[.]dev[.]example[.]com$
```

Supply a wildcard certificate to Traefik or configure its DNS-challenge resolver. The preview router has TLS enabled but deliberately does not attempt HTTP-challenge wildcard issuance. Route SSH directly to the published gateway TCP port. Avoid publishing the Caddy HTTP/HTTPS ports alongside an edge that already owns those ports; configure distinct private listener ports or disable Caddy through your deployment configuration.

## Start and create an administrator

With the standalone override configured, validate and start:

```sh
docker compose -f compose.yaml -f compose.self-hosted.yaml config --quiet
docker compose -f compose.yaml -f compose.self-hosted.yaml up -d --build
docker compose -f compose.yaml -f compose.self-hosted.yaml ps
```

The server applies repository SQL migrations on startup. Back up PostgreSQL before upgrades, preserve the encryption keys, and inspect startup logs for migration failures. Do not assume reverting an image reverses a migration.

Open `https://dev.example.com`, create your account and complete email verification. Grant platform administration to that existing account:

```sh
docker compose -f compose.yaml -f compose.self-hosted.yaml exec control-plane npm run admin:grant -- --email you@example.com
```

This command promotes an existing user; it does not create an account. Sign in again if your session has not refreshed. After initial onboarding, set `AUTH_ALLOW_SIGN_UP=false` if your installation should not accept new public registrations, and recreate the control-plane service.

## Connect compute

Use a clean dedicated Ubuntu 22.04 or 24.04 amd64 host with systemd and enough disk for environment layers and temporary snapshot archives. In the panel create an organization using your own servers, then open **Compute hosts**. Download your own installation's installer and inspect it before execution:

```sh
curl -fsSL https://dev.example.com/install/agent -o driftverk-agent-install.sh
less driftverk-agent-install.sh
sudo env DRIFTVERK_CONTROL_PLANE_URL=https://dev.example.com bash driftverk-agent-install.sh
```

The installer adds Docker/Compose/jq and the pinned Sysbox runtime when needed. A workspace administrator approves the device code in your panel. Enrollment returns the control-plane URL, preview domain and panel hostname; the node stores these with its token in `/opt/driftverk/.env.compute`. Re-running the installer reuses the saved identity and control-plane URL. If changing domains later, update the panel, gateways, edge, DNS/certificates and existing compute configurations together.

Compute opens an outbound HTTPS/WebSocket tunnel. Keep compute ports 2222, 8081 and 2223 private. Never mount the compute host Docker socket into customer environments. Run one agent stack per host. Follow [Hybrid installation](HYBRID_INSTALL.md) for storage configuration, node updates, watchdog operation and restore testing. Local snapshots depend on their source host; use tested S3-compatible storage for cross-host restores and back up mounted volumes separately.

## Verify the installation

Check `/health` and container health first, then sign in with a real account and verify the whole path:

1. Enroll a host and confirm it reports Connected with healthy Docker, Sysbox and tunnel checks.
2. Create an environment on that host and execute a command in its terminal.
3. Start an HTTP server listening on `0.0.0.0`, open its preview from the panel, and verify its wildcard certificate and hostname. An unsigned or expired link should offer a return link to your panel.
4. Connect with an authorized SSH key through `ssh.dev.example.com` and test a WebSocket application through its preview.
5. Run a repository with a root Compose file inside the environment and verify nested Docker works without the host socket.
6. Stop the environment, then create and restore a snapshot containing a unique test file. Live Sysbox capture can omit filesystem changes, so snapshots require a stopped environment. For S3, verify a restore after losing the local image cache or on a compatible second host.

Successful builds, health checks and local tests each prove only their own layer. Record authenticated panel, terminal, preview, SSH and restore results before treating the installation as ready for users.

The `Self-hosted Sysbox` GitHub Actions job runs this path on a disposable Ubuntu 24.04 host. It installs the pinned Sysbox runtime before any containers, enrolls through the served installer, verifies email through the console delivery mode, and checks actual terminal, SSH, preview and nested Docker connections. Preview TLS uses Caddy's private CA with certificate verification enabled. The snapshot test covers local storage on one host; S3 and a public certificate issuer remain operator-specific checks. Test secrets, verification links and database volumes are not uploaded as artifacts.
