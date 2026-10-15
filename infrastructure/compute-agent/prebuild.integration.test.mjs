import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import { DockerSandboxRuntime } from "./docker-runtime.mjs";
import { localSnapshotRef } from "./snapshot-storage.mjs";

const exec = promisify(execFile);

// Real local Docker round trip. No network, registry, production credentials, or API server.
test("clean prebuild restores reusable setup with isolated once-per-environment initialization", { skip: process.env.DRIFTVERK_RUNTIME_QA !== "1", timeout: 90000 }, async () => {
  const prefix = `prebuild-qa-${process.pid}-${randomUUID().slice(0, 8)}`;
  const snapshot = { id: `${prefix}-snapshot` };
  const imageRef = localSnapshotRef(snapshot.id);
  const runtime = new DockerSandboxRuntime({ network: "none" });
  const owned = [];
  const capturedImages = [];
  const base = { environment: {}, volumes: [], resources: { cpu: 0.5, memory_mb: 256 }, snapshot_allowed: true };
  const builder = {
    ...base, id: `${prefix}-builder`, purpose: "prebuild",
    source: { type: "image", image: "driftverk-dev:1" },
    development: { workspace_path: "/workspace", setup_command: "test -z \"${QA_RUNTIME_SECRET:-}\"; printf installed >> setup-count; env > build-environment" },
  };
  const read = async (sandbox, path) => (await exec("docker", ["exec", sandbox.runtime_id, "cat", path])).stdout;
  try {
    owned.push(builder.id);
    builder.runtime_id = await runtime.create(builder);
    assert.equal(await read(builder, "/workspace/setup-count"), "installed");
    assert.equal((await read(builder, "/workspace/build-environment")).includes("QA_RUNTIME_SECRET="), false);
    await exec("docker", ["exec", builder.runtime_id, "test", "!", "-e", "/workspace/runtime-data"]);
    const built = await runtime.snapshot(builder, snapshot);
    assert.equal(built.artifactRef, imageRef);
    const imageConfiguration = JSON.parse((await exec("docker", ["image", "inspect", "--format", "{{json .Config.Env}}", imageRef])).stdout);
    assert.equal(imageConfiguration.some(value => value.startsWith("QA_RUNTIME_SECRET=")), false);
    const originalCommand = (await exec("docker", ["image", "inspect", "--format", "{{json .Config.Entrypoint}} {{json .Config.Cmd}}", "driftverk-dev:1"])).stdout;
    assert.equal((await exec("docker", ["image", "inspect", "--format", "{{json .Config.Entrypoint}} {{json .Config.Cmd}}", imageRef])).stdout, originalCommand, "prebuild must preserve the original image command");
    await runtime.delete(builder);

    const consumers = [];
    for (const suffix of ["one", "two"]) {
      const sandbox = {
        ...base, id: `${prefix}-${suffix}`, purpose: "development",
        environment: { QA_RUNTIME_SECRET: `local-fixture-${suffix}` },
        source: { type: "snapshot", image: built.artifactRef, snapshot_id: snapshot.id },
        development: {
          prebuilt: true, workspace_path: "/workspace",
          setup_command: "echo setup-must-not-run >&2; exit 91",
          initialization_command: "printf '%s' \"$QA_RUNTIME_SECRET\" > runtime-data; printf x >> initialization-count",
        },
      };
      owned.push(sandbox.id);
      const progress = [];
      sandbox.runtime_id = await runtime.create(sandbox, async step => progress.push(step));
      assert.equal(progress.includes("setting-up"), false);
      assert.equal(progress.includes("initializing"), true);
      assert.equal(await read(sandbox, "/workspace/setup-count"), "installed");
      assert.equal(await read(sandbox, "/workspace/runtime-data"), `local-fixture-${suffix}`);
      assert.equal(await read(sandbox, "/workspace/initialization-count"), "x");
      await runtime.create(sandbox);
      assert.equal(await read(sandbox, "/workspace/initialization-count"), "x", "retry must preserve initialization marker");
      await runtime.stop(sandbox);
      await runtime.start(sandbox);
      assert.equal(await read(sandbox, "/workspace/initialization-count"), "x", "resume must not initialize a second time");
      const captured = await runtime.snapshot(sandbox, { id: `${prefix}-captured-${suffix}` });
      capturedImages.push(captured.artifactRef);
      const imageEnvironment = JSON.parse((await exec("docker", ["image", "inspect", "--format", "{{json .Config.Env}}", captured.artifactRef])).stdout);
      assert.ok(imageEnvironment.includes(`QA_RUNTIME_SECRET=local-fixture-${suffix}`), "snapshot should retain the configured environment variable");
      consumers.push(sandbox);
    }
    await exec("docker", ["exec", consumers[0].runtime_id, "sh", "-c", "printf changed > /workspace/runtime-data"]);
    assert.equal(await read(consumers[1], "/workspace/runtime-data"), "local-fixture-two", "restored filesystems must be isolated");
  } finally {
    for (const id of owned) await exec("docker", ["rm", "-f", `driftverk-${id}`]).catch(() => {});
    for (const image of capturedImages) await exec("docker", ["image", "rm", image]).catch(() => {});
    await exec("docker", ["image", "rm", imageRef]).catch(() => {});
  }
});

