import type { Context } from "hono";
import { db } from "./db.js";
import { parsePublicKey } from "./ssh-public-key.js";
import type { AppEnv, AuthSession } from "./types.js";

const maxSshKeysPerUser = 10;

export async function listSshKeys(c: Context<AppEnv>, authSession: AuthSession) {
  const result = await db.query<{ id: string; name: string; fingerprint: string; created_at: Date }>(
    `SELECT id, name, fingerprint, created_at
     FROM user_ssh_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [authSession.user.id],
  );
  return c.json({ keys: result.rows });
}

export async function createSshKey(c: Context<AppEnv>, authSession: AuthSession) {
  const input = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!input) return c.json({ error: "Invalid JSON body" }, 400);
  const name = String(input.name ?? "").trim();
  const parsed = parsePublicKey(input.public_key);
  if (!name || name.length > 80) return c.json({ error: "Name must contain 1 to 80 characters" }, 400);
  if (!parsed) return c.json({ error: "Paste a valid OpenSSH public key" }, 400);
  const count = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM user_ssh_keys WHERE user_id = $1",
    [authSession.user.id],
  );
  if (Number(count.rows[0]?.count ?? 0) >= maxSshKeysPerUser)
    return c.json({ error: `You can add at most ${maxSshKeysPerUser} SSH keys` }, 409);
  try {
    const result = await db.query<{ id: string; name: string; fingerprint: string; created_at: Date }>(
      `INSERT INTO user_ssh_keys (id, user_id, name, public_key, fingerprint)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, fingerprint, created_at`,
      [`key_${crypto.randomUUID()}`, authSession.user.id, name, parsed.publicKey, parsed.fingerprint],
    );
    return c.json({ key: result.rows[0] }, 201);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "23505")
      return c.json({ error: "This SSH key has already been added" }, 409);
    throw error;
  }
}

export async function deleteSshKey(c: Context<AppEnv>, authSession: AuthSession) {
  const result = await db.query(
    "DELETE FROM user_ssh_keys WHERE id = $1 AND user_id = $2",
    [c.req.param("id"), authSession.user.id],
  );
  if (!result.rowCount) return c.json({ error: "SSH key not found" }, 404);
  return c.json({ ok: true });
}
