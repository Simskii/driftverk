import pg from "pg";
import { grantPlatformAdmin } from "./admin-bootstrap.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--email" || !process.env.DATABASE_URL) {
  console.error("Usage: npm run admin:grant -- --email existing-user@example.com (DATABASE_URL required)");
  process.exitCode = 1;
} else {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try { console.info(JSON.stringify({ event: "platform_admin_granted", userId: await grantPlatformAdmin(pool, args[1]!) })); }
  catch (error) { console.error(error instanceof Error ? error.message : "Admin bootstrap failed"); process.exitCode = 1; }
  finally { await pool.end(); }
}
