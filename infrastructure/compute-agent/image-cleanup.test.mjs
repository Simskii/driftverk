import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseImageCleanupConfig,
  planManagedSnapshotRemoval,
  pruneDockerImages,
  removeUnprotectedManagedSnapshots,
  removeExpiredSnapshotTemp,
} from "./image-cleanup.mjs";

test("cleanup config has conservative defaults and rejects aggressive intervals", () => {
  const config = parseImageCleanupConfig({});
  assert.equal(config.intervalMs, 900_000);
  assert.equal(config.minAgeHours, 168);
  assert.throws(() => parseImageCleanupConfig({ IMAGE_CLEANUP_INTERVAL_MS: "1000" }), /at least 60000/);
});

test("managed snapshot plan keeps protected, recent, and unrelated images", () => {
  const now = Date.parse("2026-01-10T00:00:00.000Z");
  const old = "2025-12-01T00:00:00.000Z";
  const images = [
    { id: "remove", created: old, labels: { "driftverk.managed": "true", "driftverk.resource": "snapshot", "driftverk.snapshot-id": "old" } },
    { id: "keep-protected", created: old, labels: { "driftverk.managed": "true", "driftverk.resource": "snapshot", "driftverk.snapshot-id": "keep" } },
    { id: "keep-recent", created: "2026-01-09T00:00:00.000Z", labels: { "driftverk.managed": "true", "driftverk.resource": "snapshot", "driftverk.snapshot-id": "recent" } },
    { id: "keep-other", created: old, labels: { "driftverk.managed": "true", "driftverk.resource": "other" } },
    { id: "keep-unmanaged", created: old, labels: {} },
    { id: "remove-legacy", created: old, labels: {}, repoTags: ["driftverk/snapshot-legacy:latest"] },
  ];
  assert.deepEqual(planManagedSnapshotRemoval(images, { now, protectedSnapshotIds: new Set(["keep"]) }).map((image) => image.id), ["remove", "remove-legacy"]);
});

test("S3 cleanup prunes all old unused images while local cleanup only prunes dangling layers", async () => {
  const calls = [];
  const runner = async (command, args) => { calls.push([command, args]); return { stdout: "reclaimed", stderr: "" }; };
  await pruneDockerImages(runner, { storageDriver: "local", minAgeHours: 168 });
  assert.deepEqual(calls[0][1], ["image", "prune", "--force", "--filter", "until=168h"]);
  calls.length = 0;
  await pruneDockerImages(runner, { storageDriver: "s3", minAgeHours: 168 });
  assert.deepEqual(calls[0][1], ["image", "prune", "--all", "--force", "--filter", "until=168h"]);
});

test("removes old unprotected snapshot images and leaves container-referenced images alone", async () => {
  const calls = [];
  const images = {
    old: { Id: "sha256:old", Created: "2025-12-01T00:00:00.000Z", Config: { Labels: { "driftverk.managed": "true", "driftverk.resource": "snapshot", "driftverk.snapshot-id": "snap_old" } }, RepoTags: ["driftverk/snapshot-snap_old:latest"] },
    protected: { Id: "sha256:protected", Created: "2025-12-01T00:00:00.000Z", Config: { Labels: {}, }, RepoTags: ["driftverk/snapshot-snap_keep:latest"] },
    inUse: { Id: "sha256:in-use", Created: "2025-12-01T00:00:00.000Z", Config: { Labels: { "driftverk.managed": "true", "driftverk.resource": "snapshot", "driftverk.snapshot-id": "snap_in-use" } }, RepoTags: ["driftverk/snapshot-snap_in-use:latest"] },
  };
  const runner = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === "image" && args[1] === "ls" && args.includes("label=driftverk.managed=true")) return { stdout: "sha256:old\nsha256:in-use\n", stderr: "" };
    if (args[0] === "image" && args[1] === "ls") return { stdout: "sha256:old\tdriftverk/snapshot-snap_old:latest\nsha256:protected\tdriftverk/snapshot-snap_keep:latest\nsha256:in-use\tdriftverk/snapshot-snap_in-use:latest\n", stderr: "" };
    if (args[0] === "image" && args[1] === "inspect") return { stdout: JSON.stringify([images[args[2].includes("old") ? "old" : args[2].includes("protected") ? "protected" : "inUse"]]), stderr: "" };
    if (args[0] === "ps") return { stdout: args.join(" ").includes("in-use") ? "container-1\n" : "", stderr: "" };
    if (args[0] === "image" && args[1] === "rm") return { stdout: "removed\n", stderr: "" };
    throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
  };
  const result = await removeUnprotectedManagedSnapshots(runner, {
    protectedSnapshotIds: new Set(["snap_keep"]),
    now: Date.parse("2026-01-10T00:00:00.000Z"),
  });
  assert.deepEqual(result.removed, ["sha256:old"]);
  assert.deepEqual(result.skippedInUse, ["sha256:in-use"]);
  assert.equal(result.planned, 2);
  assert.ok(calls.some(([, args]) => args[0] === "image" && args[1] === "rm" && args[2] === "sha256:old"));
});

test("temp cleanup removes only old Driftverk snapshot directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftverk-cleanup-test-"));
  const oldDir = join(root, "driftverk-snapshot-old");
  const recentDir = join(root, "driftverk-restore-recent");
  const activeDir = join(root, "driftverk-snapshot-active");
  const unrelated = join(root, "keep-me");
  await Promise.all([mkdir(oldDir), mkdir(recentDir), mkdir(activeDir), mkdir(unrelated)]);
  const oldTime = new Date("2025-12-01T00:00:00.000Z");
  await Promise.all([utimes(oldDir, oldTime, oldTime), utimes(activeDir, oldTime, oldTime)]);
  const result = await removeExpiredSnapshotTemp(root, {
    now: Date.parse("2026-01-10T00:00:00.000Z"),
    retentionHours: 1,
    activeDirectories: new Set([activeDir]),
  });
  assert.deepEqual(result.removed, ["driftverk-snapshot-old"]);
  await assert.rejects(stat(oldDir));
  await stat(recentDir);
  await stat(activeDir);
  await stat(unrelated);
  await rm(root, { recursive: true, force: true });
});
