import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

// The janitor runs in the same process as snapshot capture and restore. Keep
// active temporary directories out of its age-based cleanup pass.
export const activeSnapshotTempDirectories = new Set();

function safeSnapshotId(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
}

export function localSnapshotRef(snapshotId) {
  return `driftverk/snapshot-${safeSnapshotId(snapshotId)}:latest`;
}

export function snapshotStorageKey(environment = process.env) {
  const config = parseSnapshotStorageConfig(environment);
  if (config.driver !== "s3") return null;
  return createHash("sha256").update(JSON.stringify([config.endpoint || "aws", config.region, config.bucket, config.prefix])).digest("hex");
}

export function parseSnapshotStorageConfig(environment = process.env) {
  const driver = environment.SNAPSHOT_STORAGE_DRIVER?.trim().toLowerCase() || "local";
  if (driver === "local") return { driver };
  if (driver !== "s3")
    throw new Error("SNAPSHOT_STORAGE_DRIVER must be local or s3");

  const bucket = environment.SNAPSHOT_S3_BUCKET?.trim();
  const region = environment.SNAPSHOT_S3_REGION?.trim();
  if (!bucket || !region)
    throw new Error("SNAPSHOT_S3_BUCKET and SNAPSHOT_S3_REGION are required for S3 snapshot storage");

  const rawPrefix = environment.SNAPSHOT_S3_PREFIX?.trim().replace(/^\/+|\/+$/g, "") || "snapshots";
  return {
    driver,
    bucket,
    region,
    prefix: `${rawPrefix}/`,
    endpoint: environment.SNAPSHOT_S3_ENDPOINT?.trim() || undefined,
    forcePathStyle: environment.SNAPSHOT_S3_FORCE_PATH_STYLE === "true",
    tempDirectory: environment.SNAPSHOT_TEMP_DIR?.trim() || tmpdir(),
  };
}

export function createSnapshotStorage(environment = process.env, dependencies = {}) {
  const config = parseSnapshotStorageConfig(environment);
  if (config.driver === "local") return new LocalSnapshotStorage();
  const client = dependencies.client ?? new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
  });
  return new S3SnapshotStorage({
    ...config,
    client,
    createUpload: dependencies.createUpload,
  });
}

export class LocalSnapshotStorage {
  async publish({ imageRef, sizeBytes }) {
    return { artifactRef: imageRef, sizeBytes };
  }

  async restore({ artifactRef }) {
    return artifactRef;
  }
}

export class S3SnapshotStorage {
  constructor({ bucket, prefix, client, tempDirectory = tmpdir(), createUpload = (options) => new Upload(options) }) {
    this.bucket = bucket;
    this.prefix = prefix;
    this.client = client;
    this.tempDirectory = tempDirectory;
    this.createUpload = createUpload;
  }

  async publish({ snapshotId, imageRef, runner }) {
    const directory = await mkdtemp(join(this.tempDirectory, "driftverk-snapshot-"));
    activeSnapshotTempDirectories.add(directory);
    const tarPath = join(directory, "snapshot.oci.tar");
    const archivePath = `${tarPath}.gz`;
    const key = `${this.prefix}${safeSnapshotId(snapshotId)}.oci.tar.gz`;
    try {
      await runner("docker", ["image", "save", "--output", tarPath, imageRef]);
      await pipeline(createReadStream(tarPath), createGzip(), createWriteStream(archivePath));
      const checksum = await sha256File(archivePath);
      const upload = this.createUpload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: createReadStream(archivePath),
          ContentType: "application/vnd.oci.image.layer.v1.tar+gzip",
          Metadata: { sha256: checksum, "oci-image-ref": imageRef },
        },
        leavePartsOnError: false,
      });
      await upload.done();
      return {
        artifactRef: `s3://${this.bucket}/${key}#sha256=${checksum}`,
        sizeBytes: (await stat(archivePath)).size,
      };
    } finally {
      activeSnapshotTempDirectories.delete(directory);
      await rm(directory, { recursive: true, force: true });
    }
  }

  async restore({ snapshotId, artifactRef, runner }) {
    const { bucket, key, checksum: expectedChecksum } = this.parseArtifactRef(artifactRef);
    const imageRef = localSnapshotRef(snapshotId);
    if (await imageExists(runner, imageRef)) return imageRef;

    const directory = await mkdtemp(join(this.tempDirectory, "driftverk-restore-"));
    activeSnapshotTempDirectories.add(directory);
    const archivePath = join(directory, "snapshot.oci.tar.gz");
    try {
      const object = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!object.Body) throw new Error("S3 snapshot object has no body");
      if (object.Metadata?.sha256 !== expectedChecksum)
        throw new Error("S3 snapshot checksum metadata does not match its artifact reference");
      await pipeline(object.Body, createWriteStream(archivePath));
      const actualChecksum = await sha256File(archivePath);
      if (actualChecksum !== expectedChecksum)
        throw new Error("S3 snapshot checksum verification failed");
      await runner("docker", ["image", "load", "--input", archivePath]);
      if (!(await imageExists(runner, imageRef)))
        throw new Error("Restored snapshot archive did not contain the expected OCI image");
      return imageRef;
    } finally {
      activeSnapshotTempDirectories.delete(directory);
      await rm(directory, { recursive: true, force: true });
    }
  }

  parseArtifactRef(artifactRef) {
    let parsed;
    try {
      parsed = new URL(artifactRef);
    } catch {
      throw new Error("Snapshot artifact is not a valid S3 reference");
    }
    const key = parsed.pathname.replace(/^\//, "");
    const checksum = new URLSearchParams(parsed.hash.replace(/^#/, "")).get("sha256");
    if (parsed.protocol !== "s3:" || parsed.hostname !== this.bucket || !key.startsWith(this.prefix))
      throw new Error("Snapshot artifact is outside the configured S3 bucket or prefix");
    if (!checksum || !/^[a-f0-9]{64}$/.test(checksum))
      throw new Error("Snapshot artifact has no valid SHA-256 checksum");
    return { bucket: parsed.hostname, key, checksum };
  }
}

async function imageExists(runner, imageRef) {
  try {
    await runner("docker", ["image", "inspect", imageRef]);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
