import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { commandEnvironment, DockerSandboxRuntime, parseListeningPorts } from "./docker-runtime.mjs";

function sandbox(overrides = {}) {
  return {
    id: "dev_test",
    name: "example-vm",
    runtime_id: null,
    source: { type: "image", image: "debian:bookworm-slim", registry: null },
    resources: { cpu: 2, memory_mb: 4096, disk_gb: 40 },
    environment: { API_TOKEN: "super-secret" },
    ...overrides,
  };
}

test("rebuilds a stale development image and reuses the current version", async () => {
  const staleCalls = [];
  const stale = new DockerSandboxRuntime({ runner: async (_command, args) => {
    staleCalls.push(args);
    if (args[0] === "image" && args[1] === "inspect") return { stdout: "1\n", stderr: "" };
    return { stdout: "", stderr: "" };
  } });
  await stale.loginAndPull("driftverk-dev:1", null);
  assert.ok(staleCalls.some(args => args[0] === "build"));

  const currentCalls = [];
  const current = new DockerSandboxRuntime({ runner: async (_command, args) => {
    currentCalls.push(args);
    return { stdout: "3\n", stderr: "" };
  } });
  await current.loginAndPull("driftverk-dev:1", null);
  assert.ok(!currentCalls.some(args => args[0] === "build"));
});

test("creates an OCI sandbox without putting secret values in argv", async () => {
  const calls = [];
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args, env: options.env });
    if (args[0] === "inspect") throw new Error("not found");
    if (args[0] === "create") return { stdout: "container-123", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const steps = [];
  const runtime = new DockerSandboxRuntime({
    runner,
    runtime: "sysbox-runc",
    network: "driftverk-sandboxes",
  });
  const runtimeId = await runtime.create(sandbox(), async (step, id) => {
    steps.push(step);
    if (id) { assert.equal(id,"container-123"); assert.ok(calls.some(call=>call.args[0]==="start"),"runtime metering begins only after Docker start"); }
  });

  assert.equal(runtimeId, "container-123");
  assert.deepEqual(steps, ["restoring", "booting", "connecting"]);
  const createCall = calls.find((call) => call.args[0] === "create");
  assert.ok(createCall.args.includes("sysbox-runc"));
  assert.ok(createCall.args.includes("driftverk-sandboxes"));
  assert.ok(createCall.args.includes("--init"));
  assert.deepEqual(createCall.args.slice(createCall.args.indexOf("--hostname"), createCall.args.indexOf("--hostname") + 2), ["--hostname", "example-vm"]);
  assert.ok(createCall.args.includes("API_TOKEN"));
  assert.ok(!createCall.args.includes("super-secret"));
  assert.equal(createCall.env.API_TOKEN, "super-secret");
  assert.ok(createCall.args.includes("exec sleep infinity"));
});

