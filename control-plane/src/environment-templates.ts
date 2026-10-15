import { validateOrganizationSecretReferences } from "./org-secrets.js";
import { resolveSystemSnapshot } from "./system-snapshots.js";
import { deleteProjectSetup } from "./project-setups.js";
import type { Context } from "hono";
import { db } from "./db.js";
import { workspaceFor } from "./workspace.js";
import { parseTemplate } from "./development-config.js";
import type { AppEnv } from "./types.js";

export async function environmentTemplates(c: Context<AppEnv>) {
  const workspace = await workspaceFor(c.get("authSession").user, c.get("authSession").session.activeOrganizationId);
  if (c.req.method === "GET") {
    const result = await db.query("SELECT id, name, configuration, created_at FROM environment_templates WHERE organization_id = $1 ORDER BY name", [workspace.organization_id]);
    return c.json({ templates: result.rows, can_manage: workspace.role === "admin" });
  }
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  if (c.req.method === "DELETE") {
    const client=await db.connect();
    try { await client.query("BEGIN"); const result=await deleteProjectSetup({organizationId:workspace.organization_id,organizationName:workspace.organization_name,organizationSlug:workspace.organization_slug,actorUserId:c.get("authSession").user.id,automationIdPrefix:null},c.req.param("id")!,client); await client.query("COMMIT"); return c.json(result); }
    catch(error) { await client.query("ROLLBACK"); return c.json({error:error instanceof Error?error.message:"Could not delete blueprint"},409); }
    finally {client.release();}
  }
  let template;
  try {
    const input = await c.req.json();
    input.configuration = await resolveSystemSnapshot(input.configuration ?? {});
    template = parseTemplate(input);
    await validateOrganizationSecretReferences(workspace.organization_id, template.configuration.organization_secret_names);
  }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid template" }, 400); }
  const { configuration } = template;
  if (configuration.snapshot_id) {
    const result = await db.query("SELECT 1 FROM workspace_snapshots WHERE id = $1 AND organization_id = $2 AND status = 'ready'", [configuration.snapshot_id, workspace.organization_id]);
    if (!result.rowCount) return c.json({ error: "Snapshot is unavailable" }, 400);
  }
  if (configuration.registry_id) {
    const result = await db.query("SELECT 1 FROM workspace_registries WHERE id = $1 AND organization_id = $2", [configuration.registry_id, workspace.organization_id]);
    if (!result.rowCount) return c.json({ error: "Registry is unavailable" }, 400);
  }
  try {
    if (c.req.method === "PUT") {
      const result = await db.query("UPDATE environment_templates SET name = $1, configuration = $2 WHERE id = $3 AND organization_id = $4 RETURNING id", [template.name, JSON.stringify(configuration), c.req.param("id"), workspace.organization_id]);
      return result.rowCount ? c.json({ template: { id: result.rows[0].id, ...template } }) : c.json({ error: "Template not found" }, 404);
    }
    const id = `template_${crypto.randomUUID()}`;
    await db.query("INSERT INTO environment_templates (id, organization_id, name, configuration) VALUES ($1, $2, $3, $4)", [id, workspace.organization_id, template.name, JSON.stringify(configuration)]);
    return c.json({ template: { id, ...template } }, 201);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "23505") return c.json({ error: "A template with that name already exists" }, 409);
    throw error;
  }
}
