import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import test from "node:test";
import {
  activeSnapshotTempDirectories,
  S3SnapshotStorage,
  localSnapshotRef,
  parseSnapshotStorageConfig,
  snapshotStorageKey,
} from "./snapshot-storage.mjs";

test("uses local snapshot storage by default", () => {
  assert.deepEqual(parseSnapshotStorageConfig({}), { driver: "local" });
});

test("snapshot compatibility tracks storage location but excludes credentials", () => {
  const env = { SNAPSHOT_STORAGE_DRIVER: "s3", SNAPSHOT_S3_BUCKET: "bucket", SNAPSHOT_S3_REGION: "eu-north-1" };
  assert.equal(snapshotStorageKey({}), null);
  assert.equal(snapshotStorageKey(env), snapshotStorageKey({ ...env, AWS_SECRET_ACCESS_KEY: "different-local-test-key" }));
  assert.notEqual(snapshotStorageKey(env), snapshotStorageKey({ ...env, SNAPSHOT_S3_BUCKET: "other" }));
  assert.notEqual(snapshotStorageKey(env), snapshotStorageKey({ ...env, SNAPSHOT_S3_ENDPOINT: "https://other.example" }));
  assert.notEqual(snapshotStorageKey(env), snapshotStorageKey({ ...env, SNAPSHOT_S3_PREFIX: "other" }));
});

test("requires a bucket and region for S3 snapshot storage", () => {
  assert.throws(
    () => parseSnapshotStorageConfig({ SNAPSHOT_STORAGE_DRIVER: "s3" }),
    /SNAPSHOT_S3_BUCKET and SNAPSHOT_S3_REGION/,
  );
});

test("normalizes S3-compatible storage configuration", () => {
  assert.deepEqual(parseSnapshotStorageConfig({
    SNAPSHOT_STORAGE_DRIVER: "S3",
    SNAPSHOT_S3_BUCKET: "customer-snapshots",
    SNAPSHOT_S3_REGION: "eu-north-1",
    SNAPSHOT_S3_PREFIX: "/driftverk/production/",
    SNAPSHOT_S3_ENDPOINT: "https://objects.example.com",
    SNAPSHOT_S3_FORCE_PATH_STYLE: "true",
    SNAPSHOT_TEMP_DIR: "/tmp",
  }), {
    driver: "s3",
    bucket: "customer-snapshots",
    region: "eu-north-1",
    prefix: "driftverk/production/",
    endpoint: "https://objects.example.com",
    forcePathStyle: true,
    tempDirectory: "/tmp",
  });
});

test("publishes a compressed OCI archive with checksum metadata", async () => {
  let uploaded;
  const storage = new S3SnapshotStorage({
    bucket: "customer-snapshots",
    prefix: "driftverk/",
    client: {},
    createUpload: (options) => ({
      async done() {
        const chunks = [];
        for await (const chunk of options.params.Body) chunks.push(chunk);
        uploaded = { options, body: Buffer.concat(chunks) };
      },
    }),
  });
  const result = await storage.publish({
    snapshotId: "snap_1",
    imageRef: localSnapshotRef("snap_1"),
    runner: async (_command, args) => {
      await writeFile(args[3], "oci archive");
      return { stdout: "", stderr: "" };
    },
  });

  assert.equal(uploaded.options.params.Metadata.sha256, createHash("sha256").update(uploaded.body).digest("hex"));
  assert.equal(result.artifactRef, `s3://customer-snapshots/driftverk/snap_1.oci.tar.gz#sha256=${uploaded.options.params.Metadata.sha256}`);
  assert.equal(uploaded.options.params.Metadata["oci-image-ref"], localSnapshotRef("snap_1"));
  assert.ok(result.sizeBytes > 0);
  assert.equal(activeSnapshotTempDirectories.size, 0);
});

test("restores a checksummed S3 archive and rejects references outside the configured prefix", async () => {
  const archive = gzipSync("oci archive");
  const checksum = createHash("sha256").update(archive).digest("hex");
  let loaded = false;
  const storage = new S3SnapshotStorage({
    bucket: "customer-snapshots",
    prefix: "driftverk/",
    client: {
      async send(command) {
        assert.equal(command.input.Bucket, "customer-snapshots");
        assert.equal(command.input.Key, "driftverk/snap_1.oci.tar.gz");
        return { Body: Readable.from(archive), Metadata: { sha256: checksum } };
      },
    },
  });
  const runner = async (_command, args) => {
    if (args[0] === "image" && args[1] === "inspect") {
      if (!loaded) throw new Error("not found");
      return { stdout: localSnapshotRef("snap_1"), stderr: "" };
    }
    if (args[0] === "image" && args[1] === "load") loaded = true;
    return { stdout: "", stderr: "" };
  };

  assert.equal(
    await storage.restore({
      snapshotId: "snap_1",
      artifactRef: `s3://customer-snapshots/driftverk/snap_1.oci.tar.gz#sha256=${checksum}`,
      runner,
    }),
    localSnapshotRef("snap_1"),
  );
  assert.equal(activeSnapshotTempDirectories.size, 0);
  await assert.rejects(
    storage.restore({
      snapshotId: "snap_2",
      artifactRef: `s3://another-bucket/driftverk/snap_2.oci.tar.gz#sha256=${checksum}`,
      runner,
    }),
    /outside the configured S3 bucket or prefix/,
  );
});
