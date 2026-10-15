import type { Pool } from "pg";

export async function grantPlatformAdmin(pool: Pool, email: string): Promise<string> {
  if (!email.trim() || !email.includes("@")) throw new Error("Provide an existing verified account with --email");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const users = await client.query('SELECT id,"emailVerified" FROM "user" WHERE lower(email)=lower($1) FOR UPDATE', [email.trim()]);
    if (users.rowCount !== 1 || !users.rows[0].emailVerified) throw new Error("Exactly one verified account must match the email address");
    await client.query('UPDATE "user" SET is_platform_admin=true WHERE id=$1', [users.rows[0].id]);
    await client.query("COMMIT");
    return users.rows[0].id;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
