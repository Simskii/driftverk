import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const snapshotLabel = "driftverk.snapshot-id";
const snapshotReference = /^driftverk\/snapshot-([a-z0-9_.-]+):latest$/i;

export function parseImageCleanupConfig(environment = process.env) {
  const intervalMs = Number(environment.IMAGE_CLEANUP_INTERVAL_MS ?? 15 * 60 * 1000);
  const minAgeHours = Number(environment.IMAGE_CLEANUP_MIN_AGE_HOURS ?? 168);
  const tempRetentionHours = Number(environment.SNAPSHOT_TEMP_RETENTION_HOURS ?? 1);
  const maxImages = Number(environment.IMAGE_CLEANUP_MAX_IMAGES ?? 50);
  if (!Number.isInteger(intervalMs) || intervalMs < 60_000)
    throw new Error("IMAGE_CLEANUP_INTERVAL_MS must be at least 60000");
  if (!Number.isFinite(minAgeHours) || minAgeHours < 1)
    throw new Error("IMAGE_CLEANUP_MIN_AGE_HOURS must be at least 1");
  if (!Number.isFinite(tempRetentionHours) || tempRetentionHours < 1 / 60)
    throw new Error("SNAPSHOT_TEMP_RETENTION_HOURS must be at least 0.016");
  if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > 500)
    throw new Error("IMAGE_CLEANUP_MAX_IMAGES must be between 1 and 500");
  return {
    intervalMs,
    minAgeHours,
    tempRetentionHours,
    maxImages,
  };
}

function imageIsOld(image, cutoff) {
  const createdAt = Date.parse(image.created ?? "");
  return Number.isFinite(createdAt) && createdAt <= cutoff;
}

function normalizeSnapshotId(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
}

function snapshotIdFromImage(image) {
  const labeled = image.labels?.[snapshotLabel]?.trim();
  if (labeled) return labeled;
  for (const tag of image.repoTags ?? []) {
    const match = snapshotReference.exec(tag);
    if (match) return match[1];
  }
  return null;
}

function isManagedSnapshot(image) {
  return (image.labels?.["driftverk.managed"] === "true" && image.labels?.["driftverk.resource"] === "snapshot")
    || (image.repoTags ?? []).some((tag) => snapshotReference.test(tag));
}

function hasOnlySnapshotTags(image) {
  return (image.repoTags ?? []).every((tag) => snapshotReference.test(tag));
}

function imageIsProtected(image, protectedSnapshotIds) {
  const snapshotId = snapshotIdFromImage(image);
  return Boolean(snapshotId && protectedSnapshotIds.has(normalizeSnapshotId(snapshotId)));
}

export function planManagedSnapshotRemoval(images, {
  protectedSnapshotIds = new Set(),
  now = Date.now(),
  minAgeHours = 168,
  maxImages = 50,
} = {}) {
  const cutoff = now - minAgeHours * 60 * 60 * 1000;
  const protectedIds = new Set([...protectedSnapshotIds].map(normalizeSnapshotId));
  return images
    .filter((image) => image?.id && isManagedSnapshot(image))
    .filter((image) => hasOnlySnapshotTags(image))
    .filter((image) => !imageIsProtected(image, protectedIds))
    .filter((image) => imageIsOld(image, cutoff))
    .slice(0, maxImages);
}

