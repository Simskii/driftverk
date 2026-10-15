import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import { compatibleMigrationChecksum } from "./migration-compatibility.js";

const migrationDirectory = fileURLToPath(new URL("../migrations", import.meta.url));
const migrationLockId = 1_154_680_719;

export async function migrate(): Promise<void> {
  const client = await db.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [migrationLockId]);
    locked = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT");
    const files = (await readdir(migrationDirectory))
      .filter((file) => !file.startsWith(".") && file.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const sql = await readFile(join(migrationDirectory, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const alreadyApplied = await client.query<{ checksum: string | null }>(
        "SELECT checksum FROM schema_migrations WHERE name = $1",
        [file],
      );
      if (alreadyApplied.rows[0]) {
        if (alreadyApplied.rows[0].checksum && alreadyApplied.rows[0].checksum !== checksum && !compatibleMigrationChecksum(file, alreadyApplied.rows[0].checksum, checksum))
          throw new Error(`Applied migration has changed: ${file}`);
        if (!alreadyApplied.rows[0].checksum) {
          await client.query("UPDATE schema_migrations SET checksum = $1 WHERE name = $2", [checksum, file]);
          console.warn(JSON.stringify({ event: "migration_checksum_baselined", name: file }));
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query({ text: sql });
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
        console.info(JSON.stringify({ event: "migration_applied", name: file }));
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1)", [migrationLockId]).catch(() => undefined);
    client.release();
  }
}
