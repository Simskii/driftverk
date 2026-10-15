import type { PoolClient } from "pg";

export const WEBHOOK_EVENT_TYPES = [
  "environment.created",
  "environment.running",
  "environment.stopped",
  "environment.degraded",
  "environment.deleted",
  "snapshot.ready",
  "snapshot.failed",
] as const;

export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number];

export async function queueWebhookEvent(client: PoolClient, organizationId: string, eventType: WebhookEventType, data: Record<string, unknown>) {
  const eventId = `evt_${crypto.randomUUID()}`;
  const payload = { id: eventId, type: eventType, created_at: new Date().toISOString(), data };
  await client.query(
    `INSERT INTO webhook_deliveries (id, endpoint_id, organization_id, event_id, event_type, payload)
     SELECT $1, id, organization_id, $2, $3, $4::jsonb FROM webhook_endpoints
     WHERE organization_id = $5 AND enabled = true AND $3 = ANY(event_types)`,
    [`del_${crypto.randomUUID()}`, eventId, eventType, JSON.stringify(payload), organizationId],
  );
}
