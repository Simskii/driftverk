# Driftverk API v1 and MCP

The Driftverk API creates and manages development environments in one organization. AI clients can use the same operations through the Driftverk MCP server.

Base URL:

```text
https://app.driftverk.com/v1
```

The API is asynchronous. Create, start, stop, and delete return an `operation_id`. Poll `GET /v1/operations/{operation_id}` until its status is `succeeded` or `failed`.

## Create an API key

An organization admin creates an API key on the **API keys** page in the Driftverk control panel. The panel shows the token once. Store it in the AI client or a secret manager. Driftverk stores only its SHA-256 hash.

Scopes:

- `read` reads environments, snapshots, operations, project setups, prebuilds, executions, output, artifacts, and identity. It is required for every key.
- `write` creates, starts, and stops environments; creates and replaces project setups; builds prebuilds; executes and cancels commands; grants previews.
- `delete` deletes environments, project setups, and completed execution records.

Revoke a key from the same API keys page. Connected AI clients lose access immediately.

## Authentication

Send the token as a bearer credential:

```http
Authorization: Bearer dvk_live_key_...<secret>
```

Keys belong to one organization. A key cannot address an environment, snapshot, or operation from another organization.

## Create an environment

Environment create/start/stop/delete, project setup mutations, prebuild creation, and command execution require an `Idempotency-Key` of 8–200 letters, numbers, dots, underscores, colons, or hyphens. Preview grants, command cancellation, and deletion of completed executions do not require this header. Retrying the same method, path, and body with the same key returns the original response. Reusing the key for a different request returns `409`.

```bash
curl https://app.driftverk.com/v1/environments \
  -X POST \
  -H "Authorization: Bearer $DRIFTVERK_API_KEY" \
  -H "Idempotency-Key: example" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "pr-184",
    "source_type": "image",
    "image": "ghcr.io/example/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "code_trust": "untrusted",
    "automation_id": "github:12345678:pr:184",
    "source_revision": "0123456789abcdef0123456789abcdef01234567",
    "cpu": 2,
    "memory_mb": 4096,
    "disk_gb": 40
  }'
```

Response:

```json
{
  "data": {
    "environment_id": "dev_...",
    "operation_id": "job_...",
    "status": "queued"
  }
}
```

To create from a snapshot, first call `GET /v1/snapshots`, then send `source_type: "snapshot"` and its `snapshot_id`.

Machine-created image environments require an immutable `sha256` digest. Moving tags such as `latest` are rejected. Automated environments default to `code_trust: untrusted` and automatic deletion after six hours. Untrusted environments cannot receive environment variables.

The control plane rejects untrusted environments while `ALLOW_UNTRUSTED_CODE=false`, which is the default. Operators must verify the production compute isolation boundary before enabling that flag.

Use `automation_id` with GitHub's numeric repository ID and pull request number. A GitHub-scoped API key can only see and mutate environments whose ID starts with its configured `github:<repository-id>:pr:` prefix.

Environment-variable values are readable by every process in a trusted environment. Driftverk encrypts them before storage and never returns them, but they are runtime configuration rather than isolated secrets. A snapshot may retain variables already present in the container, so only create one when copying those values into future environments is intentional. Do not put secrets in names, environment names, idempotency keys, or pull request builds.

For any known HTTP port, create a one-hour private preview with `POST /v1/environments/{id}/ports/{port}/preview`. Opening the URL wakes a stopped environment and waits for the port to listen, without waiting for telemetry. The application must start with the container. Treat the returned URL as a bearer credential. Do not post it in a public pull request.

## Reuse a clean project setup

Save an image-based setup through `POST /v1/project-setups` or in the panel. The API accepts the same reusable configuration:

```json
{
  "name": "my-project",
  "configuration": {
    "source_type": "image",
    "image": "driftverk-dev:1",
    "repository": "owner/repository",
    "repository_branch": "main",
    "setup_command": "npm ci",
    "cpu": 2,
    "memory_mb": 4096,
    "auto_stop_minutes": 15
  }
}
```