async function dockerJson(runner, args) {
  const result = await runner("docker", args);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Docker returned invalid JSON for ${args.join(" ")}`);
  }
}

async function listManagedSnapshots(runner) {
  const [result, tagged] = await Promise.all([
    runner("docker", [
      "image", "ls", "--no-trunc",
      "--filter", "label=driftverk.managed=true",
      "--filter", "label=driftverk.resource=snapshot",
      "--format", "{{.ID}}",
    ]),
    // Include snapshots created before image labels were added. The repository
    // prefix is agent-owned, so this remains narrower than a general image scan.
    runner("docker", ["image", "ls", "--no-trunc", "--format", "{{.ID}}\t{{.Repository}}:{{.Tag}}"]),
  ]);
  const ids = [...new Set(result.stdout.split("\n").map((value) => value.trim()).filter(Boolean))];
  for (const row of tagged.stdout.split("\n")) {
    const [id, reference] = row.trim().split(/\s+/, 2);
    if (id && reference && snapshotReference.test(reference)) ids.push(id);
  }
  const images = [];
  for (const id of new Set(ids)) {
    const image = await dockerJson(runner, ["image", "inspect", id]);
    if (Array.isArray(image) && image[0]) images.push({
      id: image[0].Id,
      created: image[0].Created,
      labels: image[0].Config?.Labels ?? {},
      repoTags: image[0].RepoTags ?? [],
    });
  }
  return images;
}

async function imageHasContainer(runner, imageId) {
  const result = await runner("docker", ["ps", "-a", "-q", "--filter", `ancestor=${imageId}`]);
  return result.stdout.split("\n").some((value) => value.trim());
}

export async function removeUnprotectedManagedSnapshots(runner, {
  protectedSnapshotIds = new Set(),
  now = Date.now(),
  minAgeHours = 168,
  maxImages = 50,
} = {}) {
  const planned = planManagedSnapshotRemoval(await listManagedSnapshots(runner), {
    protectedSnapshotIds,
    now,
    minAgeHours,
    maxImages,
  });
  const removed = [];
  const skippedInUse = [];
  const errors = [];
  for (const image of planned) {
    if (await imageHasContainer(runner, image.id)) {
      skippedInUse.push(image.id);
      continue;
    }
    try {
      await runner("docker", ["image", "rm", image.id]);
      removed.push(image.id);
    } catch (error) {
      errors.push({ id: image.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { planned: planned.length, removed, skippedInUse, errors };
}

export async function pruneDockerImages(runner, { storageDriver = "local", minAgeHours = 168 } = {}) {
  const args = ["image", "prune", "--force", "--filter", `until=${minAgeHours}h`];
  // A durable S3 snapshot can be downloaded again. Local snapshots cannot.
  if (storageDriver === "s3") args.splice(2, 0, "--all");
  const result = await runner("docker", args);
  return { args, output: result.stdout.trim() };
}

export async function removeExpiredSnapshotTemp(tempDirectory, {
  now = Date.now(),
  retentionHours = 1,
  activeDirectories = new Set(),
} = {}) {
  const cutoff = now - retentionHours * 60 * 60 * 1000;
  let entries;
  try {
    entries = await readdir(tempDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { removed: [], errors: [] };
    throw error;
  }
  const removed = [];
  const errors = [];
  for (const entry of entries) {
    if (!entry.name.startsWith("driftverk-snapshot-") && !entry.name.startsWith("driftverk-restore-")) continue;
    if (!entry.isDirectory()) continue;
    const path = join(tempDirectory, entry.name);
    if (activeDirectories.has(path)) continue;
    try {
      const details = await stat(path);
      if (details.mtimeMs <= cutoff) {
        await rm(path, { recursive: true, force: true });
        removed.push(entry.name);
      }
    } catch (error) {
      errors.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { removed, errors };
}

export async function runImageCleanup({
  runner,
  protectedSnapshotIds,
  storageDriver,
  tempDirectory,
  minAgeHours = 168,
  tempRetentionHours = 1,
  maxImages = 50,
  activeTempDirectories = new Set(),
  now = Date.now(),
}) {
  const temp = await removeExpiredSnapshotTemp(tempDirectory, {
    now,
    retentionHours: tempRetentionHours,
    activeDirectories: activeTempDirectories,
  });
  const managed = protectedSnapshotIds
    ? await removeUnprotectedManagedSnapshots(runner, { protectedSnapshotIds, now, minAgeHours, maxImages })
    : { planned: 0, removed: [], skippedInUse: [], errors: [] };
  const pruned = await pruneDockerImages(runner, { storageDriver, minAgeHours });
  return { temp, managed, pruned };
}
