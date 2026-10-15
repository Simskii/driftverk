# Driftverk API draft

Status: historical design notes. The implemented v1 contract is documented in
[`control-plane/docs/api.md`](./control-plane/docs/api.md) and
[`control-plane/docs/openapi.yaml`](./control-plane/docs/openapi.yaml).

The implemented first slice deliberately excludes command execution, Compose,
archive actions, browser automation, and API-managed snapshots described below.

This document describes the smallest API that lets a person, CI pipeline, or AI
agent create a reproducible isolated devbox, run the application inside it, and
discard it safely afterwards.

## Scope check

**Job:** Create an isolated copy of a known code/data state, run tests or Docker
Compose in it, expose a preview, and clean it up automatically.

**Essential for v1:**

- organization-scoped API keys;
- devboxes created from an immutable filesystem snapshot or OCI image;
- asynchronous lifecycle operations with polling;
- resource and lifecycle limits;
- command execution inside the devbox;
- a small Docker Compose control surface;
- authenticated preview URLs;
- snapshot creation from a devbox.

**Deliberate non-goals for v1:**

- a public Docker socket or host command API;
- Kubernetes, multi-cloud scheduling, or a VM runtime;
- a generic plugin system;
- direct production cloning;
- interactive terminal and browser sessions in the first slice;
- billing mutations through this API.

Git commit sources, customer production copies, browser automation, and
webhooks fit the model but should be added after the core devbox lifecycle is
reliable.

## API conventions

Base URL:

```text
https://api.driftverk.com/v1
```

Machine clients authenticate with an organization-scoped API key:

```http
Authorization: Bearer dvk_live_...
```

The control-panel session and the compute-agent token are separate credentials.
The compute-agent endpoints are private and are not part of this public API.

Mutating requests that create or enqueue work require an idempotency key:

```http
Idempotency-Key: agent-alice-main-abc123
```

All responses include `X-Request-Id`. List endpoints use cursor pagination:

```json
{
  "data": [],
  "next_cursor": null
}
```

### Async operations

Provisioning, starting, stopping, deleting, snapshot capture, Compose actions,
and command execution return `202 Accepted` with an operation. Clients poll
the operation instead of holding an HTTP request open.

```json
{
  "data": {
    "id": "devbox_01J...",
    "type": "devbox",
    "state": "creating"
  },
  "operation": {
    "id": "op_01J...",
    "type": "devbox.create",
    "status": "queued",
    "resource_id": "devbox_01J..."
  }
}
```

Operation status:

```text
queued -> running -> succeeded
                    \-> failed
                    \-> cancelled
```

## Resources

### Devbox

A devbox is one isolated runtime. It has its own filesystem, network namespace,
resource limits, optional nested Docker daemon, and lifecycle policy.

```json
{
  "id": "devbox_alice_checkout",
  "name": "alice-checkout",
  "state": "running",
  "runtime": "container",
  "region": "eu-north-1",
  "source": {
    "type": "snapshot",
    "snapshot_id": "snap_example-project_main_abc123",
    "name": "example-project-main",
    "version": "abc123"
  },
  "resources": {
    "cpu": 4,
    "memory_mb": 8192,
    "disk_gb": 80
  },
  "lifecycle": {
    "auto_stop_minutes": 60,
    "auto_archive_minutes": 10080,
    "auto_delete_minutes": 43200,
    "expires_at": null
  },
  "labels": {
    "repository": "example-project",
    "ref": "feature/checkout",
    "agent": "alice"
  },
  "created_at": "2026-09-03T10:00:00Z",
  "updated_at": "2026-09-03T10:02:12Z"
}
```

Environment variable values are write-only. They are encrypted at rest and
never returned by `GET` endpoints.

### Snapshot

A snapshot is immutable, versioned filesystem state that can be reused by many
devboxes. It may include project files, dependencies, nested Docker data, and
seeded test data. It does not include process memory.

```json
{
  "id": "snap_example-project_main_abc123",
  "name": "example-project-main",
  "version": "abc123",
  "state": "ready",
  "kind": "checkpoint",
  "metadata": {
    "repository": "example-project",
    "ref": "main",
    "commit": "abc123"
  },
  "resources": {
    "cpu": 4,
    "memory_mb": 8192,
    "disk_gb": 80,
    "size_gb": 12.4
  },
  "created_at": "2026-09-03T09:45:00Z"
}
```

Snapshots are organization-scoped. A system base image can be visible to all
organizations but cannot be changed or deleted by them.

### Operation

Operations provide one consistent status model for lifecycle, tests, Compose,
and snapshot work.

```json
{
  "id": "op_01J...",
  "type": "command.execute",
  "status": "succeeded",
  "resource_id": "devbox_01J...",
  "started_at": "2026-09-03T10:04:00Z",
  "finished_at": "2026-09-03T10:04:08Z",
  "result": {
    "exit_code": 0,
    "duration_ms": 8000,
    "output_url": "https://api.driftverk.com/v1/operations/op_01J.../output"
  },
  "error": null
}
```

