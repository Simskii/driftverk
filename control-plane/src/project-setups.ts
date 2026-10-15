import { resolveSystemSnapshot } from "./system-snapshots.js";
import type { PoolClient } from "pg";
import { db } from "./db.js";
import { parseTemplate } from "./development-config.js";
import { EnvironmentServiceError, type EnvironmentActor } from "./environment-service.js";
import { deletePreparedSpare } from "./prepared-previews.js";

function requireProjectAccess(actor: EnvironmentActor) {
  if (actor.automationIdPrefix) throw new EnvironmentServiceError(403, "Repository-scoped keys cannot access project setups");
}

export async function listProjectSetups(actor: EnvironmentActor) {
  requireProjectAccess(actor);
  return (await db.query("SELECT id, name, configuration, created_at FROM environment_templates WHERE organization_id = $1 ORDER BY name", [actor.organizationId])).rows;
}

export async function getProjectSetup(actor: EnvironmentActor, id: string) {
  requireProjectAccess(actor);
  const result = await db.query("SELECT id, name, configuration, created_at FROM environment_templates WHERE id = $1 AND organization_id = $2", [id, actor.organizationId]);
  if (!result.rowCount) throw new EnvironmentServiceError(404, "Project setup not found");
  return result.rows[0];
}

// The caller owns the transaction, including the idempotency reservation.
export async function saveProjectSetup(actor: EnvironmentActor, input: unknown, client: PoolClient, id?: string) {
  requireProjectAccess(actor);
  let template;
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A project setup object is required");
    const raw = input as Record<string, unknown>;
    const configuration = raw.configuration;
    template = parseTemplate({ ...raw, configuration: configuration && typeof configuration === "object" && !Array.isArray(configuration)
      ? await resolveSystemSnapshot(configuration as Record<string, unknown>, client) : configuration });
  } catch (error) {
    throw new EnvironmentServiceError(400, error instanceof Error ? error.message : "Invalid project setup");
  }
  if (id) {
    const existing = await client.query("SELECT id FROM environment_templates WHERE id = $1 AND organization_id = $2 FOR UPDATE", [id, actor.organizationId]);
    if (!existing.rowCount) throw new EnvironmentServiceError(404, "Project setup not found");
  }
  const { configuration } = template;
  if (configuration.snapshot_id && !(await client.query("SELECT 1 FROM workspace_snapshots WHERE id = $1 AND organization_id = $2 AND status = 'ready'", [configuration.snapshot_id, actor.organizationId])).rowCount)
    throw new EnvironmentServiceError(400, "Snapshot is unavailable");
  if (configuration.registry_id && !(await client.query("SELECT 1 FROM workspace_registries WHERE id = $1 AND organization_id = $2", [configuration.registry_id, actor.organizationId])).rowCount)
    throw new EnvironmentServiceError(400, "Registry is unavailable");
  try {
    const values = [id ?? `template_${crypto.randomUUID()}`, actor.organizationId, template.name, JSON.stringify(configuration)];
    const result = await client.query(id
      ? "UPDATE environment_templates SET name = $3, configuration = $4 WHERE id = $1 AND organization_id = $2 RETURNING id, name, configuration, created_at"
      : "INSERT INTO environment_templates (id, organization_id, name, configuration) VALUES ($1, $2, $3, $4) RETURNING id, name, configuration, created_at", values);
    return result.rows[0];
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "23505") throw new EnvironmentServiceError(409, "A project setup with that name already exists");
    throw error;
  }
}

export async function deleteProjectSetup(actor: EnvironmentActor, id: string, client: PoolClient) {
  requireProjectAccess(actor);
  await deletePreparedSpare(actor,id,client);
  const result = await client.query("DELETE FROM environment_templates WHERE id = $1 AND organization_id = $2 RETURNING id", [id, actor.organizationId]);
  if (!result.rowCount) throw new EnvironmentServiceError(404, "Project setup not found");
  return { deleted: true };
}
