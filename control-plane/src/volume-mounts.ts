export type ParsedVolumeMount = {
  volumeId: string;
  mountPath: string;
  subpath: string;
  readOnly: boolean;
};

const forbiddenRoots = new Set(["/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/sbin", "/sys"]);

function invalidPathSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

export function parseVolumeMounts(input: unknown): { mounts: ParsedVolumeMount[] } | { error: string } {
  if (input === undefined) return { mounts: [] };
  if (!Array.isArray(input)) return { error: "volume_mounts must be an array" };
  if (input.length > 5) return { error: "Mount at most 5 volumes" };

  const mounts: ParsedVolumeMount[] = [];
  const paths = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== "object") return { error: "Invalid volume mount" };
    const value = item as Record<string, unknown>;
    const volumeId = String(value.volume_id ?? "").trim();
    const mountPath = String(value.mount_path ?? "").trim().replace(/\/$/, "");
    const subpath = String(value.subpath ?? "").trim().replace(/^\.\//, "").replace(/\/$/, "");
    const root = `/${mountPath.split("/").filter(Boolean)[0] ?? ""}`;
    if (!/^vol_[0-9a-f-]{36}$/.test(volumeId)) return { error: "Select a valid volume" };
    if (!mountPath.startsWith("/") || mountPath === "/" || mountPath.length > 240 || mountPath.includes(",") || mountPath.includes("//") || invalidPathSegment(mountPath) || forbiddenRoots.has(root))
      return { error: `Invalid volume mount path: ${mountPath || "empty"}` };
    if (subpath.startsWith("/") || subpath.length > 240 || subpath.includes(",") || subpath.includes("//") || invalidPathSegment(subpath))
      return { error: `Invalid volume subpath: ${subpath}` };
    if (paths.has(mountPath)) return { error: `Duplicate volume mount path: ${mountPath}` };
    paths.add(mountPath);
    mounts.push({ volumeId, mountPath, subpath, readOnly: value.read_only !== false });
  }
  return { mounts };
}