## v1 endpoints

### Health and identity

```text
GET    /health
GET    /me
```

`/me` returns the authenticated organization, API-key scopes, and server API
version. It does not return the API key.

### Devboxes

```text
GET    /devboxes
POST   /devboxes
GET    /devboxes/{devbox_id}
POST   /devboxes/{devbox_id}/start
POST   /devboxes/{devbox_id}/stop
POST   /devboxes/{devbox_id}/archive
DELETE /devboxes/{devbox_id}
```

Create from a ready snapshot:

```http
POST /v1/devboxes
Idempotency-Key: ci-example-project-pr-184
Content-Type: application/json
```

```json
{
  "name": "pr-184",
  "source": {
    "type": "snapshot",
    "snapshot_id": "snap_example-project_main_abc123"
  },
  "region": "eu-north-1",
  "resources": {
    "cpu": 4,
    "memory_mb": 8192,
    "disk_gb": 80
  },
  "lifecycle": {
    "auto_stop_minutes": 30,
    "auto_archive_minutes": 1440,
    "auto_delete_minutes": 2880
  },
  "environment": {
    "APP_ENV": "test",
    "DATABASE_URL": "postgres://..."
  },
  "labels": {
    "repository": "example-project",
    "pull_request": "184"
  }
}
```

The API validates the source, resource ceilings, lifecycle limits, variable
names, and organization quota before creating the record and queueing the
compute operation.

The start/stop/archive actions are idempotent. `DELETE` destroys the runtime
and its writable state. It does not delete the source snapshot.

### Snapshots

```text
GET    /snapshots
POST   /snapshots
GET    /snapshots/{snapshot_id}
DELETE /snapshots/{snapshot_id}
POST   /devboxes/{devbox_id}/snapshots
```

Create a checkpoint from a running devbox:

```http
POST /v1/devboxes/devbox_alice_checkout/snapshots
Idempotency-Key: checkpoint-example-project-abc123
```

```json
{
  "name": "example-project-main",
  "version": "abc123",
  "capture": {
    "pause": true
  },
  "metadata": {
    "repository": "example-project",
    "ref": "main",
    "commit": "abc123"
  }
}
```

The response is `202 Accepted`. The resulting snapshot becomes usable only
when its state is `ready`.

### Commands and test runs

Commands always execute inside the selected devbox. They never execute on the
control-plane Worker or directly on a host.

```text
POST /devboxes/{devbox_id}/exec
GET  /operations/{operation_id}
GET  /operations/{operation_id}/output
POST /operations/{operation_id}/cancel
```

```json
{
  "command": ["pnpm", "test"],
  "cwd": "/workspace",
  "timeout_seconds": 900,
  "env": {
    "CI": "true"
  }
}
```

The first version accepts an argument array instead of an untrusted shell
string. Shell execution can be added explicitly for a devbox later, but should
not be the default. Output is capped in the API response and stored behind an
authorized operation-output URL.

### Docker Compose

Compose is a small, explicit control surface rather than a public Docker API:

```text
GET  /devboxes/{devbox_id}/services
POST /devboxes/{devbox_id}/compose/up
POST /devboxes/{devbox_id}/compose/down
POST /devboxes/{devbox_id}/compose/restart
```

```json
{
  "cwd": "/workspace",
  "services": ["web", "db", "worker"],
  "wait": true,
  "timeout_seconds": 900
}
```

The compute agent runs the operation inside the devbox's nested Docker
runtime. The API never exposes the host Docker socket, host filesystem, or
provider credentials.

### Preview URLs

```text
GET    /devboxes/{devbox_id}/previews
POST   /devboxes/{devbox_id}/previews
DELETE /devboxes/{devbox_id}/previews/{preview_id}
```

```json
{
  "port": 3000,
  "protocol": "http",
  "visibility": "private",
  "expires_in_seconds": 3600
}
```

The response contains a short-lived authenticated URL. Preview URLs are
revocable and do not expose a public port directly.

## Source model and versions

The stable v1 source types are deliberately few:

```text
image    OCI image, public or from an organization registry
snapshot immutable filesystem snapshot
```

This is enough to support the first workflow:

```text
main commit -> CI prepares checkpoint -> snapshot ready
           -> Alice/agent creates devbox from snapshot
           -> Compose up -> tests/browser -> preview
           -> stop/archive/delete
```

### Git source (phase 2)

Once the snapshot path is reliable, a convenience endpoint can create a
snapshot from a pinned repository commit:

```text
POST /snapshots
```

