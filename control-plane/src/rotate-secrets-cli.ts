import type { PoolClient } from "pg";
import { db } from "./db.js";
import { decryptSecret, encryptSecret, secretContext } from "./secrets.js";

async function rotateEnvironmentVariables(client: PoolClient): Promise<number> {
  const result = await client.query<{
    sandbox_id: string;
    organization_id: string;
    name: string;
    encrypted_value: string;
    iv: string;
  }>(
    `SELECT variables.sandbox_id, sandboxes.organization_id, variables.name,
            variables.encrypted_value, variables.iv
     FROM sandbox_environment_variables variables
     JOIN sandboxes ON sandboxes.id = variables.sandbox_id
     FOR UPDATE OF variables`,
  );
  for (const row of result.rows) {
    const context = secretContext.environment(row.organization_id, row.sandbox_id, row.name);
    const value = decryptSecret(row.encrypted_value, row.iv, context);
    const encrypted = encryptSecret(value, context);
    await client.query(
      `UPDATE sandbox_environment_variables SET encrypted_value = $1, iv = $2
       WHERE sandbox_id = $3 AND name = $4`,
      [encrypted.encryptedValue, encrypted.iv, row.sandbox_id, row.name],
    );
  }
  return result.rowCount ?? 0;
}

async function rotateRegistries(client: PoolClient): Promise<number> {
  const result = await client.query<{
    id: string;
    organization_id: string;
    encrypted_password: string;
    iv: string;
  }>("SELECT id, organization_id, encrypted_password, iv FROM workspace_registries FOR UPDATE");
  for (const row of result.rows) {
    const context = secretContext.registry(row.organization_id, row.id);
    const value = decryptSecret(row.encrypted_password, row.iv, context);
    const encrypted = encryptSecret(value, context);
    await client.query(
      "UPDATE workspace_registries SET encrypted_password = $1, iv = $2 WHERE id = $3",
      [encrypted.encryptedValue, encrypted.iv, row.id],
    );
  }
  return result.rowCount ?? 0;
}

async function rotateWebhooks(client: PoolClient): Promise<number> {
  const result = await client.query<{
    id: string;
    organization_id: string;
    encrypted_secret: string;
    iv: string;
  }>("SELECT id, organization_id, encrypted_secret, iv FROM webhook_endpoints FOR UPDATE");
  for (const row of result.rows) {
    const context = secretContext.webhook(row.organization_id, row.id);
    const value = decryptSecret(row.encrypted_secret, row.iv, context);
    const encrypted = encryptSecret(value, context);
    await client.query(
      "UPDATE webhook_endpoints SET encrypted_secret = $1, iv = $2 WHERE id = $3",
      [encrypted.encryptedValue, encrypted.iv, row.id],
    );
  }
  return result.rowCount ?? 0;
}

const client = await db.connect();
try {
  await client.query("BEGIN");
  const environments = await rotateEnvironmentVariables(client);
  const executions = await client.query<{id:string;organization_id:string;encrypted_environment:string;environment_iv:string}>("SELECT id,organization_id,encrypted_environment,environment_iv FROM sandbox_executions WHERE encrypted_environment IS NOT NULL FOR UPDATE");
  for (const row of executions.rows) {
    const context = `organization:${row.organization_id}:execution:${row.id}:environment`;
    const encrypted = encryptSecret(decryptSecret(row.encrypted_environment,row.environment_iv,context),context);
    await client.query("UPDATE sandbox_executions SET encrypted_environment=$2,environment_iv=$3 WHERE id=$1",[row.id,encrypted.encryptedValue,encrypted.iv]);
  }
  const organizationSecrets = await client.query<{ organization_id: string; name: string; encrypted_value: string; iv: string }>("SELECT organization_id, name, encrypted_value, iv FROM organization_secrets FOR UPDATE");
  for (const row of organizationSecrets.rows) {
    const context = secretContext.organization(row.organization_id, row.name);
    const encrypted = encryptSecret(decryptSecret(row.encrypted_value, row.iv, context), context);
    await client.query("UPDATE organization_secrets SET encrypted_value = $1, iv = $2 WHERE organization_id = $3 AND name = $4", [encrypted.encryptedValue, encrypted.iv, row.organization_id, row.name]);
  }
  const connections = await client.query<{ user_id: string; encrypted_value: string; iv: string }>("SELECT user_id,encrypted_value,iv FROM user_agent_connections WHERE encrypted_value IS NOT NULL FOR UPDATE");
  for (const row of connections.rows) {
    const context = secretContext.agentConnection(row.user_id);
    const encrypted = encryptSecret(decryptSecret(row.encrypted_value, row.iv, context), context);
    await client.query("UPDATE user_agent_connections SET encrypted_value=$2,iv=$3 WHERE user_id=$1", [row.user_id, encrypted.encryptedValue, encrypted.iv]);
  }
  const registries = await rotateRegistries(client);
  const webhooks = await rotateWebhooks(client);
  const github = await client.query<{ organization_id: string; encrypted_token: string; iv: string; refresh_token_encrypted: string | null; refresh_token_iv: string | null }>("SELECT organization_id, encrypted_token, iv, refresh_token_encrypted, refresh_token_iv FROM workspace_github_connections FOR UPDATE");
  for (const row of github.rows) {
    const context = secretContext.github(row.organization_id);
    const encrypted = encryptSecret(decryptSecret(row.encrypted_token, row.iv, context), context);
    const refreshContext = `${context}:refresh`;
    const refresh = row.refresh_token_encrypted && row.refresh_token_iv
      ? encryptSecret(decryptSecret(row.refresh_token_encrypted, row.refresh_token_iv, refreshContext), refreshContext)
      : null;
    await client.query("UPDATE workspace_github_connections SET encrypted_token = $1, iv = $2, refresh_token_encrypted = $3, refresh_token_iv = $4 WHERE organization_id = $5", [encrypted.encryptedValue, encrypted.iv, refresh?.encryptedValue || null, refresh?.iv || null, row.organization_id]);
  }
  const userGithub = await client.query<{ user_id: string; encrypted_token: string; iv: string; refresh_token_encrypted: string | null; refresh_token_iv: string | null }>("SELECT user_id, encrypted_token, iv, refresh_token_encrypted, refresh_token_iv FROM user_github_connections FOR UPDATE");
  for (const row of userGithub.rows) {
    const context = secretContext.userGithub(row.user_id);
    const encrypted = encryptSecret(decryptSecret(row.encrypted_token, row.iv, context), context);
    const refreshContext = `${context}:refresh`;
    const refresh = row.refresh_token_encrypted && row.refresh_token_iv
      ? encryptSecret(decryptSecret(row.refresh_token_encrypted, row.refresh_token_iv, refreshContext), refreshContext)
      : null;
    await client.query("UPDATE user_github_connections SET encrypted_token = $1, iv = $2, refresh_token_encrypted = $3, refresh_token_iv = $4 WHERE user_id = $5", [encrypted.encryptedValue, encrypted.iv, refresh?.encryptedValue || null, refresh?.iv || null, row.user_id]);
  }
  await client.query("COMMIT");
  console.info(JSON.stringify({ event: "secrets_rotated", environments, registries, webhooks }));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await db.end();
}
