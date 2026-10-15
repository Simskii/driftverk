# Driftverk SDK

A dependency-free, server-side Node.js 22+ client with TypeScript declarations. This package is local to the repository and has not been published to npm. Install it in another project with `npm install /absolute/path/to/driftverk-panel/sdk`, then import `Driftverk` from `@driftverk/sdk`.

```js
import { Driftverk } from './sdk/index.mjs';
const client = new Driftverk({
  baseUrl: process.env.DRIFTVERK_URL, // origin, without /v1
  apiKey: process.env.DRIFTVERK_API_KEY,
});
```

Use an organization API key with `read`, `write` and `delete` scopes for the complete workflow. Repository-scoped GitHub automation keys cannot build or use project prebuilds. They can execute commands only in environments allowed by their repository scope.

## Build once, reuse the filesystem

Define a reusable project setup in code, then build it:

```js
const setup = await client.createProjectSetup({
  name: 'my-project',
  configuration: {
    image: 'driftverk-dev:1',
    repository: 'owner/repository',
    repository_branch: 'main',
    setup_command: 'npm ci',
    cpu: 2,
    memory_mb: 4096,
  },
}, { idempotencyKey: 'my-project-definition-v1' });
const build = await client.buildPrebuild({ template_id: setup.id });
const ready = await client.waitForPrebuild(build.id);
const created = await client.createEnvironment({
  prebuild_id: ready.id,
  code_trust: 'trusted',
  environment_variables: [{ name: 'APP_MODE', value: 'development' }],
});
await client.waitForOperation(created.operation_id);
```

The same setups appear in the panel. `listProjectSetups()` and `getProjectSetup(id)` read them. `updateProjectSetup(id, { name, configuration })` replaces the full definition, with omitted settings reset to defaults. `deleteProjectSetup(id)` removes the definition while keeping existing prebuilds and environments. Setup mutations support `idempotencyKey` and `signal` just like environment creation. Use a new key for each intended change and reuse it when retrying that change.

`getPrebuild(id)` reads any retained prebuild directly. `waitForPrebuild(id)` uses this lookup, so it keeps working when a build is outside the latest 100 returned by `listPrebuilds()`.

## Environment lifecycle

```js
const environments = await client.listEnvironments();
const snapshots = await client.listSnapshots();
const stopped = await client.stopEnvironment(created.environment_id);
await client.waitForOperation(stopped.operation_id);
const started = await client.startEnvironment(created.environment_id);
await client.waitForOperation(started.operation_id);
const preview = await client.createPreview(created.environment_id, 3000);
// preview.url is private and expires at preview.expires_at.
```

Start and stop require `write` scope; delete requires `delete`. Each returns an operation ID and accepts `idempotencyKey`. Preview creation requires `write` and can wake a stopped environment. Reads and preview creation accept an optional `signal`. Set `auto_stop_minutes` and `auto_delete_minutes` at environment creation to control idle shutdown and total lifetime; use `null` to disable them for trusted work.

A prebuild starts from the configured image, resolves the repository to a commit, clones and installs dependencies, then captures the filesystem. The builder has no runtime variables, volume mounts, initialization command or startup services. Registry authentication and temporary GitHub clone authentication still apply. Choose images and install commands that contain no embedded secrets.

Each environment gets its own writable filesystem. Its initialization command runs once after variable injection, before startup and readiness checks. Use it to seed a database inside the environment, or configure a distinct database per environment. An initialization command does not automatically isolate a shared external database. Initialization must be safe to retry if interrupted before its completion marker is written.

Prebuilds run on demand; they do not automatically rebuild on push. Local snapshot placement follows the original host; shared S3 snapshots follow existing storage compatibility checks. Snapshots of working environments may retain runtime variables and credentials already present in the container; capture them only when copying that state is intentional.

## Run, reconnect, collect results

```js
const execution = await client.execute(created.environment_id, {
  command: 'npm test',
  timeout_seconds: 900,
  artifacts: ['test-results.json'],
}, { idempotencyKey: 'my-durable-run-id' });

for await (const event of client.events(execution.id)) {
  if (event.type === 'output') {
    (event.stream === 'stdout' ? process.stdout : process.stderr).write(event.bytes);
    // Persist event.sequence if you need to resume in a new client process.
  } else {
    console.log(event.execution.status, event.execution.exit_code);
  }
}
const report = await client.artifact(execution.id, 'test-results.json');
```

`events(id, { after })` reconnects with the last delivered output sequence. The server closes idle streams after 30 seconds; the client reconnects until completion. `readOutput(id, { after })` provides the same cursor protocol without SSE. Output contains base64 data so arbitrary bytes and partial UTF-8 characters survive transport. SDK events also expose decoded `Uint8Array` bytes. Preserve a separate streaming text decoder per output stream if displaying text.

Persist your idempotency key and execution ID in the caller's job record. Transport retries reuse the key within a request. Retrying the same command in a new process must reuse the same key. A terminal `lost` execution means the sandbox supervisor disappeared; Driftverk does not rerun that command automatically.

Aborting a stream or wait stops observation. To stop the command, call `cancelExecution(id)` and wait for its terminal result. Cancellation and timeouts kill the command's process group; processes that deliberately detach into another session are outside that group. Delete the environment to terminate everything in it.

## Cleanup and limits

```js
await client.cancelExecution(execution.id);
await client.waitForExecution(execution.id, { timeoutMs: 30000 });
const deleted = await client.deleteEnvironment(created.environment_id);
await client.waitForOperation(deleted.operation_id);
// Retained results remain readable after environment deletion.
await client.deleteExecution(execution.id);
```

Environment deletion can also proceed when an execution is active or unreachable. It requests cancellation and queues container deletion. Cleanup still needs the assigned compute host to be online. Stop and snapshot operations reject active executions; automatic stop and deletion wait for them.

- One active execution per environment, up to 100 per organization.
- Commands have a 1–3600 second timeout, default 900, starting when the sandbox supervisor launches them.
- Output is limited to 1 MiB per stream. Exceeding either limit terminates the command with `output_limit`.
- Declare up to four regular-file artifacts relative to `cwd`, each at most 128 KiB. Symlinks, special files and dot segments are rejected. Artifact errors do not change the command's exit result.
- The control plane retains up to 1,000 executions per organization. Completed records older than seven days are removed when a new execution is submitted. Explicit deletion removes stored output and artifacts from the control plane. Sandbox spool files last until the environment is deleted.
- Compute agents must be updated. Custom images need `/bin/sh` and Python 3; `driftverk-dev:1` includes them. Missing or unreachable compute cannot complete commands or confirm cancellation.

[`examples/define-project.mjs`](./examples/define-project.mjs) saves a setup and builds it without the panel. [`examples/project-agent.mjs`](./examples/project-agent.mjs) uses a ready prebuild for a complete run with environment cleanup in `finally`, and writes a test report to the local working directory. Run `npm run sdk:test` and `npm run sdk:check` from the repository root for runtime tests and the TypeScript consumer check. The SDK additions require the updated control plane, including direct prebuild lookup.
