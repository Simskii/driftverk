const sshNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function parseSshTarget(value: unknown): {
  organizationSlug: string | null;
  environmentName: string;
} | null {
  const target = String(value ?? "").trim().toLowerCase();
  const parts = target.split(".");
  if (parts.length === 1 && sshNamePattern.test(parts[0] ?? ""))
    return { organizationSlug: null, environmentName: parts[0]! };
  if (parts.length !== 2) return null;
  const [organizationSlug, environmentName] = parts;
  if (!sshNamePattern.test(organizationSlug ?? "") || !sshNamePattern.test(environmentName ?? ""))
    return null;
  return { organizationSlug: organizationSlug!, environmentName: environmentName! };
}
