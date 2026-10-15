# Troubleshooting

Start with the environment's state, project output and assigned host. A connected host, a running container and a working application are separate checks.

## Environment stays queued

Inspect the queue reason and Compute hosts. Check available CPU and memory, host health and whether the assigned host is online. `insufficient_capacity` means the scheduler cannot place the requested resources; free capacity, choose smaller resources or add a compatible host.

Local snapshots and existing environments may require their original host. Adding an unrelated healthy host will not move them. Also check the organization's access and Cloud balance.

## Setup or readiness failed

Open Terminal, connect and choose **Show project output**. Read the first failed command, not only the final error. Check repository permissions, dependency installation and whether the image contains the required tools.

Correct the command and choose **Retry setup**. A readiness command must exit 0 within the retry window. Without a readiness command, test the app yourself. Failed setup may leave compute running; stop it when finished investigating.

## Preview does not open

1. Confirm the application starts through the configured startup command or Compose project.
2. Confirm it listens on `0.0.0.0` at the selected HTTP port.
3. Check logs and test the application inside the environment.
4. Generate a fresh preview if the link expired, and check that previews are enabled.
5. If the internal app works, inspect the host's data-tunnel and gateway checks.

Opening a valid preview can wake an environment stopped automatically. An explicitly stopped environment needs **Start** or `driftverk start NAME` first. A ready container does not guarantee a working external preview.

## Terminal or SSH fails

Check host connectivity and the data tunnel. For SSH, add your public key in Settings and use the exact command shown by the environment. Do not use an environment's internal container address as a public endpoint.

For private-key selection, remote sign-in and desktop app setup, see [Codex and T3 Code over SSH](/docs/codex-and-t3-code).

On a Hybrid host, run `sudo driftverk-agent doctor` and inspect `sudo driftverk-agent logs`. Update an outdated agent before testing features introduced by a newer control plane.

## Desktop or recording fails

Check `driftverk-browser status` in the environment's Terminal. Missing commands mean the image predates desktop support or is a custom image without the tools. Updating your local CLI does not update the environment.

After an idle desktop stops, reopen it through the Desktop tab or CLI. If a prompt is still running, finish or cancel it before choosing **Stop desktop**. For missing videos, retain the run ID and check its `status.json` and `recorder.log`. See [Browser and desktop](/docs/desktop) for recovery commands, credentials and connection requirements.

## MCP connection or tools are missing

Use `https://app.driftverk.com/mcp` with Streamable HTTP. For API-key clients, send the key in the Authorization bearer header. For OAuth clients, verify the organization on the consent screen and reconnect if access changed.

Read-only credentials do not expose write or delete tools. Deletion is not granted by default for OAuth. Revoked keys and removed organization membership invalidate access. See [MCP](/docs/mcp).

## Command output stopped arriving

Keep the execution ID and call `get_execution` or the HTTP equivalent. Resume output with the last sequence cursor; MCP output uses base64 chunks. Losing a client connection does not cancel the command.

This applies to API/MCP executions. `driftverk prompt` instead cancels its agent when its CLI heartbeat disappears and attempts to finalize any recording. Reconnect and [recover the video](/docs/desktop#recover-a-recording) using the printed run ID.

A terminal `lost` state means the supervisor disappeared. Do not assume the command never ran and retry it blindly. Reconcile its effects first. Use explicit cancellation and wait for confirmation when a command must stop.

## Request help

Include the environment or operation ID, approximate time, failed step, sanitized error and host agent version. API responses include `X-Request-Id`; include it when available.

Remove tokens, private preview URLs, environment-variable values and customer data from logs before sharing them with support at [hello@driftverk.com](mailto:hello@driftverk.com).
