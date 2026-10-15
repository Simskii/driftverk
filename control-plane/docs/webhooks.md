# Driftverk webhooks

Driftverk sends lifecycle events from the control plane. Delivery is asynchronous and at least once. A request can arrive more than once if the receiver accepted it but the control plane could not record the successful response.

## Idempotency

Every event has a stable ID in both the JSON body and the `webhook-id` header. Retries keep the same ID. Store that value in a column with a unique constraint before applying the event. If the ID already exists, return a successful response without applying the event again.

## Request format

```json
{
  "id": "evt_...",
  "type": "environment.running",
  "created_at": "2026-09-04T11:30:00.000Z",
  "data": {
    "environment": {
      "id": "dev_...",
      "name": "app-01",
      "state": "running"
    }
  }
}
```

Each request includes:

- `webhook-id`: stable event ID used for deduplication
- `webhook-timestamp`: Unix timestamp used when signing the request
- `webhook-signature`: `v1,<base64 HMAC-SHA256>`

The signed value is `<webhook-id>.<webhook-timestamp>.<raw request body>`. Verify the signature against the raw body before parsing JSON. Reject stale timestamps according to the receiver's tolerance.

Return any `2xx` status after the event has been stored. Other responses are retried automatically. Manual retry is available only after a delivery has succeeded or permanently failed.