Creation returns `201` with `{data:{id,name,configuration,created_at}}`. Setup images follow the panel's image rules and may use tags; direct automated image environments still require a digest. Setups may also reference an organization-owned ready snapshot, but clean prebuilds require an image source. Registry references must belong to the organization.

`GET /v1/project-setups` lists setups; `GET /v1/project-setups/{id}` reads one. `PUT /v1/project-setups/{id}` replaces its full name and configuration using the same body as creation. Omitted fields receive defaults, so send the full intended configuration. `DELETE /v1/project-setups/{id}` removes the saved setup. Create/replace require `write`; delete requires `delete`. All three mutations require an idempotency key. Duplicate names return `409`. Repository-scoped keys cannot use these endpoints.

Only reusable fields are stored. Runtime variable values and volume mounts are omitted, and `workspace_path` is derived from the repository. Keep credentials out of images and commands. Replacing or deleting a setup leaves existing prebuilds and environments intact. A build already in progress uses the configuration it captured when it started; wait for it to finish before requesting a build of updated configuration.

Use the returned setup ID as `template_id` to build it:

```http
POST /v1/prebuilds
Authorization: Bearer <api-key>
Idempotency-Key: project-prebuild-001
Content-Type: application/json

{"template_id":"template_..."}
```

The response is `{"data":{"id":"prebuild_...","status":"building"}}`. Optional `compute_node_id` selects a Hybrid host. Poll `GET /v1/prebuilds/{id}` until it is `ready` or `failed`. It includes `template_id`, `snapshot_id`, clean `configuration`, pinned `repository_revision`, timestamps, and `error_message`. `GET /v1/prebuilds` lists the latest 100 builds; direct lookup works for older retained builds too. Only one build runs for a setup at a time; another request during that build returns its ID.

A prebuild starts from a fresh image, pins the configured repository commit, runs setup, captures the filesystem, and deletes the builder. It does not receive runtime variables or volume mounts, and it does not run initialization, startup, or readiness commands. Keep the setup command and image free of embedded credentials: their files and output can become part of the reusable filesystem. Failed builders are queued for cleanup.

Create each working environment from the ready prebuild:

```json
{
  "prebuild_id": "prebuild_...",
  "code_trust": "trusted",
  "name": "agent-task-123",
  "initialization_command": "npm run seed",
  "environment_variables": [{"name":"APP_MODE","value":"test"}]
}
```

Submit this to `POST /v1/environments` with a new idempotency key and wait for its operation to succeed. The prebuild supplies the source snapshot, repository revision, and project defaults. Dependency setup is not repeated. Runtime resources and initialization/startup/readiness commands may be overridden; source and pinned repository remain fixed. Direct repository cloning through environment creation is not supported by the public API; use a prebuild.

`initialization_command` runs once for each newly created environment, after its variables are available and before startup. Use it to initialize that environment's test data. **A seed command does not isolate a shared database**: configure a separate database/schema and credentials when separation is required. Failed initialization may run again on retry, so make it safe to retry. `startup_command` starts the app on create/resume, and `readiness_command` checks it before the environment becomes ready. Each command is limited to 8,000 characters and requires explicitly trusted code. Repository-scoped keys cannot access project setups or prebuilds.

## Execute commands and reconnect

An updated compute agent and `python3` inside the environment image are required. The Driftverk development image includes Python. Commands run as root inside the environment with `/bin/sh -c`, using its runtime configuration and network access.

```http
POST /v1/environments/dev_123/executions
Authorization: Bearer <api-key>
Idempotency-Key: task-123-tests
Content-Type: application/json

{"command":"npm test > test-report.txt 2>&1; result=$?; cat test-report.txt; exit $result","timeout_seconds":900,"artifacts":["test-report.txt"]}
```

Response: `{"data":{"id":"exec_...","environment_id":"dev_123","status":"queued"}}`. Retry with the same key to recover that execution ID after a lost response; do not create another command to reconnect. The environment must be running without an active lifecycle operation. Only one command may be queued/running in each environment.

