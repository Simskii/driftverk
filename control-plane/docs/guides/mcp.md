# MCP

Connect an AI client to Driftverk to inspect environments, run commands and manage compute in your organization. The remote server uses stateless Streamable HTTP.

## Connect a client

Enter this URL in your client's remote MCP server configuration:

```text
https://app.driftverk.com/mcp
```

For an OAuth-capable client, choose OAuth authentication. Follow Driftverk's sign-in flow, check the organization on the consent screen and approve the required permissions. Start by asking the client to list your environments. Client configuration screens vary; use the client's remote MCP setup instructions.

For a client that supports custom bearer headers, create a key on Driftverk's [API keys](/api-keys) page. Store the key in the client's secret configuration and configure:

```http
Authorization: Bearer YOUR_DRIFTVERK_API_KEY
```

This is the header value, not a complete client configuration file. Do not paste keys into prompts or commit them to a repository. OAuth does not require you to paste a Driftverk API key into the client.

## Permissions

Tools are exposed according to the connection's granted scopes. API keys belong to one organization. OAuth access is bound to the user, client, resource and organization approved at consent time.

| Scope | Tools | Effects |
| --- | --- | --- |
| `read` | `list_environments`, `get_environment`, `list_snapshots`, `get_operation`, `list_project_setups`, `get_project_setup`, `list_prebuilds`, `get_prebuild`, `get_execution`, `read_execution_output`, `get_execution_artifact` | Read configuration, state and retained command results |
| `write` | `create_environment`, `start_environment`, `stop_environment`, `create_project_setup`, `update_project_setup`, `build_prebuild`, `create_preview`, `execute_command`, `cancel_execution` | Change configuration, start compute, issue preview credentials or run code |
| `delete` | `delete_environment`, `delete_project_setup`, `delete_execution` | Permanently remove the named resource |

OAuth requests read and write by default; delete is separate. Starting environments and building prebuilds can incur usage charges. A preview grant may wake a stopped environment. Updating a project setup replaces its full configuration.

Revoke API keys on the API keys page. Removing a user's organization membership invalidates their OAuth MCP access on the next request.

## Walkthrough: create, run and clean up

Use a ready clean prebuild from your organization for this walkthrough. Create it in [Project setups](/docs/project-setup) first. Use an organization connection with read and write access; repository-scoped keys cannot use prebuilds.

Ask your agent:

```text
List my ready Driftverk prebuilds. Let me choose one, then create a
trusted environment from it with a 15-minute idle timeout and a
60-minute total lifetime. Wait for its creation operation to succeed,
run printf 'Hello from Driftverk\n', and show me the output and exit code.
Stop the environment when the command finishes and wait for the stop
operation to succeed.
```

The tool sequence is:

1. `list_prebuilds` to find an eligible source.
2. `create_environment` using its `prebuild_id`, `code_trust: "trusted"`, `auto_stop_minutes: 15`, `auto_delete_minutes: 60` and a new `idempotency_key`.
3. `get_operation` with the returned `operation_id` until it succeeds or fails. Do not execute after failed creation.
4. `execute_command` using the returned `environment_id`, the command and a separate new idempotency key.
5. `get_execution` to inspect status and exit code, and `read_execution_output` to retrieve the base64 output chunks.
6. `stop_environment` with the environment ID and a new idempotency key, then `get_operation` until the stop completes.

Expected output is `Hello from Driftverk` and exit code 0. Stop preserves the filesystem. Delete it from the panel when no longer needed, or grant delete access and use `delete_environment` with its ID, exact current `confirm_environment_name` and a new idempotency key. Wait for the deletion operation to finish.

## Inputs and retries

Use `get_environment` before deleting to confirm the current name. Project setup tools address saved definitions with `template_id`. `get_prebuild` takes `prebuild_id`. `create_preview` takes `environment_id` and an HTTP `port` and returns a private, one-hour access URL.

Use a stable idempotency key for each intended mutation and reuse it on a transport retry. Use a different key for a different action. A request being accepted does not mean its asynchronous operation succeeded.

Command tools return an execution ID. Pass the last output sequence as the string `after` to `read_execution_output` when reconnecting. `get_execution_artifact` takes `execution_id` and a declared artifact `path`, and returns base64 data. Cancellation requires `cancel_execution` followed by status polling.

## Limits and availability

Direct image creation requires an immutable image digest. Automated environments default to untrusted code; that mode is disabled unless the operator enables it after verifying isolation. Untrusted environments cannot receive runtime variables. Ready clean prebuilds require trusted mode.

Commands need an updated compute agent and an image with `/bin/sh` and Python 3. There is one active tracked execution per environment. Timeouts range from 1 to 3,600 seconds, with a default of 900 seconds. Output is capped at 1 MiB per stream; each of up to four artifacts is capped at 128 KiB.

MCP provides polling for output, not the HTTP SSE stream. Volume mounts and direct Compose management are not exposed as MCP tools. Configure Compose in the repository and project setup instead.

If a tool listed here is missing, check granted scopes and the deployed server version. See [Troubleshooting](/docs/troubleshooting#mcp-connection-or-tools-are-missing) and the [API contract](/v1/openapi.yaml).
