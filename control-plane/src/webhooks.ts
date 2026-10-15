import { isIP } from "node:net";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { Context } from "hono";
import { config } from "./config.js";
import { db } from "./db.js";
import { decryptSecret, encryptSecret, secretContext } from "./secrets.js";
import { signWebhook } from "./webhook-signature.js";
import type { AppEnv, AuthSession } from "./types.js";
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from "./webhook-events.js";
import { workspaceFor } from "./workspace.js";

export { queueWebhookEvent } from "./webhook-events.js";

type WebhookEndpoint = {
  id: string;
  organization_id: string;
  name: string;
  url: string;
  event_types: WebhookEventType[];
  encrypted_secret: string;
  iv: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

type ClaimedDelivery = {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  url: string;
  encrypted_secret: string;
  iv: string;
  organization_id: string;
};

const retrySeconds = [0, 30, 300, 1800, 7200, 21600];

function parseEvents(value: unknown): WebhookEventType[] | null {
  if (!Array.isArray(value)) return null;
  const events = [...new Set(value.map(String))];
  if (!events.length || events.some((event) => !WEBHOOK_EVENT_TYPES.includes(event as WebhookEventType))) return null;
  return events as WebhookEventType[];
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("2001:db8:")) return true;
  if (address.startsWith("::ffff:")) return isPrivateAddress(address.slice(7));
  if (isIP(address) !== 4) return false;
  const parts = address.split(".").map(Number);
  const [a = 0, b = 0] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || a >= 224;
}

type WebhookTarget = { url: string; address: string; family: 4 | 6 };

async function resolveWebhookTarget(value: unknown): Promise<WebhookTarget | null> {
  let url: URL;
  try { url = new URL(String(value ?? "").trim()); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
  if (config.nodeEnv !== "production" && (url.hostname === "localhost" || isPrivateAddress(url.hostname))) {
    const local = await lookup(url.hostname).catch(() => null);
    return local ? { url: url.toString(), address: local.address, family: local.family as 4 | 6 } : null;
  }
  if (url.hostname === "localhost" || isPrivateAddress(url.hostname)) return null;
  try {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) return null;
    const selected = addresses[0];
    return selected ? { url: url.toString(), address: selected.address, family: selected.family as 4 | 6 } : null;
  } catch { return null; }
}

