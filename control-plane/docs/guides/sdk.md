# Node.js SDK

The Driftverk SDK is a dependency-free server-side Node.js 22+ client with TypeScript declarations. It is available on [npm](https://www.npmjs.com/package/@driftverk/sdk), with source and releases on [GitHub](https://github.com/Simskii/driftverk-sdk).

## Install

```bash
npm install @driftverk/sdk
```

You can also use the [HTTP API](/docs/api) or [MCP](/docs/mcp).

Store an organization API key in your runtime's secret configuration as `DRIFTVERK_API_KEY`. Grant `read` and `write` for the example below. Do not put the key in browser code.

## Connect and run a command

This example uses an existing running environment you are authorized to use. Set its ID in `DRIFTVERK_ENVIRONMENT_ID`.

```js
import { Driftverk } from '@driftverk/sdk';

const client = new Driftverk({
  baseUrl: 'https://app.driftverk.com',
  apiKey: process.env.DRIFTVERK_API_KEY,
});

const execution = await client.execute(
  process.env.DRIFTVERK_ENVIRONMENT_ID,
  { command: 'printf "Hello from Driftverk\\n"' },
  { idempotencyKey: 'example' },
);

for await (const event of client.events(execution.id)) {
  if (event.type === 'output') {
    const output = event.stream === 'stdout' ? process.stdout : process.stderr;
    output.write(event.bytes);
  } else {
    console.log(event.execution.status, event.execution.exit_code);
  }
}
```

Use a new idempotency key for a new intended command. Persist and reuse the original key when retrying that command after a connection failure.

## Create from a prebuild

Choose a ready prebuild from `listPrebuilds()`, then create a trusted environment:

```js
const created = await client.createEnvironment({
  prebuild_id: process.env.DRIFTVERK_PREBUILD_ID,
  code_trust: 'trusted',
  auto_stop_minutes: 15,
  auto_delete_minutes: 60,
});
await client.waitForOperation(created.operation_id);
console.log(created.environment_id);
```

The selected prebuild must belong to the organization. Repository-scoped automation keys cannot use project prebuilds. See [Project setup](/docs/project-setup) for how to prepare one.

## Reconnect and cancel

`events(id, { after })` reconnects using the last delivered output sequence. `readOutput(id, { after })` provides the same cursor protocol without SSE. Preserve a streaming decoder per output stream if converting arbitrary chunks to text.

Aborting a wait stops observation; it does not stop the command. Call `cancelExecution(id)` and wait for its terminal result. A `lost` execution is not automatically rerun.

## Cleanup

Stopping or deleting an environment returns an operation ID; wait for it to finish. Deletion requires the separate `delete` scope.

```js
const stopped = await client.stopEnvironment(environmentId);
await client.waitForOperation(stopped.operation_id);

// Permanently remove this environment when its files are no longer needed.
const deleted = await client.deleteEnvironment(environmentId);
await client.waitForOperation(deleted.operation_id);
```

Here `environmentId` is the ID of the environment you intend to clean up. Retained command results remain readable after environment deletion. Export required artifacts before deleting their execution records.