`cwd` is an optional absolute path (up to 1,000 characters), defaulting to the project workspace or `/`. Commands accept 1–8,000 characters. `timeout_seconds` defaults to 900 and accepts 1–3,600; time starts when the command starts, not while it waits for an agent.

`GET /v1/executions/{id}` returns `status`, `exit_code`, `cancel_requested`, stdout/stderr byte counts, timestamps, and artifact metadata. Terminal statuses are `succeeded`, `failed`, `cancelled`, `timed_out`, `output_limit`, and `lost`. An unavailable exit code is `null`; negative values may identify a terminating signal. A lost execution is not automatically rerun.

For streaming, open `GET /v1/executions/{id}/events` with bearer authentication:

```text
id: 12
event: output
data: {"sequence":"12","stream":"stdout","byte_offset":0,"data":"aGVsbG8K"}
```

Decode `data` from base64 to bytes. Each `output` event identifies stdout or stderr, a stream byte offset, and an opaque decimal-string sequence. A `done` event contains the final execution object. Connections end after about 30 seconds; reconnect with `Last-Event-ID: 12` or `?after=12` until `done`. The header takes precedence over the query. Persist the last consumed event ID to avoid duplicates. Disconnecting does not cancel the command.

Polling clients and MCP can instead use `GET /v1/executions/{id}/output?after=12`. It returns `{"data":[...]}` with up to 100 ordered chunks. Pass the last sequence to continue paging. Both streams are retained up to 1 MiB each, with up to 32 KiB per chunk. Exceeding either output limit terminates the command with `output_limit`.

### Artifacts and cleanup

Declare up to four unique artifact paths at command creation. Paths are relative to `cwd`, at most 300 characters, without absolute paths, empty segments, `.` or `..`. At completion, the agent collects regular files up to 128 KiB each; symlinks and special files are rejected. Execution metadata lists each collected artifact's `path`, `size`, and `error`. Download it with `GET /v1/executions/{id}/artifact?path=test-report.txt`, which returns raw `application/octet-stream` bytes as an attachment. Capture errors return `409`; missing artifacts return `404`. Treat output and artifacts as potentially sensitive runtime data.

`POST /v1/executions/{id}/cancel` cancels queued work immediately or requests cancellation of a running command's process group. Keep polling until terminal status: a cancellation request is not an acknowledgement that the process has stopped. Repeating cancellation is safe.

Start, stop, and snapshot operations reject active executions. To clean up an unavailable or stuck worker, `DELETE /v1/environments/{id}` remains available: it requests cancellation and queues container deletion. Wait for that lifecycle operation to succeed. Automatic stop/deletion waits while executions remain active.

`DELETE /v1/executions/{id}` removes a completed execution's stored output and artifacts. It requires `delete` scope and returns `{"data":{"deleted":true}}`; active executions return `409`. This removes control-plane records, not the environment's files. Delete the environment separately to release its runtime storage. Retained records remain readable after environment deletion until explicitly deleted or pruned. Completed records older than seven days are pruned when the organization submits another execution. Admission is limited to 100 active and 1,000 retained executions per organization; exceeding either returns `429`.

## Lifecycle

```bash
curl https://app.driftverk.com/v1/environments/dev_123/stop \
  -X POST \
  -H "Authorization: Bearer $DRIFTVERK_API_KEY" \
  -H "Idempotency-Key: stop-dev-123-20260904"
```

Start uses `POST /v1/environments/{id}/start`. Delete uses `DELETE /v1/environments/{id}` and requires the `delete` scope.

## MCP

Remote MCP endpoint:

```text
https://app.driftverk.com/mcp
```

The server uses stateless Streamable HTTP and supports two authentication methods:

- **OAuth 2.1** for ChatGPT and other interactive clients. The client discovers Driftverk's authorization server, sends the user to Driftverk to sign in, and asks the user to approve access to the current organization.
- **Driftverk API key** for clients that support a custom bearer token. Configure the token as the `Authorization: Bearer ...` header.

