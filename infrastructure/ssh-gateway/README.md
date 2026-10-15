# SSH gateway

Go terminates public SSH using `golang.org/x/crypto/ssh`. Its supported algorithm
set includes hybrid `mlkem768x25519-sha256` and classical fallback for older
clients; SHA-1 algorithms are excluded. Authentication uses the existing
control-plane key fingerprint and environment authorization endpoint.

Each shell, exec or loopback forwarding channel opens an authenticated WebSocket
to the private Node data gateway on port 3002. Node routes it over the existing
compute-agent tunnel. The compute-agent wire protocol and signed tickets are
unchanged. This adds post-quantum key exchange to the client-to-SSH-gateway hop;
it does not establish post-quantum protection for the separate agent TLS tunnel.

## Configuration

| Variable | Purpose / default |
| --- | --- |
| `CONTROL_PLANE_URL` | Required control-plane URL |
| `SSH_TOKEN_SECRET` | Existing control-plane SSH authorization secret, at least 32 characters |
| `SSH_BRIDGE_SECRET` | Separate shared secret for Go and Node, at least 32 characters |
| `SSH_BRIDGE_URL` | `ws://data-gateway:3002/ssh` |
| `SSH_GATEWAY_PORT` | `2222` |
| `SSH_HOST_KEY_PATH` | `/data/ssh_host_key` |
| `SSH_HEALTH_ADDR` | `0.0.0.0:3003`, internal only |

Node additionally accepts `SSH_BRIDGE_PORT`, default 3002. Never publish its bridge
port or route it through the public HTTP proxy. The bridge secret authorizes
trusted frontend access; it must differ from preview, terminal and SSH ticket
secrets. User identity is verified by Go, reauthorized for every stream, then
checked again through the ticket at the compute agent.

The existing `ssh-host-keys` volume belongs to the Go service. Its path and UID
1000 are preserved. Existing RSA/PKCS#1 or OpenSSH host keys are reused byte for
byte. A missing key creates an Ed25519 key with mode 0600; an invalid or unreadable
key fails startup rather than replacing the server identity.

Shell, exec, PTY resize and loopback `direct-tcpip` forwarding match the previous
gateway. Other channel types and remote forwarding remain unsupported. The
gateway rechecks authorization every three seconds, immediately closes on
401/403, and permits up to one minute since the last successful authorization
during an outage. New channels always require fresh authorization.

Connections are capped at 512 and channels at 64 per connection. Node retains
its per-agent stream limits. Bridge writes have bounded buffering and deadlines;
an SSH output write stalled for 60 seconds closes that SSH connection. Idle
shells are not subject to that output timeout.

## Verification

From the repository root:

```sh
npm run gateway:test
docker build -f infrastructure/ssh-gateway/Dockerfile .
docker build -f infrastructure/data-gateway/Dockerfile .
```

Go 1.26 or newer is required by the pinned SSH dependency. The Go tests always
force ML-KEM and classical negotiation, verify command input/output and exit
status, and check host-key preservation. Node integration tests run the actual
Go binary and data gateway with mock control-plane authorization and agent SSH
responses. They also run system OpenSSH with forced ML-KEM when that client
supports it. This is local protocol proof, not production Sysbox/environment
verification.

The Go `/health` endpoint on port 3003 reports `ssh_clients` and `draining`.
Node `/health` reports `connected_agents` and `ssh_streams`, which counts active
bridge sockets, not SSH connections. `ssh-gateway healthcheck` checks the Go
listener process health. Neither health endpoint alone proves environment access.

## First release and rollback

1. Build and test both images before the release. Record the previous image
   references and Compose revision. Back up the existing host key securely.
2. Set a new random `SSH_BRIDGE_SECRET` in the deployment environment for both
   services. Preserve the existing `SSH_TOKEN_SECRET`, Compose project name,
   `ssh-host-keys` volume and host key. Never run `compose down -v`.
3. Schedule a brief gateway interruption and check the old gateway's
   `ssh_clients` count. Wait for zero active SSH clients or explicitly arrange
   their interruption. The old gateway has no connection-draining API, so a
   zero count alone cannot prevent a new connection racing the switch.
4. Recreate `data-gateway` with the bridge, then start `ssh-gateway`. Port 2222
   moves from Node to Go. This initial data-gateway restart also interrupts
   current preview and web-terminal streams while agents reconnect. Do not
   restart compute agents or customer environments for this migration.
5. Check connected agents, then connect through the public SSH hostname. Verify
   the unchanged host fingerprint, `ssh -vv` negotiated ML-KEM, shell/exec,
   port forwarding, revocation, and preview/web-terminal recovery on a real
   environment before declaring the release complete.
6. To roll back, stop the Go frontend and restore the previous Node image and
   Compose service definition with port 2222 and its host-key mount. Reuse the
   same volume and secrets. Wait for agent reconnection and retest access.

For later frontend-only releases, SIGTERM stops accepting new SSH connections
and waits up to 60 seconds for existing ones; Compose allows 65 seconds before
forcing exit. Sessions still open at that deadline disconnect. Restarting the
Node data gateway continues to interrupt streams routed through it. Neither
process transfers live connections to a replacement container.
