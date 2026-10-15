import type { PoolClient } from "pg";
import type { Context } from "hono";
import { db } from "./db.js";
import { parseTemplate } from "./development-config.js";
import { githubRequest, githubToken } from "./github.js";
import { selectHost } from "./host-placement.js";
import { EnvironmentServiceError, type EnvironmentActor } from "./environment-service.js";
import { workspaceFor } from "./workspace.js";
import type { AppEnv } from "./types.js";

export async function listPrebuilds(actor: EnvironmentActor) {
  if (actor.automationIdPrefix) throw new EnvironmentServiceError(403, "Repository-scoped keys cannot access project prebuilds");
  return (await db.query("SELECT id, template_id, snapshot_id, configuration, name, status, repository_revision, error_message, created_at, completed_at FROM project_prebuilds WHERE organization_id = $1 AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM memberships WHERE organization_id=$1 AND user_id=$2 AND role='admin') OR can_access_environment(sandbox_id,$2)) ORDER BY created_at DESC LIMIT 100", [actor.organizationId, actor.accessUserId ?? null])).rows;
}

export async function getPrebuild(actor: EnvironmentActor, id: string) {
  if (actor.automationIdPrefix) throw new EnvironmentServiceError(403, "Repository-scoped keys cannot access project prebuilds");
  const result = await db.query("SELECT id, template_id, snapshot_id, configuration, name, status, repository_revision, error_message, created_at, completed_at FROM project_prebuilds WHERE id = $1 AND organization_id = $2 AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM memberships WHERE organization_id=$2 AND user_id=$3 AND role='admin') OR can_access_environment(sandbox_id,$3))", [id, actor.organizationId, actor.accessUserId ?? null]);
  if (!result.rowCount) throw new EnvironmentServiceError(404, "Prebuild not found");
  return result.rows[0];
}

export async function resolvePrebuild(organizationId: string, input: Record<string, unknown>, client: Pick<PoolClient, "query"> = db): Promise<Record<string, unknown>> {
  if (!input.prebuild_id) return input;
  const result = await client.query(`SELECT p.*, s.status AS snapshot_status FROM project_prebuilds p JOIN workspace_snapshots s ON s.id = p.snapshot_id
    WHERE p.id = $1 AND p.organization_id = $2`, [String(input.prebuild_id), organizationId]);
  const row = result.rows[0];
  if (!row || row.status !== "ready" || row.snapshot_status !== "ready") throw new EnvironmentServiceError(400, "Prebuild is not ready or does not exist");
  const config = row.configuration;
  return { ...config, ...input, prebuild_id: row.id, source_type: "snapshot", snapshot_id: row.snapshot_id, image: undefined, registry_id: undefined,
    repository: config.repository, repository_branch: config.repository_branch, repository_revision: row.repository_revision,
    workspace_path: config.workspace_path, setup_command: null };
}

export async function createPrebuild(actor: EnvironmentActor, templateId: string, hostId?: unknown, transaction?: PoolClient) {
  if (actor.automationIdPrefix) throw new EnvironmentServiceError(403, "Repository-scoped keys cannot build project prebuilds");
  const client = transaction ?? await db.connect();
  try {
    if (!transaction) await client.query("BEGIN");
    const templates = await client.query("SELECT name, configuration FROM environment_templates WHERE id = $1 AND organization_id = $2 FOR UPDATE", [templateId, actor.organizationId]);
    if (!templates.rowCount) throw new EnvironmentServiceError(404, "Project setup not found");
    const existing = await client.query("SELECT id, status FROM project_prebuilds WHERE template_id = $1 AND status = 'building'", [templateId]);
    if (existing.rowCount) { if (!transaction) await client.query("COMMIT"); return existing.rows[0]; }
    const template = parseTemplate(templates.rows[0]);
    const config = template.configuration;
    if (config.source_type !== "image") throw new EnvironmentServiceError(400, "Clean prebuilds must start from an image, not a working snapshot");
    let revision: string | null = null;
    if (config.repository) {
      const commit = await githubRequest(`/repos/${config.repository}/commits/${encodeURIComponent(config.repository_branch || "HEAD")}`, await githubToken(actor.actorUserId, actor.organizationId));
      if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new EnvironmentServiceError(400, "Could not resolve repository revision");
      revision = commit.sha;
    }
    if (config.registry_id && !(await client.query("SELECT 1 FROM workspace_registries WHERE id = $1 AND organization_id = $2", [config.registry_id, actor.organizationId])).rowCount)
      throw new EnvironmentServiceError(400, "Registry is unavailable");
    const host = await selectHost(client, actor.organizationId, hostId, null);
    const id = `prebuild_${crypto.randomUUID()}`, sandboxId = `dev_${crypto.randomUUID()}`, snapshotId = `snap_${crypto.randomUUID()}`;
    await client.query(`INSERT INTO sandboxes (id, preview_id, organization_id, name, source_type, source_image, source_registry_id, cpu_count, memory_mb, disk_gb,
      state, desired_state, created_by_user_id, code_trust, has_ever_received_environment_secrets, purpose, repository, repository_branch, repository_revision, setup_command, workspace_path, compute_node_id)
      VALUES ($1,$2,$3,$4,'image',$5,$6,$7,$8,40,'provisioning','running',$9,'trusted',false,'prebuild',$10,$11,$12,$13,$14,$15)`,
      [sandboxId, crypto.randomUUID(), actor.organizationId, `prebuild-${crypto.randomUUID().slice(0,8)}`, config.image, config.registry_id, config.cpu, config.memory_mb, actor.actorUserId,
        config.repository, config.repository_branch, revision, config.setup_command, config.workspace_path, host]);
    await client.query(`INSERT INTO workspace_snapshots (id, organization_id, name, version, status, base_image, source_sandbox_id, created_by_user_id)
      VALUES ($1,$2,$3,$4,'building',$5,$6,$7)`, [snapshotId, actor.organizationId, template.name, id, config.image, sandboxId, actor.actorUserId]);
    await client.query(`INSERT INTO project_prebuilds (id, organization_id, template_id, sandbox_id, snapshot_id, name, configuration, repository_revision)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, actor.organizationId, templateId, sandboxId, snapshotId, template.name, JSON.stringify(config), revision]);
    await client.query("INSERT INTO compute_jobs (id, sandbox_id, snapshot_id, operation, status, provisioning_step) VALUES ($1,$2,$3,'create','queued','allocating')", [`job_${crypto.randomUUID()}`, sandboxId, snapshotId]);
    if (!transaction) await client.query("COMMIT");
    return { id, status: "building" };
  } catch (error) { if (!transaction) await client.query("ROLLBACK"); throw error; }
  finally { if (!transaction) client.release(); }
}

export async function prebuildsPanel(c: Context<AppEnv>) {
  const session = c.get("authSession");
  const workspace = await workspaceFor(session.user, session.session.activeOrganizationId);
  const actor = { organizationId: workspace.organization_id, organizationName: "", organizationSlug: "", actorUserId: session.user.id, automationIdPrefix: null, accessUserId: session.user.id };
  try {
    if (c.req.method === "GET") return c.json({ prebuilds: await listPrebuilds(actor) });
    if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
    const input = await c.req.json();
    return c.json(await createPrebuild(actor, String(input.template_id ?? ""), input.compute_node_id), 202);
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Could not build project" }, error instanceof EnvironmentServiceError ? error.status as 400 : 400); }
}