### Connect an interactive client

Follow the [MCP guide](/docs/mcp) for connection setup, permissions and a complete create/run/cleanup walkthrough. In an OAuth-capable remote MCP client, enter the server URL, complete Driftverk sign-in, verify the organization shown at consent and approve the required access.

No Driftverk API key is pasted into ChatGPT. OAuth access and refresh tokens are tied to the user, client, MCP resource, granted scopes, and the organization selected at consent time. Removing the user's organization membership invalidates MCP access on the next request.

OAuth discovery endpoints:

```text
https://app.driftverk.com/.well-known/oauth-protected-resource/mcp
https://app.driftverk.com/.well-known/oauth-authorization-server/api/auth
https://app.driftverk.com/api/auth/jwks
```

### Tools and permissions

The server exposes only the tools allowed by the granted OAuth or API-key scopes:

- `list_environments`
- `get_environment`
- `list_snapshots`
- `get_operation`
- `create_environment`
- `start_environment`
- `stop_environment`
- `delete_environment`
- `list_prebuilds`
- `get_prebuild`
- `list_project_setups`
- `get_project_setup`
- `create_project_setup`
- `update_project_setup`
- `delete_project_setup`
- `create_preview`
- `build_prebuild`
- `execute_command`
- `get_execution`
- `read_execution_output`
- `get_execution_artifact`
- `cancel_execution`
- `delete_execution`

The environment delete tool requires both the environment ID and its exact current name. Project setup deletion requires `template_id` and `idempotency_key` and retains prebuilds and environments. OAuth requests ask for read and write access by default; deletion remains a separate scope and is not requested by the ChatGPT connection by default.

Project setup tools use `template_id` to address an existing setup; create/update accept `name`, `configuration`, and `idempotency_key`. The update replaces the full configuration. `get_prebuild` takes `prebuild_id`. `create_preview` takes `environment_id` and `port` and requires write access. Environment creation accepts `auto_stop_minutes` and `auto_delete_minutes`, including `null` to disable them for trusted work.

Command tools use the same scopes, idempotency keys, limits, and execution IDs as the HTTP API. `read_execution_output` accepts `after` for replay; `get_execution_artifact` returns `{path,data}` with base64 bytes. MCP does not provide the HTTP SSE stream. Volume mounts and Compose projects are not exposed through these tools.

For the recommended GitHub trust boundary, key restriction, digest handoff, and pull-request cleanup flow, see the [GitHub Actions security guide](/v1/docs/github-actions).

## Webhooks

Organization admins can configure signed lifecycle webhooks in the control panel. Delivery is asynchronous and at least once. Receivers must deduplicate events by `webhook-id`. See the [webhook guide](/docs/webhooks) for the payload and signature contract.

## Errors

HTTP errors use this shape:

```json
{
  "error": {
    "code": "request_rejected",
    "message": "Environment not found"
  }
}
```

Every API response includes `X-Request-Id`. Include it when reporting a failed request. See [the OpenAPI document](/v1/openapi.yaml) for the complete request and response contract.

### Current resource and lifecycle limits

CPU and memory limits are enforced. `disk_gb` is retained for API compatibility but does not reserve or limit disk space; environments use shared host storage. `auto_archive_minutes` and `ephemeral` are stored but not enforced. The panel does not offer these settings.

`auto_stop_minutes` measures inactivity. `auto_delete_minutes` measures total time since creation and can delete a running environment, but waits for queued/running executions to finish. The panel shows the scheduled deletion time.

`preview_enabled` defaults to `true`. Set it to `false` when creating an environment to block HTTP preview links. Workspace admins can change the same option later in the environment's Settings tab. Disabling it also invalidates preview links that were already issued because the gateway checks the current environment setting on every request.

Snapshots may retain environment variables already present in the container. The panel asks for confirmation before capturing an environment that has received variables. Do not include secrets unless copying them into future environments is intentional.
