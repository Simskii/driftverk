import type { Pool } from "pg";

export type InstallationMode = "hosted" | "self-hosted";

export function installationMode(value = "hosted"): InstallationMode {
  if (value !== "hosted" && value !== "self-hosted") throw new Error("INSTALLATION_MODE must be hosted or self-hosted");
  return value;
}

// Bind a database to one mode. A configuration typo must never disable hosted billing.
export async function initializeInstallation(pool: Pool, mode: InstallationMode): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE installation_settings IN EXCLUSIVE MODE");
    const existing = await client.query("SELECT mode FROM installation_settings WHERE singleton");
    if (existing.rowCount) {
      if (existing.rows[0].mode !== mode) throw new Error("INSTALLATION_MODE differs from this database. Use a separate database for a different installation mode.");
    } else {
      if (mode === "self-hosted" && (await client.query("SELECT 1 FROM organizations LIMIT 1")).rowCount)
        throw new Error("Self-hosted mode requires a new database; existing organizations must not be converted automatically.");
      await client.query("INSERT INTO installation_settings(singleton,mode) VALUES(true,$1)", [mode]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
