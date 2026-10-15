import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { db } from "./db.js";
import { migrate } from "./migrate.js";

await migrate();
const { initializeInstallation } = await import("./installation.js");
await initializeInstallation(db, config.installationMode);
const { app } = await import("./app.js");
const { reconcileBilling, reconcileCheckouts } = await import("./billing.js");
const { deliverBillingNotifications } = await import("./billing-notifications.js");
const { deliverPendingWebhooks } = await import("./webhooks.js");
const { reconcileAutoStop, reconcileAutoDelete } = await import("./lifecycle.js");
const { reconcilePreparedPreviews } = await import("./prepared-previews.js");

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.info(JSON.stringify({ event: "control_plane_started", port: info.port }));
});

let webhookDeliveryRunning = false;
const webhookDeliveryTimer = setInterval(() => {
  if (webhookDeliveryRunning) return;
  webhookDeliveryRunning = true;
  void deliverPendingWebhooks().catch((error: unknown) => {
    console.error(JSON.stringify({ event: "webhook_delivery_failed", message: error instanceof Error ? error.message : String(error) }));
  }).finally(() => { webhookDeliveryRunning = false; });
}, 5_000);
webhookDeliveryTimer.unref();

let checkoutReconciliationRunning = false;
const checkoutTimer = setInterval(() => {
  if (checkoutReconciliationRunning) return;
  checkoutReconciliationRunning = true;
  void reconcileCheckouts().catch(error => {
    console.error(JSON.stringify({ event: "billing_reconciliation_failed", message: error instanceof Error ? error.message : String(error) }));
  }).finally(() => { checkoutReconciliationRunning = false; });
}, 60_000);
checkoutTimer.unref();

let billingEmailRunning = false;
const billingEmailTimer = setInterval(() => {
  if (billingEmailRunning) return;
  billingEmailRunning = true;
  void deliverBillingNotifications().catch(error => {
    console.error(JSON.stringify({event:"billing_email_worker_failed",message:error instanceof Error ? error.message : String(error)}));
  }).finally(() => { billingEmailRunning=false; });
},60_000);
billingEmailTimer.unref();

let lifecycleReconciliationRunning = false;
const lifecycleReconciliationTimer = setInterval(() => {
  if (lifecycleReconciliationRunning) return;
  lifecycleReconciliationRunning = true;
  void (async () => {
    // These workers mutate the same environments; avoid competing lock orders.
    for (const reconcile of [reconcileBilling, reconcileAutoStop, reconcileAutoDelete, reconcilePreparedPreviews]) {
      try { await reconcile(); }
      catch (error) { console.error(JSON.stringify({ event: "lifecycle_reconciliation_failed", worker: reconcile.name, message: error instanceof Error ? error.message : String(error) })); }
    }
  })().finally(() => { lifecycleReconciliationRunning = false; });
}, 60_000);
lifecycleReconciliationTimer.unref();

async function shutdown(signal: string) {
  console.info(JSON.stringify({ event: "control_plane_stopping", signal }));
  clearInterval(webhookDeliveryTimer);
  clearInterval(checkoutTimer);
  clearInterval(billingEmailTimer);
  clearInterval(lifecycleReconciliationTimer);
  server.close(async () => {
    await db.end();
    process.exit(0);
  });
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