```json
{
  "source": {
    "type": "git",
    "repository_id": "repo_example-project",
    "ref": "main",
    "commit": "abc123"
  },
  "bootstrap_snapshot_id": "snap_driftverk_node22_v1",
  "name": "example-project-main",
  "version": "abc123"
}
```

The commit must be pinned before work starts. A moving branch name is metadata,
not an executable version selector.

## Customer test environments (phase 3)

Customer copies should use a dedicated high-level endpoint so the dangerous
parts cannot be accidentally omitted from a normal devbox request:

```text
POST /customer-test-environments
GET  /customer-test-environments/{id}
POST /customer-test-environments/{id}/refresh
DELETE /customer-test-environments/{id}
```

Draft request:

```json
{
  "customer_id": "customer_acme",
  "name": "acme-test",
  "source": {
    "deployment_id": "deployment_acme_production",
    "version": "current"
  },
  "data": {
    "mode": "masked_snapshot",
    "snapshot_id": "data_snapshot_acme_2026_09_03"
  },
  "network": {
    "allow_production": false
  },
  "lifecycle": {
    "expires_at": "2026-09-05T18:00:00Z",
    "auto_stop_minutes": 30
  }
}
```

The service must guarantee:

- no production database credentials in the test box;
- no write route to production by default;
- an explicit, auditable data policy (`empty`, `seeded`, or `masked_snapshot`);
- expiry and automatic destruction;
- customer access limited to the intended users;
- a clear record of which production version and data snapshot were used.

This requires a deployment/data connector. It cannot be reduced to a Docker
container create call.

## Agent and browser workflow (phase 2)

An agent should need only one API key and one coherent lifecycle:

```text
create devbox from snapshot
wait for operation
compose up
run tests with exec
create a private preview
run browser validation against the preview
capture a new snapshot if useful
delete devbox
```

Later, add:

```text
POST /devboxes/{devbox_id}/terminal-sessions
POST /devboxes/{devbox_id}/browser-sessions
```

These should return short-lived connection URLs or tokens. They should not
return persistent credentials or expose a host-level PTY/Docker socket.

## Webhooks and usage (phase 2)

Polling is sufficient for the first API client. Add signed webhooks when CI
and customer workflows need push notifications:

```text
POST   /webhooks
GET    /webhooks
DELETE /webhooks/{webhook_id}
```

Initial event names:

```text
devbox.created
devbox.running
devbox.stopped
devbox.failed
snapshot.ready
operation.completed
usage.threshold_reached
```

Usage visibility should be read-only first:

```text
GET /usage/current
GET /usage/events
```

The response should separate compute runtime from snapshot/disk storage so a
stopped devbox's remaining storage cost is visible.

## Errors

All errors use one shape:

```json
{
  "error": {
    "code": "snapshot_not_ready",
    "message": "The selected snapshot is still being captured.",
    "request_id": "req_01J...",
    "details": {
      "snapshot_id": "snap_01J...",
      "state": "building"
    }
  }
}
```

Important codes:

```text
authentication_required
insufficient_scope
resource_not_found
name_already_exists
snapshot_not_ready
invalid_source
invalid_resources
quota_exceeded
operation_in_progress
devbox_not_running
production_access_forbidden
rate_limited
```

## Implementation mapping in the current panel

The existing data model already gives us a useful first mapping:

| Public API | Current panel model |
| --- | --- |
| `devbox` | `servers` row with `kind = sandbox-container` |
| `snapshot` | `workspace_snapshots` |
| `environment` in an API response | organization-owned workspace context |
| `operation` | `compute_jobs` plus lifecycle state |
| compute agent | private `/api/compute/*` routes |
| registry | `workspace_registries` |
| secrets | encrypted `environment_variables` |

The public API should be added as a separate handler, for example
`src/api.ts`, rather than exposing the existing HTML form routes or the
compute-agent routes. The first implementation would need only:

1. `api_keys` with hashed secrets, scopes, organization ownership, and last-used
   time;
2. public `/v1/devboxes`, `/v1/snapshots`, `/v1/operations`, and `/v1/health`;
3. an operation view over the existing compute job/lifecycle state;
4. idempotency records for create/action requests;
5. an output/preview storage path before `exec` and preview endpoints are
   enabled.

Do not expose `compute_jobs/claim` through the public API. It is a scheduler
protocol for trusted compute nodes, not a product resource.

## Recommended build order

1. API key authentication, request validation, error shape, and idempotency.
2. `POST/GET /devboxes` from an existing ready snapshot.
3. `GET /operations` and lifecycle action endpoints over the current job queue.
4. Snapshot capture and restore through the compute agent.
5. `exec` with bounded output and cancellation.
6. Compose `up/down` and service status.
7. Private preview gateway.
8. Git commit source, browser sessions, customer production connectors, and
   webhooks.

The first meaningful demo is a short, complete workflow:

```text
POST snapshot -> POST devbox -> compose up -> exec tests -> preview -> delete
```
