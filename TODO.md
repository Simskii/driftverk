# Driftverk MVP

## Control plane

- [x] Add a Node.js/Hono control plane backed by PostgreSQL.
- [x] Run Caddy, the control plane, and PostgreSQL with Docker Compose.
- [x] Add Better Auth signup, email verification, sessions, sign-out, and password reset.
- [x] Add Resend delivery with a local console-email mode.
- [x] Move the compute job protocol to PostgreSQL with leases and failure reporting.
- [x] Protect product routes and enforce trusted origins on mutations.
- [x] Verify signup, verification, sign-in, password reset, create, stop, and delete locally.
- [x] Deploy the control-plane Compose project to its VPS.
- [x] Route `app.driftverk.com` through Dokploy Traefik with HTTPS.
- [x] Verify real Resend delivery from the verified `driftverk.com` domain.
- [x] Show customer contact, activity, environment health, and Compute agent status in platform admin.
- [ ] Add encrypted EBS snapshots and a tested PostgreSQL restore procedure.
- [ ] Replace first-user signup with organization invitations.

## Compute integration next

- [x] Add a trusted compute agent for OCI pull and container create, start, stop, and delete.
- [x] Keep Docker access on a separate compute host boundary.
- [x] Verify the PostgreSQL queue against a real local Docker container.
- [x] Run bounded Docker image and snapshot-temp cleanup on the Compute agent.
- [ ] Provision one compatible Linux EC2 compute host and install Docker plus Sysbox.
- [ ] Run the compute-agent Compose project on that host.
- [ ] Build the first versioned OCI base image with Node.js LTS, Git, Docker, Codex CLI, a non-root developer user, and the Driftverk agent.
- [x] Use `debian:bookworm-slim` as the configurable default public OCI image.
- [x] Detect standard root Compose files and start their complete project on create and resume when no explicit startup command is set.
- [ ] Replace Docker Compose v1 in the development image with the v2 plugin and validate modern Compose files.
- [ ] Validate nested Docker isolation, resource limits, Compose readiness, resume behavior, and host cleanup on EC2.
- [ ] Define and enforce the Linux OCI image compatibility contract.
- [ ] Add failed-job reconciliation and orphaned-container cleanup.

## Snapshot and access path

- [x] Capture an environment as a paused local OCI image and restore it on the same compute node.
- [x] Export a paused sandbox filesystem as a checksummed OCI archive to S3-compatible storage.
- [x] Restore an S3 snapshot into a new sandbox on a compatible compute node.
- [x] Record snapshot version, source, size, checksum-bearing artifact reference, creator, and storage compatibility.
- [x] Add authenticated browser terminal access through the compute gateway.
- [x] Add an SSH gateway with workspace public keys and environment-to-container routing.
- [x] Detect listening TCP ports and issue private, time-limited HTTP preview URLs.
- [x] Route `*.preview.app.driftverk.com` through TLS to the preview gateway.
- [x] Relay hybrid preview and web-terminal traffic over an outbound, node-bound Compute agent tunnel.
- [x] Terminate product SSH centrally and relay sessions over the node-bound tunnel.
- [x] Port private OCI registries with encrypted pull credentials.
- [x] Port encrypted environment variables from the Worker prototype.
- [x] Persist auto-stop, auto-archive, auto-delete, and ephemeral lifecycle policies.
- [x] Enforce auto-delete as an age-based cleanup backstop.
- [x] Enforce auto-stop from trusted activity timestamps.
- [ ] Enforce auto-archive from trusted activity timestamps.
- [x] Ingest sampled Docker logs and CPU, memory, and filesystem metrics.
- [ ] Add quotas, audit logs, and usage metering.

## Deliberate MVP boundaries

- Docker Compose, one region, and one container runtime class.
- OCI image or filesystem snapshot as the underlying sandbox sources; repository checkout is project configuration layered on an image.
- Filesystem snapshots only; process memory snapshots are not promised.
- No Kubernetes, VM class, multi-cloud abstraction, custom image builder, or general scheduler yet.