async function postWebhook(target: WebhookTarget, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, reject) => {
    const request = httpsRequest(target.url, {
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      },
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { if (responseBody.length < 1000) responseBody += chunk.slice(0, 1000 - responseBody.length); });
      response.on("end", () => resolveRequest({ status: response.statusCode ?? 0, body: responseBody }));
    });
    request.setTimeout(10_000, () => request.destroy(new Error("Webhook request timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

export async function listWebhooks(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  const [endpointResult, deliveries] = await Promise.all([
    db.query<Omit<WebhookEndpoint, "encrypted_secret" | "iv">>(
      `SELECT id, organization_id, name, url, event_types, enabled, created_at, updated_at
       FROM webhook_endpoints WHERE organization_id = $1`,
      [workspace.organization_id],
    ),
    db.query(
      `SELECT id, event_id, event_type, status, attempts, response_status, last_error,
              next_attempt_at, delivered_at, created_at
       FROM webhook_deliveries WHERE organization_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [workspace.organization_id],
    ),
  ]);
  return c.json({
    workspace: { id: workspace.organization_id, name: workspace.organization_name, role: workspace.role },
    endpoint: endpointResult.rows[0] ?? null,
    deliveries: deliveries.rows,
    event_types: WEBHOOK_EVENT_TYPES,
  });
}

export async function createWebhook(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const input = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!input) return c.json({ error: "Invalid JSON body" }, 400);
  const name = String(input.name ?? "").trim();
  const url = (await resolveWebhookTarget(input.url))?.url ?? null;
  const events = parseEvents(input.events);
  if (!name || name.length > 80) return c.json({ error: "Name must contain 1 to 80 characters" }, 400);
  if (!url) return c.json({ error: "Enter a public HTTPS endpoint" }, 400);
  if (!events) return c.json({ error: "Select at least one supported event" }, 400);
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  const webhookId = `wh_${crypto.randomUUID()}`;
  const encrypted = encryptSecret(secret, secretContext.webhook(workspace.organization_id, webhookId));
  try {
    const result = await db.query<{ id: string }>(
      `INSERT INTO webhook_endpoints
       (id, organization_id, name, url, event_types, encrypted_secret, iv, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [webhookId, workspace.organization_id, name, url, events, encrypted.encryptedValue, encrypted.iv, authSession.user.id],
    );
    return c.json({ id: result.rows[0]?.id, secret }, 201);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "23505")
      return c.json({ error: "This organization already has a webhook endpoint" }, 409);
    throw error;
  }
}

export async function updateWebhook(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const input = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!input) return c.json({ error: "Invalid JSON body" }, 400);
  const name = String(input.name ?? "").trim();
  const url = (await resolveWebhookTarget(input.url))?.url ?? null;
  const events = parseEvents(input.events);
  const enabled = input.enabled !== false;
  if (!name || name.length > 80) return c.json({ error: "Name must contain 1 to 80 characters" }, 400);
  if (!url) return c.json({ error: "Enter a public HTTPS endpoint" }, 400);
  if (!events) return c.json({ error: "Select at least one supported event" }, 400);
  const result = await db.query(
    `UPDATE webhook_endpoints SET name = $1, url = $2, event_types = $3, enabled = $4, updated_at = now()
     WHERE id = $5 AND organization_id = $6`,
    [name, url, events, enabled, c.req.param("id"), workspace.organization_id],
  );
  if (!result.rowCount) return c.json({ error: "Webhook endpoint not found" }, 404);
  return c.json({ updated: true });
}

export async function deleteWebhook(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const result = await db.query("DELETE FROM webhook_endpoints WHERE id = $1 AND organization_id = $2", [c.req.param("id"), workspace.organization_id]);
  if (!result.rowCount) return c.json({ error: "Webhook endpoint not found" }, 404);
  return c.json({ deleted: true });
}

export async function testWebhook(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const endpoint = await db.query<{ id: string }>("SELECT id FROM webhook_endpoints WHERE id = $1 AND organization_id = $2", [c.req.param("id"), workspace.organization_id]);
  if (!endpoint.rows[0]) return c.json({ error: "Webhook endpoint not found" }, 404);
  const eventId = `evt_${crypto.randomUUID()}`;
  const deliveryId = `del_${crypto.randomUUID()}`;
  const payload = { id: eventId, type: "webhook.test", created_at: new Date().toISOString(), data: { message: "Driftverk webhook test" } };
  await db.query(
    `INSERT INTO webhook_deliveries (id, endpoint_id, organization_id, event_id, event_type, payload)
     VALUES ($1, $2, $3, $4, 'webhook.test', $5::jsonb)`,
    [deliveryId, endpoint.rows[0].id, workspace.organization_id, eventId, JSON.stringify(payload)],
  );
  await deliverWebhook(deliveryId);
  const delivery = await db.query("SELECT status, response_status, last_error FROM webhook_deliveries WHERE id = $1", [deliveryId]);
  return c.json({ delivery: delivery.rows[0] });
}

export async function retryWebhook(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const result = await db.query(
    `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, response_status = NULL,
       response_body = NULL, last_error = NULL, next_attempt_at = now(), delivered_at = NULL, updated_at = now()
     WHERE id = $1 AND organization_id = $2 AND status IN ('succeeded', 'failed') RETURNING id`,
    [c.req.param("id"), workspace.organization_id],
  );
  if (!result.rowCount) {
    const existing = await db.query(
      "SELECT 1 FROM webhook_deliveries WHERE id = $1 AND organization_id = $2",
      [c.req.param("id"), workspace.organization_id],
    );
    if (existing.rowCount) return c.json({ error: "Only completed webhook deliveries can be retried" }, 409);
    return c.json({ error: "Webhook delivery not found" }, 404);
  }
  return c.json({ queued: true }, 202);
}

async function claimDelivery(deliveryId?: string): Promise<ClaimedDelivery | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<ClaimedDelivery>(
      `SELECT webhook_deliveries.id, webhook_deliveries.endpoint_id, webhook_deliveries.event_id,
              webhook_deliveries.event_type, webhook_deliveries.payload, webhook_deliveries.attempts,
              webhook_endpoints.url, webhook_endpoints.encrypted_secret, webhook_endpoints.iv,
              webhook_endpoints.organization_id
       FROM webhook_deliveries JOIN webhook_endpoints ON webhook_endpoints.id = webhook_deliveries.endpoint_id
       WHERE ($1::text IS NULL OR webhook_deliveries.id = $1)
         AND ($1::text IS NOT NULL OR webhook_endpoints.enabled = true)
         AND (webhook_deliveries.status = 'pending'
           OR (webhook_deliveries.status = 'delivering' AND webhook_deliveries.updated_at < now() - interval '5 minutes'))
         AND webhook_deliveries.next_attempt_at <= now()
       ORDER BY webhook_deliveries.created_at ASC FOR UPDATE OF webhook_deliveries SKIP LOCKED LIMIT 1`,
      [deliveryId ?? null],
    );
    const delivery = result.rows[0];
    if (delivery) await client.query("UPDATE webhook_deliveries SET status = 'delivering', updated_at = now() WHERE id = $1", [delivery.id]);
    await client.query("COMMIT");
    return delivery ?? null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function deliverWebhook(deliveryId?: string): Promise<boolean> {
  const delivery = await claimDelivery(deliveryId);
  if (!delivery) return false;
  const attempt = delivery.attempts + 1;
  let responseStatus: number | null = null;
  let responseBody = "";
  let failure = "";
  try {
    const target = await resolveWebhookTarget(delivery.url);
    if (!target) throw new Error("Endpoint is not a public HTTPS URL");
    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await postWebhook(target, {
        "content-type": "application/json",
        "user-agent": "Driftverk-Webhooks/1.0",
        "webhook-id": delivery.event_id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signWebhook(
          decryptSecret(delivery.encrypted_secret, delivery.iv, secretContext.webhook(delivery.organization_id, delivery.endpoint_id)),
          delivery.event_id,
          timestamp,
          body,
        ),
      }, body);
    responseStatus = response.status;
    responseBody = response.body;
    if (response.status < 200 || response.status >= 300) failure = `Endpoint returned HTTP ${response.status}`;
  } catch (error) {
    failure = error instanceof Error ? error.message.slice(0, 1000) : "Webhook request failed";
  }
  if (!failure) {
    await db.query(
      `UPDATE webhook_deliveries SET status = 'succeeded', attempts = $1, response_status = $2,
       response_body = $3, last_error = NULL, delivered_at = now(), updated_at = now() WHERE id = $4`,
      [attempt, responseStatus, responseBody, delivery.id],
    );
  } else {
    const finalAttempt = attempt >= retrySeconds.length;
    const delay = retrySeconds[Math.min(attempt, retrySeconds.length - 1)] ?? retrySeconds.at(-1) ?? 21600;
    await db.query(
      `UPDATE webhook_deliveries SET status = $1, attempts = $2, response_status = $3,
       response_body = $4, last_error = $5, next_attempt_at = now() + ($6 * interval '1 second'), updated_at = now()
       WHERE id = $7`,
      [finalAttempt ? "failed" : "pending", attempt, responseStatus, responseBody, failure, delay, delivery.id],
    );
  }
  return true;
}

export async function deliverPendingWebhooks(limit = 10): Promise<number> {
  let delivered = 0;
  while (delivered < limit && await deliverWebhook()) delivered += 1;
  return delivered;
}