test("bind mounts prepared volumes into the sandbox", async () => {
  const calls = [];
  const prepared = [];
  const runner = async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect") throw new Error("not found");
    if (args[0] === "create") return { stdout: "container-with-volume", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerSandboxRuntime({
    runner,
    volumeStorage: {
      async prepare(volumes) {
        prepared.push(volumes);
        return volumes.map((volume) => ({ ...volume, source_path: "/var/lib/driftverk/volumes/vol_test/fixtures" }));
      },
    },
  });
  await runtime.create(sandbox({ volumes: [{ id: "vol_test", mount_path: "/datasets", subpath: "fixtures", read_only: true }] }));

  assert.equal(prepared[0][0].mount_path, "/datasets");
  const createCall = calls.find((args) => args[0] === "create");
  assert.ok(createCall.includes("type=bind,source=/var/lib/driftverk/volumes/vol_test/fixtures,target=/datasets,bind-propagation=rslave,readonly"));
});

test("runs the image command when the image exposes a web port", async () => {
  const calls = [];
  const runner = async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect") throw new Error("not found");
    if (args[0] === "image" && args[1] === "inspect") return { stdout: '{"80/tcp":{}}', stderr: "" };
    if (args[0] === "create") return { stdout: "nginx-container", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerSandboxRuntime({ runner });
  await runtime.create(sandbox({ source: { type: "image", image: "nginx:latest", registry: null } }));
  const createCall = calls.find((args) => args[0] === "create");
  assert.ok(createCall.includes("driftverk.start-mode=image"));
  assert.equal(createCall.at(-1), "nginx:latest");
  assert.ok(!createCall.includes("exec sleep infinity"));
});

test("restores a snapshot from its resolved local OCI artifact", async () => {
  const calls = [];
  const runner = async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect") throw new Error("not found");
    if (args[0] === "create") return { stdout: "container-from-snapshot", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerSandboxRuntime({ runner });
  const runtimeId = await runtime.create(sandbox({ source: { type: "snapshot", image: "driftverk/snapshot-snap_1:latest", snapshot_id: "snap_1", registry: null } }));
  assert.equal(runtimeId, "container-from-snapshot");
  assert.ok(!calls.some((args) => args[0] === "pull"));
});

test("asks durable storage to resolve a snapshot before creating the sandbox", async () => {
  const calls = [];
  const restored = [];
  const runner = async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect") throw new Error("not found");
    if (args[0] === "create") return { stdout: "container-from-s3", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerSandboxRuntime({
    runner,
    snapshotStorage: {
      async restore(input) {
        restored.push(input);
        return "driftverk/snapshot-snap_1:latest";
      },
    },
  });
  await runtime.create(sandbox({ source: {
    type: "snapshot",
    image: "s3://customer-snapshots/driftverk/snap_1.oci.tar.gz",
    snapshot_id: "snap_1",
    registry: null,
  } }));

  assert.equal(restored[0].snapshotId, "snap_1");
  assert.equal(restored[0].artifactRef, "s3://customer-snapshots/driftverk/snap_1.oci.tar.gz");
  assert.ok(calls.find((args) => args[0] === "create").includes("driftverk/snapshot-snap_1:latest"));
});

test("captures an environment as a paused local OCI snapshot", async () => {
  const calls = [];
  const runner = async (_command, args) => {
    calls.push(args);
    if (args[0] === "image") return { stdout: "250000000", stderr: "" };
    return { stdout: "snapshot", stderr: "" };
  };
  const runtime = new DockerSandboxRuntime({ runner });
  const result = await runtime.snapshot(sandbox({ runtime_id: "container-123" }), { id: "snap_1" });
  assert.equal(result.snapshotSizeGb, 0.25);
  assert.equal(result.artifactRef, "driftverk/snapshot-snap_1:latest");
  const commit = calls.find((args) => args[0] === "commit");
  assert.ok(commit?.includes("--pause=true"));
  assert.ok(commit?.includes("LABEL driftverk.managed=true"));
  assert.ok(commit?.includes("LABEL driftverk.resource=snapshot"));
  assert.ok(commit?.includes("LABEL driftverk.snapshot-id=snap_1"));
});

test("captures snapshots that include environment variables", async () => {
  const calls = [];
  const runtime = new DockerSandboxRuntime({
    runner: async (_command, args) => {
      calls.push(args);
      return args[0] === "image" ? { stdout: "250000000", stderr: "" } : { stdout: "snapshot", stderr: "" };
    },
  });
  await assert.doesNotReject(runtime.snapshot(sandbox({ runtime_id: "container-123", snapshot_allowed: false }), { id: "snap_1" }));
  assert.ok(calls.some((args) => args[0] === "commit"), "environment variables must not block snapshot capture");
});

test("does not pass control-plane credentials to Docker subprocesses", () => {
  const previousToken = process.env.COMPUTE_AGENT_TOKEN;
  process.env.COMPUTE_AGENT_TOKEN = "infrastructure-secret";
  try {
    const environment = commandEnvironment({ CUSTOMER_VALUE: "customer-value" });
    assert.equal(environment.CUSTOMER_VALUE, "customer-value");
    assert.equal(environment.COMPUTE_AGENT_TOKEN, undefined);
  } finally {
    if (previousToken === undefined) delete process.env.COMPUTE_AGENT_TOKEN;
    else process.env.COMPUTE_AGENT_TOKEN = previousToken;
  }
});

test("publishes a captured snapshot through the configured storage", async () => {
  const published = [];
  const runner = async (_command, args) => {
    if (args[0] === "image") return { stdout: "250000000", stderr: "" };
    return { stdout: "snapshot", stderr: "" };
  };
  const runtime = new DockerSandboxRuntime({
    runner,
    snapshotStorage: {
      async publish(input) {
        published.push(input);
        return { artifactRef: "s3://bucket/snap_1.oci.tar.gz", sizeBytes: 100000000 };
      },
    },
  });
  const result = await runtime.snapshot(sandbox({ runtime_id: "container-123" }), { id: "snap_1" });

  assert.equal(published[0].imageRef, "driftverk/snapshot-snap_1:latest");
  assert.equal(result.artifactRef, "s3://bucket/snap_1.oci.tar.gz");
  assert.equal(result.snapshotSizeGb, 0.1);
});

test("starts, stops and deletes by provider runtime ID", async () => {
  const calls = [];
  const runner = async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect") return { stdout: "container-123", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerSandboxRuntime({ runner });
  const target = sandbox({ runtime_id: "container-123" });
  await runtime.start(target);
  await runtime.stop(target);
  await runtime.delete(target);
  assert.ok(calls.some((args) => args[0] === "start"));
  assert.ok(calls.some((args) => args[0] === "stop"));
  assert.ok(calls.some((args) => args[0] === "rm"));
});

test("reuses a deterministic container after a lease retry", async () => {
  const calls = [];
  const runner = async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect") return { stdout: "existing-container", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerSandboxRuntime({ runner });
  const runtimeId = await runtime.create(sandbox());
  assert.equal(runtimeId, "existing-container");
  assert.ok(calls.some((args) => args[0] === "start"));
  assert.ok(!calls.some((args) => args[0] === "create"));
});

test("detects reachable listening ports and ignores loopback listeners", () => {
  const output = [
    "LISTEN 0 4096 127.0.0.11:38849 0.0.0.0:*",
    "LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*",
    "LISTEN 0 4096 [::]:8000 [::]:*",
    "LISTEN 0 4096 [::1]:9000 [::]:*",
  ].join("\n");
  assert.deepEqual(parseListeningPorts(output), [3000, 8000]);
});

test("runtime telemetry does not classify background resource usage as access", async () => {
  let statsOutput = JSON.stringify({ CPUPerc: "0.00%", MemUsage: "12MiB / 4GiB", MemPerc: "0.30%", NetIO: "1kB / 1kB", BlockIO: "0B / 0B" });
  const runner = async (_command, args) => {
    if (args[0] === "ps") return { stdout: "container-123 dev_test", stderr: "" };
    if (args[0] === "stats") return { stdout: statsOutput, stderr: "" };
    if (args[0] === "exec") return { stdout: "Filesystem 1024 512 512 50% /", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerSandboxRuntime({ runner });
  assert.equal((await runtime.telemetry())[0].active, undefined);
  statsOutput = JSON.stringify({ CPUPerc: "75.00%", MemUsage: "12MiB / 4GiB", MemPerc: "0.30%", NetIO: "1kB / 2kB", BlockIO: "5MiB / 9MiB" });
  assert.equal((await runtime.telemetry())[0].active, undefined);
});

test("development setup sends clone credentials only over stdin and runs setup separately", async () => {
  const calls = [], steps = [];
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (args.includes('test -f "$1/ready"')) throw new Error("not ready");
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerSandboxRuntime({ runner });
  await runtime.prepareDevelopment("container", { id: "dev_1", development: { repository: "acme/app", branch: "main", token: "private-test-token", setup_command: "npm ci" } }, async step => steps.push(step));
  assert.deepEqual(steps, ["cloning", "setting-up"]);
  assert.ok(calls.some(call => call.options.stdin === "private-test-token\n"));
  assert.ok(calls.every(call => !JSON.stringify(call.args).includes("private-test-token")));
  const setup = calls.find(call => call.args.includes("npm ci"));
  assert.equal(setup.options.stdin, "");
  assert.ok(calls.at(-1).args.includes('mkdir -p "$1"; touch "$1/ready"'));
});

test("completed setup is not rerun and clone failure cannot expose credentials", async () => {
  let count = 0;
  const complete = new DockerSandboxRuntime({ runner: async () => { count++; return { stdout: "", stderr: "" }; } });
  await complete.prepareDevelopment("container", { id: "dev_2", development: { repository: "acme/app" } }, async () => {});
  assert.equal(count, 1);
  const failing = new DockerSandboxRuntime({ runner: async () => { throw new Error("private-token in git output"); } });
  await assert.rejects(failing.prepareDevelopment("container", { id: "dev_2", development: { repository: "acme/app", token: "private-token" } }, async () => {}), error => !error.message.includes("private-token") && error.message.includes("Repository setup failed"));
});

test("project readiness gates completion on creation and resume and keeps errors private", async () => {
  const calls = [], steps = [];
  const runtime = new DockerSandboxRuntime({ runner: async (_command, args) => {
    calls.push(args);
    if (args.includes("driftverk-project") && args.some(arg => arg.includes("timeout -k 5 120"))) throw new Error("sensitive-command-output");
    return { stdout: "", stderr: "" };
  } });
  const project = sandbox({ runtime_id: "container", development: { startup_command: "npm run dev", readiness_command: "curl localhost:3000", workspace_path: "/workspace" } });
  await assert.rejects(runtime.start(project, async step => steps.push(step)), error => {
    assert.match(error.message, /readiness check failed or did not pass/);
    assert.equal(error.message.includes("sensitive-command-output"), false);
    return true;
  });
  assert.deepEqual(steps, ["booting", "starting-services", "checking-app"]);
  assert.ok(calls.some(args => args[0] === "exec" && args.includes("-d")), "startup runs in the background");
  assert.ok(!steps.includes("connecting"), "failed readiness cannot finish startup");
});

test("automatically starts a standard root Compose project", async () => {
  const calls = [], steps = [];
  const runtime = new DockerSandboxRuntime({ runner: async (_command, args) => {
    calls.push(args);
    if (args.includes("driftverk-detect-compose")) return { stdout: "compose.yaml", stderr: "" };
    return { stdout: "", stderr: "" };
  } });
  const project = sandbox({ runtime_id: "container", development: { repository: "acme/app", workspace_path: "/workspaces/app" } });
  await runtime.start(project, async step => steps.push(step));
  assert.deepEqual(steps, ["booting", "starting-services", "checking-app", "connecting"]);
  assert.ok(calls.some(args => args.includes("driftverk-detect-compose")));
  assert.ok(calls.some(args => args.some(arg => arg.includes("then docker compose -f compose.yaml up -d --build; else docker-compose"))));
  assert.ok(calls.some(args => args.some(arg => arg.includes("then ids=$(docker compose -f compose.yaml ps -a -q); else ids=$(docker-compose"))));
});

test("starts Compose from a restored working directory without cloning a repository", async () => {
  const calls = [], steps = [];
  const runtime = new DockerSandboxRuntime({ runner: async (_command, args) => {
    calls.push(args);
    if (args.includes("driftverk-detect-compose")) return { stdout: "compose.yaml", stderr: "" };
    return { stdout: "", stderr: "" };
  } });
  const project = sandbox({ runtime_id: "container", development: { workspace_path: "/workspaces/app" } });
  await runtime.start(project, async step => steps.push(step));
  assert.deepEqual(steps, ["booting", "starting-services", "checking-app", "connecting"]);
  assert.ok(calls.some(args => args.includes("driftverk-detect-compose")));
  assert.ok(calls.some(args => args.some(arg => arg.includes("then docker compose -f compose.yaml up -d --build; else docker-compose"))));
  assert.ok(calls.some(args => args.some(arg => arg.includes("then ids=$(docker compose -f compose.yaml ps -a -q); else ids=$(docker-compose"))));
});

test("setup failure keeps command output in the environment and does not mark setup complete", async () => {
  const calls = [];
  const runtime = new DockerSandboxRuntime({ runner: async (_command, args) => {
    calls.push(args);
    if (args.some(arg => arg.includes('test -f "$1/ready"'))) throw new Error("missing marker");
    if (args.some(arg => arg.includes("setup.log"))) throw new Error("secret-from-command");
    return { stdout: "", stderr: "" };
  } });
  await assert.rejects(runtime.prepareDevelopment("container", sandbox({ development: { setup_command: "false" } }), async () => {}), error => {
    assert.match(error.message, /setup.log/);
    assert.equal(error.message.includes("secret-from-command"), false);
    return true;
  });
  assert.ok(!calls.some(args => args.some(arg => arg.includes('touch "$1/ready"'))));
});


test("Compose readiness waits for completion and rejects missing, starting and failed services", async t => {
  let script;
  const runtime = new DockerSandboxRuntime({ runner: async (_command, args) => {
    if (args.includes("driftverk-detect-compose")) return { stdout: "compose.yaml" };
    if (args.some(arg => arg.includes("driftverk-check"))) script = args.at(-1);
    return { stdout: "", stderr: "" };
  } });
  await runtime.start(sandbox({ runtime_id: "container", development: { repository: "acme/app" } }));
  const dir = await mkdtemp(join(tmpdir(), "compose-ready-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "docker"), `#!/bin/sh
case "$1" in
 compose)
   case "$*" in *version*) exit 0;; *) printf '%s' "$IDS";; esac ;;
 inspect)
   case "$3" in *ExitCode*) echo "$EXIT_CODE";; *Health*) echo "$HEALTH_STATE";; *) echo "$SERVICE_STATE";; esac ;;
esac
`, { mode: 0o755 });
  const check = env => spawnSync("sh", ["-c", script, "check", dir, dir], {
    env: { ...process.env, PATH: dir + ":" + process.env.PATH, IDS: "service", SERVICE_STATE: "running", HEALTH_STATE: "healthy", EXIT_CODE: "0", ...env },
  }).status;
  assert.notEqual(check({}), 0, "running subset cannot pass before Compose completes");
  await writeFile(join(dir, "startup.exit"), "0");
  assert.notEqual(check({ IDS: "" }), 0);
  assert.notEqual(check({ SERVICE_STATE: "created" }), 0);
  assert.notEqual(check({ SERVICE_STATE: "starting" }), 0);
  assert.notEqual(check({ HEALTH_STATE: "unhealthy" }), 0);
  assert.notEqual(check({ HEALTH_STATE: "starting" }), 0);
  assert.notEqual(check({ SERVICE_STATE: "exited", EXIT_CODE: "1" }), 0);
  assert.equal(check({ SERVICE_STATE: "exited", EXIT_CODE: "0" }), 0, "successful build job is allowed");
  assert.equal(check({}), 0);
  await writeFile(join(dir, "startup.exit"), "1");
  assert.notEqual(check({}), 0);
});

test("telemetry includes project and named Compose service logs", async () => {
  const runtime = new DockerSandboxRuntime({ runner: async (_command, args) => {
    if (args[0] === "ps") return { stdout: "container dev_test" };
    if (args.includes("driftverk-project-logs")) return { stdout: "[startup] Build started\n[compose:client] npm error E401" };
    if (args[0] === "stats") return { stdout: "{}" };
    return { stdout: "", stderr: "" };
  } });
  const [sample] = await runtime.telemetry();
  assert.ok(sample.logs.includes("[startup] Build started"));
  assert.ok(sample.logs.includes("[compose:client] npm error E401"));
});

test("application telemetry tracks builds, health failures, recovery and successful jobs", async () => {
  const { parseApplicationStatus } = await import("./docker-runtime.mjs");
  const service = (name, state = "running", health = "healthy", code = 0) => `${JSON.stringify(name)} ${JSON.stringify(state)} ${JSON.stringify(health)} ${code}`;
  assert.equal(parseApplicationStatus(""), null);
  assert.equal(parseApplicationStatus("configured\nstartup:pending").status, "starting");
  assert.equal(parseApplicationStatus("configured\nstartup:1").status, "failed");
  const ready = `configured\nstartup:0\nexpected:db\nexpected:client\n${service("db")}\n${service("client", "exited", "none")}`;
  assert.equal(parseApplicationStatus(ready).status, "ready");
  assert.equal(parseApplicationStatus(ready.replace('"healthy"', '"starting"')).status, "starting");
  assert.equal(parseApplicationStatus(ready.replace('"healthy"', '"unhealthy"')).status, "failed");
  assert.equal(parseApplicationStatus(ready.replace('"exited" "none" 0', '"exited" "none" 1')).status, "failed");
  assert.equal(parseApplicationStatus(ready + '\nexpected:preview').status, "failed");
  assert.equal(parseApplicationStatus(ready).services.length, 2);
  assert.equal(parseApplicationStatus(ready.replace("startup:0", "startup:1")).status, "ready", "manual repair recovers a failed startup");
  assert.equal(parseApplicationStatus(service("api", "restarting", "none", 1)).status, "failed");
});

for (const operation of ["start", "create"]) {
  test(`${operation} applies changed limits before reusing a container`, async () => {
    const calls = [];
    const runtime = new DockerSandboxRuntime({ runner: async (_command, args) => {
      calls.push(args);
      return { stdout: args[0] === "inspect" ? "container" : "" };
    } });
    const target = sandbox({ runtime_id: "container", resources: { cpu: 1, memory_mb: 1024 } });
    await runtime[operation](target);
    assert.deepEqual(calls.find(args => args[0] === "update"), ["update", "--cpus", "1", "--memory", "1024m", "--memory-swap", "2048m", "container"]);
    assert.ok(calls.findIndex(args => args[0] === "update") < calls.findIndex(args => args[0] === "start"));
    assert.equal(calls.some(args => args[0] === "rm" || args[0] === "create"), false);
  });
  test(`${operation} does not start when applying limits fails`, async () => {
    const calls = [];
    const runtime = new DockerSandboxRuntime({ runner: async (_command, args) => {
      calls.push(args);
      if (args[0] === "update") throw new Error("resource update failed");
      return { stdout: args[0] === "inspect" ? "container" : "" };
    } });
    await assert.rejects(runtime[operation](sandbox({ runtime_id: "container" })), /resource update failed/);
    assert.equal(calls.some(args => args[0] === "start"), false);
  });
}

test('Sysbox snapshot rejects a running environment before committing', async () => {
  const calls = [];
  const runtime = new DockerSandboxRuntime({ runtime: 'sysbox-runc', runner: async (_cmd, args) => {
    calls.push(args);
    return { stdout: 'running', stderr: '' };
  } });
  await assert.rejects(runtime.snapshot(sandbox({ runtime_id: 'container-123' }), { id: 'snap_1' }), /Stop the environment/);
  assert.deepEqual(calls.map(args => args[0]), ['inspect']);
});

test('Sysbox prebuild stops its builder before capture', async () => {
  const calls = [];
  const runtime = new DockerSandboxRuntime({ runtime: 'sysbox-runc', runner: async (_cmd, args) => {
    calls.push(args);
    if (args.includes('{{.State.Status}}')) return { stdout: 'running' };
    if (args.includes('{{json .Config}}')) return { stdout: '{"Cmd":["sleep","infinity"]}' };
    if (args.includes('{{.Size}}')) return { stdout: '100' };
    return { stdout: 'image-123' };
  } });
  await runtime.snapshot(sandbox({ runtime_id: 'container-123', purpose: 'prebuild' }), { id: 'snap_1' });
  assert.ok(calls.findIndex(args => args[0] === 'stop') < calls.findIndex(args => args[0] === 'commit'));
  assert.ok(!calls.some(args => args[0] === 'start'));
});

test('Sysbox snapshot preserves a stopped environment', async () => {
  const calls = [];
  const runtime = new DockerSandboxRuntime({ runtime: 'sysbox-runc', runner: async (_cmd, args) => {
    calls.push(args);
    return { stdout: args.includes('{{.State.Status}}') ? 'exited' : '100' };
  } });
  await runtime.snapshot(sandbox({ runtime_id: 'container-123' }), { id: 'snap_1' });
  assert.ok(calls.some(args => args[0] === 'commit'));
  assert.ok(!calls.some(args => ['stop', 'start'].includes(args[0])));
});