test("an image-service prebuild restores the original entrypoint and runs its app", { skip: process.env.DRIFTVERK_RUNTIME_QA !== "1", timeout: 90000 }, async () => {
  const prefix = `prebuild-service-qa-${process.pid}-${randomUUID().slice(0, 8)}`;
  const sourceImage = `${prefix}:latest`;
  const snapshot = { id: `${prefix}-snapshot` };
  const imageRef = localSnapshotRef(snapshot.id);
  const owned = [`${prefix}-seed`, `driftverk-${prefix}-builder`, `driftverk-${prefix}-consumer`, `driftverk-${prefix}-init`];
  const runtime = new DockerSandboxRuntime({ network: "none" });
  const base = { environment: {}, volumes: [], resources: { cpu: 0.5, memory_mb: 256 }, snapshot_allowed: true };
  try {
    // Create a purely local fixture image without any registry pull or filesystem changes.
    await exec("docker", ["create", "--name", owned[0], "driftverk-dev:1"]);
    await exec("docker", ["commit", "--change", 'ENTRYPOINT ["python3","-m","http.server"]', "--change", 'CMD ["8765","--bind","127.0.0.1"]', "--change", "EXPOSE 8765", owned[0], sourceImage]);
    const builder = { ...base, id: `${prefix}-builder`, purpose: "prebuild", source: { type: "image", image: sourceImage } };
    // Suppress image services just as runtime.create does for prebuilds. Supplying a fresh
    // local container avoids runtime.create's deliberate registry pull for custom images.
    builder.runtime_id = (await exec("docker", ["create", "--name", owned[1], "--network", "none", "--init", "--entrypoint", "/bin/sh", sourceImage, "-lc", "exec sleep infinity"])).stdout.trim();
    await runtime.create(builder);
    await exec("docker", ["exec", builder.runtime_id, "sh", "-c", "! curl -fsS http://127.0.0.1:8765/ >/dev/null 2>&1"]);
    await runtime.snapshot(builder, snapshot);
    const metadata = JSON.parse((await exec("docker", ["image", "inspect", "--format", "{{json .Config}}", imageRef])).stdout);
    assert.deepEqual(metadata.Entrypoint, ["python3", "-m", "http.server"]);
    assert.deepEqual(metadata.Cmd, ["8765", "--bind", "127.0.0.1"]);
    await runtime.delete(builder);

    const consumer = { ...base, id: `${prefix}-consumer`, purpose: "development", source: { type: "snapshot", image: imageRef, snapshot_id: snapshot.id }, development: { prebuilt: true } };
    consumer.runtime_id = await runtime.create(consumer);
    await exec("docker", ["exec", consumer.runtime_id, "sh", "-c", "for i in 1 2 3 4 5; do curl -fsS http://127.0.0.1:8765/ >/dev/null && exit 0; sleep 0.1; done; exit 1"]);
    assert.equal((await exec("docker", ["inspect", "--format", '{{index .Config.Labels "driftverk.start-mode"}}', consumer.runtime_id])).stdout.trim(), "image");

    const initializer = { ...consumer, id: `${prefix}-init`, runtime_id: undefined, development: { prebuilt: true, workspace_path: "/workspace", initialization_command: "printf initialized > init-marker" } };
    initializer.runtime_id = await runtime.create(initializer);
    assert.equal((await exec("docker", ["exec", initializer.runtime_id, "cat", "/workspace/init-marker"])).stdout, "initialized");
    assert.equal((await exec("docker", ["inspect", "--format", '{{index .Config.Labels "driftverk.start-mode"}}', initializer.runtime_id])).stdout.trim(), "idle");
    await exec("docker", ["exec", initializer.runtime_id, "sh", "-c", "! curl -fsS http://127.0.0.1:8765/ >/dev/null 2>&1"]);
  } finally {
    for (const name of owned) await exec("docker", ["rm", "-f", name]).catch(() => {});
    for (const image of [imageRef, sourceImage]) await exec("docker", ["image", "rm", image]).catch(() => {});
  }
});
