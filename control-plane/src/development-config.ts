import { parseAgentId, parseAgentAuthMethod } from "./agent-config.js";
export function parsePreviewPort(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if ((typeof value !== "number" && typeof value !== "string") || !/^\d+$/.test(String(value)) || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 65535)
    throw new Error("Enter a preview port between 1 and 65535");
  return Number(value);
}

export function parseDevelopmentConfig(input: Record<string, unknown>) {
  const repository = String(input.repository ?? "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const branch = String(input.repository_branch ?? "").trim();
  const setup = String(input.setup_command ?? "").trim();
  if (repository && (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) || repository.length > 200 || repository.split("/").some(part => part === "." || part === "..")))
    throw new Error("Enter a GitHub repository as owner/repository");
  if (branch && (!repository || branch.length > 200 || branch.startsWith("-") || /[\s~^:?*\[\\]/.test(branch) || branch.includes("..") || branch.includes("@{") || branch.endsWith("/") || branch.endsWith(".") || branch.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"))))
    throw new Error("Enter a valid repository branch");
  const initialize = String(input.initialization_command ?? "").trim();
  const startup = String(input.startup_command ?? "").trim();
  const readiness = String(input.readiness_command ?? "").trim();
  for (const [label, command] of [["Initialization", initialize], ["Startup", startup], ["Readiness", readiness]] as const) {
    if (command.length > 8000 || command.includes("\0")) throw new Error(`${label} command must be at most 8000 characters`);
  }
  if (setup.length > 8000 || setup.includes("\0")) throw new Error("Setup command must be at most 8000 characters");
  const workspacePath = String(input.workspace_path ?? "").trim();
  if (workspacePath && (!/^\/(?:workspace|workspaces)(?:\/[A-Za-z0-9_.-]+)*$/.test(workspacePath) || workspacePath.split("/").some(part => part === "." || part === "..")))
    throw new Error("Working directory must be a path under /workspace or /workspaces");
  return { repository: repository || null, repository_branch: branch || null, setup_command: setup || null, startup_command: startup || null, readiness_command: readiness || null, initialization_command: initialize || null,
    workspace_path: workspacePath || (repository ? `/workspaces/${repository.split("/")[1]}` : setup || initialize || startup || readiness ? "/workspace" : null) };
}

export function parseTemplate(input: Record<string, unknown>) {
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 80) throw new Error("Use a template name of 1–80 characters");
  const source = input.configuration;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Template configuration is required");
  const value = source as Record<string, unknown>;
  const source_type = value.source_type === "snapshot" ? "snapshot" : "image";
  const image = String(value.image ?? "").trim();
  const snapshot_id = String(value.snapshot_id ?? "").trim();
  const registry_id = String(value.registry_id ?? "").trim();
  const cpu = Number(value.cpu ?? 1), memory_mb = Number(value.memory_mb ?? 2048);
  if (![1, 2, 4, 8].includes(cpu) || ![1024, 2048, 4096, 8192, 16384].includes(memory_mb)) throw new Error("Invalid template resources");
  if (source_type === "image" && (!image || /\s|\.\./.test(image) || image.length > 240)) throw new Error("Invalid image");
  if (source_type === "snapshot" && !snapshot_id) throw new Error("Choose a snapshot");
  const auto_stop_minutes = value.auto_stop_minutes === null ? null : Number(value.auto_stop_minutes ?? 15);
  if (auto_stop_minutes !== null && (!Number.isInteger(auto_stop_minutes) || auto_stop_minutes < 1 || auto_stop_minutes > 525600)) throw new Error("Invalid idle timeout");
  // Only these fields are reusable. Never persist submitted credentials or environment variables.
  return { name, configuration: { agent_id: parseAgentId(value.agent_id), agent_auth_method: parseAgentAuthMethod(value.agent_auth_method), source_type, image: source_type === "image" ? image : null,
    snapshot_id: source_type === "snapshot" ? snapshot_id : null, registry_id: source_type === "image" ? registry_id || null : null,
    organization_secret_names: parseOrganizationSecretNames(value.organization_secret_names), cpu, memory_mb, auto_stop_minutes, preview_enabled: value.preview_enabled !== false, preview_port: parsePreviewPort(value.preview_port), ...parseDevelopmentConfig(value) } };
}

export function parseOrganizationSecretNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 25 || value.some(name => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) || new Set(value).size !== value.length)
    throw new Error("Use at most 25 unique organization secret names");
  return value as string[];
}
