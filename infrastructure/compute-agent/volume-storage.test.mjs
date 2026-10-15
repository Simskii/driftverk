import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { storageCommandEnvironment, VolumeStorage } from "./volume-storage.mjs";

test("does not pass control-plane credentials to storage subprocesses", () => {
  const environment = storageCommandEnvironment({
    PATH: "/usr/bin",
    AWS_ACCESS_KEY_ID: "storage-identity",
    COMPUTE_AGENT_TOKEN: "control-plane-secret",
  });
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.AWS_ACCESS_KEY_ID, "storage-identity");
  assert.equal(environment.COMPUTE_AGENT_TOKEN, undefined);
});

test("prepares a local volume and optional subpath", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftverk-volumes-"));
  try {
    const storage = new VolumeStorage({ VOLUME_STORAGE_DRIVER: "local", VOLUME_MOUNT_ROOT: root });
    const result = await storage.prepare([{ id: "vol_test", storage_prefix: "org_test/vol_test", mount_path: "/data", subpath: "fixtures/demo", read_only: true }]);
    assert.equal(result[0].source_path, join(root, "vol_test", "fixtures", "demo"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsafe storage identifiers", async () => {
  const storage = new VolumeStorage({ VOLUME_STORAGE_DRIVER: "local", VOLUME_MOUNT_ROOT: "/tmp/driftverk-volume-test" });
  await assert.rejects(() => storage.prepare([{ id: "../escape", storage_prefix: "org/volume" }]), /Invalid volume ID/);
});

test("mounts an S3 subpath at a dedicated propagation point", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftverk-s3-volumes-"));
  const spawns = [];
  let mountChecks = 0;
  try {
    const storage = new VolumeStorage({
      VOLUME_STORAGE_DRIVER: "s3",
      VOLUME_S3_BUCKET: "customer-bucket",
      VOLUME_S3_PREFIX: "driftverk/volumes",
      VOLUME_MOUNT_ROOT: root,
      VOLUME_CACHE_ROOT: join(root, "cache"),
    }, {
      runner: async () => {
        mountChecks += 1;
        if (mountChecks === 1) throw new Error("not mounted");
        return { stdout: "", stderr: "" };
      },
      spawner: (command, args, options) => {
        spawns.push({ command, args, options });
        return { stderr: { on() {} }, once() {}, kill() {} };
      },
    });
    const [result] = await storage.prepare([{ id: "vol_test", storage_prefix: "org_test/vol_test", subpath: "datasets/demo" }]);
    assert.equal(spawns[0].command, "rclone");
    assert.ok(spawns[0].args.includes("driftverk:customer-bucket/driftverk/volumes/org_test/vol_test/datasets/demo"));
    assert.match(result.source_path, /vol_test\/[0-9a-f]{16}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent resume and reconciliation share one pending mount", async () => {
  const storage = new VolumeStorage({ VOLUME_STORAGE_DRIVER: "s3" });
  let mounts = 0;
  let finish;
  storage.mountS3 = async () => { mounts++; await new Promise(resolve => { finish = resolve; }); };
  const first = storage.ensureS3Mount("same-volume", "prefix", "/mount", "/cache");
  const second = storage.ensureS3Mount("same-volume", "prefix", "/mount", "/cache");
  assert.equal(mounts, 1);
  finish();
  await Promise.all([first, second]);
  assert.equal(storage.pendingMounts.size, 0);
});


test("meters each local volume once, including detached roots, without treating failed reads as empty", async () => {
  const calls=[];
  const storage=new VolumeStorage({ VOLUME_STORAGE_DRIVER:"local",VOLUME_MOUNT_ROOT:"/volumes" }, {runner:async (command,args)=>{
    calls.push({command,args});
    if(args.at(-1).endsWith("vol_failed")) throw new Error("unavailable");
    return {stdout:"1048576\t/volumes/vol_local\n"};
  }});
  assert.deepEqual(await storage.sizes([{id:"vol_local"},{id:"vol_local",subpath:"data"},{id:"vol_failed"}]),[{id:"vol_local",size_gb:1}]);
  assert.equal(calls.length,2);
  await assert.rejects(storage.sizes([{id:"../escape"}]),/Invalid/);
});
