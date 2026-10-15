import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const inheritedStorageEnvironmentNames = [
  "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
];

export function storageCommandEnvironment(source, extra = {}) {
  const environment = {};
  for (const name of inheritedStorageEnvironmentNames) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  return { ...environment, ...extra };
}

function cleanSegment(value, label) {
  const segment = String(value ?? "");
  if (!segment || segment.includes("/") || segment === "." || segment === "..")
    throw new Error(`Invalid ${label}`);
  return segment;
}

function cleanPrefix(value) {
  const parts = String(value ?? "").split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === ".."))
    throw new Error("Invalid volume storage prefix");
  return parts.join("/");
}

export class VolumeStorage {
  constructor(environment = process.env, { runner, spawner = spawn } = {}) {
    this.driver = environment.VOLUME_STORAGE_DRIVER || environment.SNAPSHOT_STORAGE_DRIVER || "local";
    this.bucket = environment.VOLUME_S3_BUCKET || environment.SNAPSHOT_S3_BUCKET || "";
    this.region = environment.VOLUME_S3_REGION || environment.SNAPSHOT_S3_REGION || "eu-north-1";
    this.endpoint = environment.VOLUME_S3_ENDPOINT || environment.SNAPSHOT_S3_ENDPOINT || "";
    this.forcePathStyle = (environment.VOLUME_S3_FORCE_PATH_STYLE || environment.SNAPSHOT_S3_FORCE_PATH_STYLE || "false") === "true";
    this.basePrefix = (environment.VOLUME_S3_PREFIX || "driftverk/volumes").replace(/^\/+|\/+$/g, "");
    this.mountRoot = environment.VOLUME_MOUNT_ROOT || "/var/lib/driftverk/volumes";
    this.cacheRoot = environment.VOLUME_CACHE_ROOT || "/var/lib/driftverk/volume-cache";
    this.environment = environment;
    this.runner = runner;
    this.spawner = spawner;
    this.mounts = new Map();
    this.pendingMounts = new Map();
  }

  async sizes(volumes = []) {
    if (this.driver !== "local" || !this.runner) return [];
    const samples = [];
    for (const id of [...new Set(volumes.map(volume => cleanSegment(volume.id, "volume ID")))]) {
      const result = await this.runner("du", ["-sk", "--", join(this.mountRoot, id)]).catch(() => null);
      const kilobytes = Number(result?.stdout?.split(/\s/)[0]);
      if (result && Number.isFinite(kilobytes) && kilobytes >= 0) samples.push({ id, size_gb: kilobytes / 1024 / 1024 });
    }
    return samples;
  }

  async prepare(volumes = []) {
    const prepared = [];
    for (const volume of volumes) {
      const id = cleanSegment(volume.id, "volume ID");
      const subpath = String(volume.subpath ?? "").split("/").filter(Boolean);
      if (subpath.some((part) => part === "." || part === "..")) throw new Error("Invalid volume subpath");
      let sourcePath;
      if (this.driver === "s3") {
        const mountName = subpath.length ? createHash("sha256").update(subpath.join("/")).digest("hex").slice(0, 16) : "root";
        sourcePath = join(this.mountRoot, id, mountName);
        await mkdir(sourcePath, { recursive: true });
        await this.ensureS3Mount(`${id}:${mountName}`, [cleanPrefix(volume.storage_prefix), ...subpath].join("/"), sourcePath, join(this.cacheRoot, id, mountName));
      } else if (this.driver === "local") {
        sourcePath = join(this.mountRoot, id, ...subpath);
      } else throw new Error(`Unsupported volume storage driver: ${this.driver}`);
      await mkdir(sourcePath, { recursive: true });
      prepared.push({ ...volume, source_path: sourcePath });
    }
    return prepared;
  }

  async ensureS3Mount(key, storagePrefix, mountRoot, cacheRoot) {
    const pending = this.pendingMounts.get(key);
    if (pending) return pending;
    const mounting = this.mountS3(key, storagePrefix, mountRoot, cacheRoot);
    this.pendingMounts.set(key, mounting);
    try { await mounting; } finally { this.pendingMounts.delete(key); }
  }

  async mountS3(key, storagePrefix, mountRoot, cacheRoot) {
    if (!this.bucket) throw new Error("VOLUME_S3_BUCKET or SNAPSHOT_S3_BUCKET is required for S3 volumes");
    if (this.mounts.has(key)) return;
    if (this.runner) {
      const mounted = await this.runner("mountpoint", ["-q", mountRoot]).then(() => true).catch(() => false);
      if (mounted) {
        this.mounts.set(key, null);
        return;
      }
    }
    await mkdir(cacheRoot, { recursive: true });
    const remotePath = [this.bucket, this.basePrefix, storagePrefix].filter(Boolean).join("/");
    const child = this.spawner("rclone", [
      "mount",
      `driftverk:${remotePath}`,
      mountRoot,
      "--allow-other",
      "--vfs-cache-mode=writes",
      `--cache-dir=${cacheRoot}`,
      "--dir-cache-time=30s",
      "--poll-interval=30s",
      "--log-level=NOTICE",
    ], {
      env: storageCommandEnvironment(this.environment, {
        RCLONE_CONFIG_DRIFTVERK_TYPE: "s3",
        RCLONE_CONFIG_DRIFTVERK_PROVIDER: this.endpoint ? "Other" : "AWS",
        RCLONE_CONFIG_DRIFTVERK_ENV_AUTH: "true",
        RCLONE_CONFIG_DRIFTVERK_REGION: this.region,
        RCLONE_CONFIG_DRIFTVERK_ENDPOINT: this.endpoint,
        RCLONE_CONFIG_DRIFTVERK_FORCE_PATH_STYLE: String(this.forcePathStyle),
      }),
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.mounts.set(key, child);
    child.stderr?.on("data", (chunk) => console.error(JSON.stringify({ event: "volume_mount_log", volume_mount: key, message: String(chunk).trim() })));
    child.once("exit", (code) => {
      this.mounts.delete(key);
      if (code) console.error(JSON.stringify({ event: "volume_mount_stopped", volume_mount: key, code }));
    });
    child.once("error", () => this.mounts.delete(key));

    if (!this.runner) return;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const mounted = await this.runner("mountpoint", ["-q", mountRoot]).then(() => true).catch(() => false);
      if (mounted) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    child.kill("SIGTERM");
    throw new Error(`Volume mount ${key} did not become ready within 5 seconds`);
  }
}
