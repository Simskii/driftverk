import type { Context } from "hono";
import { db } from "./db.js";
import { workspaceFor } from "./workspace.js";
import { createExecution, getExecution, executionTerminal } from "./executions.js";
import { EnvironmentServiceError } from "./environment-service.js";
import type { AppEnv, AuthSession } from "./types.js";

export const desktopStartCommand = "command -v driftverk-browser >/dev/null 2>&1 || { echo 'Desktop tooling is not installed. Use a current Driftverk Dev image.' >&2; exit 42; }; driftverk-browser start";
export const desktopStopCommand = "driftverk-browser stop";

export async function environmentDesktop(c: Context<AppEnv>, session: AuthSession) {
  const workspace = await workspaceFor(session.user, session.session.activeOrganizationId);
  const environmentId = c.req.param("id")!;
  const actor = { organizationId: workspace.organization_id, organizationName: workspace.organization_name,
    organizationSlug: workspace.organization_slug, actorUserId: session.user.id, accessUserId: session.user.id, automationIdPrefix: null };
  c.header("Cache-Control", "no-store");
  try {
    if (c.req.method === "GET") {
      const execution = await getExecution(actor, c.req.query("execution") || "");
      if (execution.environment_id !== environmentId) return c.json({ error: "Execution not found" }, 404);
      // Only expose status for the fixed desktop command through this endpoint.
      const row = (await db.query("SELECT command FROM sandbox_executions WHERE id=$1", [execution.id])).rows[0];
      if (![desktopStartCommand, desktopStopCommand].includes(row?.command)) return c.json({ error: "Desktop operation not found" }, 404);
      return c.json({ pending: !executionTerminal.has(execution.status), ready: execution.status === "succeeded",
        error: execution.status === "succeeded" || !executionTerminal.has(execution.status) ? null : execution.exit_code === 42
          ? "Desktop tooling is not installed. Create an environment using a current Driftverk Dev image."
          : row.command === desktopStopCommand ? "The desktop could not stop. Finish or cancel any active prompt or recording, then retry."
          : "The desktop could not start. Check /tmp/driftverk-browser-*/browser.log in Terminal, then retry." });
    }
    const action = c.req.query("action") || "start";
    if (action !== "start" && action !== "stop") return c.json({ error: "Invalid desktop action" }, 400);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const execution = await createExecution(actor, environmentId, { command: action === "stop" ? desktopStopCommand : desktopStartCommand, cwd: "/", timeout_seconds: 60 }, client);
      await client.query("COMMIT");
      return c.json({ execution_id: execution.id }, 202);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  } catch (error) {
    if (error instanceof EnvironmentServiceError) return c.json({ error: error.message }, error.status as 400);
    throw error;
  }
}
