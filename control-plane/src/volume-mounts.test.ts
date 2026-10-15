import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseVolumeMounts } from "./volume-mounts.js";

describe("parseVolumeMounts", () => {
  it("normalizes a valid mount", () => {
    assert.deepEqual(parseVolumeMounts([{ volume_id: "vol_12345678-1234-1234-1234-123456789abc", mount_path: "/data/", subpath: "fixtures/", read_only: false }]), {
      mounts: [{ volumeId: "vol_12345678-1234-1234-1234-123456789abc", mountPath: "/data", subpath: "fixtures", readOnly: false }],
    });
  });

  it("rejects duplicate and unsafe mount paths", () => {
    const id = "vol_12345678-1234-1234-1234-123456789abc";
    assert.deepEqual(parseVolumeMounts([{ volume_id: id, mount_path: "/etc" }]), { error: "Invalid volume mount path: /etc" });
    assert.deepEqual(parseVolumeMounts([{ volume_id: id, mount_path: "/data" }, { volume_id: id, mount_path: "/data" }]), { error: "Duplicate volume mount path: /data" });
  });
});
