export type Session = {
  user: { id: string; name: string; email: string };
  session: { id: string; expiresAt: string };
};

export type Environment = {
  agent_protection?: { expires_at: string; lease_expires_at: string; status: string } | null;
  agent_configuration?: { id: "codex" | "claude"; model: string | null; auth_method?: "subscription" | "api_key" } | null;
  organization_secret_names?: string[];
  application_status?: { status: "starting" | "ready" | "failed"; message: string; services: Array<{name: string; state: string; health: string; exit_code: number}> } | null;
  application_status_at?: string | null;
  preview_enabled: boolean;
  preview_port?: number | null;
  initialization_command?: string | null;
  prebuild_id?: string | null;
  repository?: string | null;
  repository_branch?: string | null;
  setup_command?: string | null;
  startup_command?: string | null;
  readiness_command?: string | null;
  workspace_path?: string | null;
  id: string;
  name: string;
  state: "provisioning" | "running" | "stopped" | "degraded";
  desired_state: "running" | "stopped" | "deleted";
  source_type: "image" | "snapshot";
  source_image: string | null;
  snapshot_id: string | null;
  source_registry_id: string | null;
  cpu_count: number;
  memory_mb: number;
  disk_gb: number;
  runtime_id: string | null;
  compute_node_id: string | null;
  compute_host_name?: string | null;
  provisioning_step: string;
  error_message: string | null;
  active_operation: "create" | "start" | "stop" | "delete" | "snapshot" | null;
  queue_reason: "insufficient_capacity" | null;
  auto_stop_minutes: number | null;
  auto_archive_minutes: number | null;
  auto_delete_minutes: number | null;
  ephemeral: boolean;
  code_trust: "trusted" | "untrusted";
  automation_id: string | null;
  source_revision: string | null;
  has_ever_received_environment_secrets?: boolean;
  environment_variable_names?: string[];
  can_manage_configuration?: boolean;
  can_manage_lifecycle?: boolean;
  can_manage_actions?: boolean;
  volume_mounts?: VolumeMount[];
  ssh_host: string;
  ssh_enabled?: boolean;
  ssh_port: number;
  ssh_username: string;
  ssh_key_count: number;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
};

export type VolumeMount = {
  volume_id: string;
  volume_name: string;
  mount_path: string;
  subpath: string;
  read_only: boolean;
};

export type Volume = {
  id: string;
  name: string;
  storage_prefix: string;
  mount_count: number;
  created_at: string;
};

export type Snapshot = {
  launch_configuration?: {
    cpu: number; memory_mb: number; workspace_path: string | null;
    startup_command: string | null; readiness_command: string | null;
    preview_enabled: boolean; preview_port: number | null;
  } | null;
  is_system?: boolean;
  is_default?: boolean;
  id: string;
  name: string;
  version: string;
  status: "building" | "ready" | "failed";
  kind: "base" | "filesystem";
  base_image: string;
  source_sandbox_id: string | null;
  snapshot_size_gb: number;
  error_message: string | null;
  created_at: string;
  last_used_at: string | null;
};

export type Registry = {
  id: string;
  name: string;
  url: string;
  username: string;
  created_at: string;
  last_used_at: string | null;
};

export type WebhookEventType =
  | "environment.created"
  | "environment.running"
  | "environment.stopped"
  | "environment.degraded"
  | "environment.deleted"
  | "snapshot.ready"
  | "snapshot.failed";

export type WebhookEndpoint = {
  id: string;
  organization_id: string;
  name: string;
  url: string;
  event_types: WebhookEventType[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type WebhookDelivery = {
  id: string;
  event_id: string;
  event_type: WebhookEventType | "webhook.test";
  status: "pending" | "delivering" | "succeeded" | "failed";
  attempts: number;
  response_status: number | null;
  last_error: string | null;
  next_attempt_at: string;
  delivered_at: string | null;
  created_at: string;
};

export type WebhooksPayload = {
  workspace: { id: string; name: string; role: "admin" | "member" };
  endpoint: WebhookEndpoint | null;
  deliveries: WebhookDelivery[];
  event_types: WebhookEventType[];
};

export type EnvironmentsPayload = {
  workspace: { id: string; name: string; role: "admin" | "member" };
  user: { id: string; name: string; email: string };
  environments: Environment[];
};

export type EnvironmentTelemetry = {
  metrics: Array<{ cpu_percent: number; memory_usage_mb: number; memory_percent: number; filesystem_percent: number; recorded_at: string }>;
  logs: Array<{ recorded_at: string; severity: "info" | "error"; message: string }>;
  ports: Array<{ port: number; protocol: "http" | "https"; first_seen_at: string; last_seen_at: string }>;
};

export type SshKey = {
  id: string;
  name: string;
  fingerprint: string;
  created_at: string;
};

export type DriftverkApiKey = {
  id: string;
  name: string;
  secret_prefix: string;
  scopes: Array<"read" | "write" | "delete">;
  automation_id_prefix: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
};

export type TeamPayload = {
  workspace: { id: string; name: string; role: "admin" | "member" };
  current_user_id: string;
  members: Array<{
    id: string;
    user_id: string;
    name: string;
    email: string;
    role: "admin" | "member";
    created_at: string;
    environment_count: number;
    running_environment_count: number;
  }>;
  invitations: Array<{
    id: string;
    email: string;
    role: "admin" | "member";
    status: "pending";
    expires_at: string | null;
    created_at: string;
  }>;
};

export type AdminComputeAgent = {
  id: string;
  organization_id: string;
  name: string;
  last_seen_at: string | null;
  version: string | null;
  storage_driver: "local" | "s3" | null;
  revoked_at: string | null;
  created_at: string;
};

export type AdminOrganization = {
  billing: { balance_ore: string; currency: "usd" | "sek"; complimentary: boolean } | null;
  id: string;
  name: string;
  slug: string;
  hosting_mode: "managed" | "hybrid";
  created_at: string;
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  last_environment_activity_at: string | null;
  member_count: number;
  environment_count: number;
  environment_issue_count: number;
  agents: AdminComputeAgent[];
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => null)) as T | { error?: string; message?: string } | null;
  if (!response.ok) {
    const errorBody = body && typeof body === "object" ? body as { error?: string; message?: string } : null;
    const error = errorBody?.error;
    const message = errorBody?.message;
    throw new ApiError(error || message || "The request failed", response.status);
  }
  return body as T;
}

// Only access endpoints return this pending response; create/delete also use 202
// and must retain their ordinary API behavior.
export async function apiWhenReady<T>(path: string, init?: RequestInit): Promise<T> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const result = await api<T | { status: "starting" }>(path, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
        : AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    if (!result || typeof result !== "object" || !("status" in result) || result.status !== "starting") return result as T;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Environment startup timed out. Check its lifecycle logs and try again.");
}
