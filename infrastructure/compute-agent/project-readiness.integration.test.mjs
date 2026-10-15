import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DockerSandboxRuntime } from "./docker-runtime.mjs";

const exec = promisify(execFile);
// Opt in on a local Docker engine with the development image already available.
test("real container starts an app, reuses setup on retry, and restarts services on resume", { skip: process.env.DRIFTVERK_RUNTIME_QA !== "1", timeout: 90000 }, async () => {
  const name = `driftverk-readiness-qa-${process.pid}`;
  let created = false;
  try {
    const { stdout } = await exec("docker", ["run", "-d", "--name", name, "--label", "driftverk.qa=readiness", "--network", "none", "--init", "--entrypoint", "sh", process.env.DRIFTVERK_QA_IMAGE || "driftverk-dev:1", "-c", "exec sleep infinity"]);
    created = true;
    const runtimeId = stdout.trim();
    const runtime = new DockerSandboxRuntime();
    const sandbox = {
      id: name, runtime_id: runtimeId, resources: { cpu: 1, memory_mb: 1024 }, source: { type: "image", image: "driftverk-dev:1" },
      development: { setup_command: "printf x >> installs", startup_command: "printf x >> starts; exec python3 -m http.server 8765 --bind 0.0.0.0", readiness_command: "curl -fsS http://127.0.0.1:8765/ >/dev/null", workspace_path: "/workspace" },
    };
    const steps = [];
    await runtime.create(sandbox, async step => steps.push(step));
    assert.deepEqual(steps, ["booting", "setting-up", "starting-services", "checking-app"]);
    await runtime.create(sandbox);
    assert.equal((await exec("docker", ["exec", runtimeId, "cat", "/workspace/installs"])).stdout, "x", "retry preserves completed install");
    assert.equal((await exec("docker", ["exec", runtimeId, "cat", "/workspace/starts"])).stdout, "x", "retry does not launch duplicate service");
    await runtime.stop(sandbox);
    await runtime.start(sandbox);
    assert.equal((await exec("docker", ["exec", runtimeId, "cat", "/workspace/starts"])).stdout, "xx", "resume restarts service");
    assert.equal((await exec("docker", ["exec", runtimeId, "cat", "/workspace/installs"])).stdout, "x", "resume preserves checkout and setup");
    const recoverable = { ...sandbox, id: `${name}-recoverable`, development: { workspace_path: "/workspace", startup_command: "test -f recovered", readiness_command: "test -f recovered" } };
    await assert.rejects(runtime.create(recoverable), /Could not start project services/);
    assert.equal((await exec("docker", ["inspect", "--format", "{{.State.Running}}", runtimeId])).stdout.trim(), "true", "startup failure retains the running container");
    await exec("docker", ["exec", runtimeId, "touch", "/workspace/recovered"]);
    await runtime.create(recoverable);

  } finally {
    if (created) await exec("docker", ["rm", "-f", name]);
  }
});
