import Stripe from "stripe";
import type { Context } from "hono";
import type { PoolClient } from "pg";
import { HTTPException } from "hono/http-exception";
import { db } from "./db.js";
import { config } from "./config.js";
import { workspaceFor } from "./workspace.js";
import type { AppEnv } from "./types.js";

// Integer USD cents. The existing *_ore API fields remain compatible minor units.
export const HYBRID_MONTHLY_ORE = 19_900;
export const HYBRID_PILOT_CENTS = 29_900;
export const HYBRID_EXTRA_HOST_CENTS = 4_900;
export const TOPUP_AMOUNTS = [2_000, 5_000, 10_000] as const;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 15_000 }) : null;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const stripeLiveMode = /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY || "");
async function assertPaymentMode() {
  await db.query("INSERT INTO billing_payment_mode(singleton,livemode) VALUES(true,$1) ON CONFLICT DO NOTHING", [stripeLiveMode]);
  const result = await db.query("SELECT livemode FROM billing_payment_mode WHERE singleton");
  if (result.rows[0]?.livemode !== stripeLiveMode) throw new HTTPException(503, { message: "Stripe mode differs from this billing database. Reconcile billing before switching modes." });
}
export const isBillingError = (error: unknown): error is Error & { code: "P0402" } => error instanceof Error && "code" in error && error.code === "P0402";
function payments() {
  if (config.selfHosted) throw new HTTPException(404, { message: "Billing is disabled for this installation" });
  if (!stripe || !webhookSecret) throw new HTTPException(503, { message: "Payments are not configured yet. Contact support." });
  return stripe;
}
async function workspace(c: Context<AppEnv>, admin = false) {
  const session = c.get("authSession");
  const result = await workspaceFor(session.user, session.session.activeOrganizationId);
  if (admin && result.role !== "admin") throw new HTTPException(403, { message: "Organization admin access required" });
  return result;
}

export async function billingSummary(c: Context<AppEnv>) {
  const org = await workspace(c);
  await db.query("SELECT billing_settle($1)", [org.organization_id]);
  const [account, ledger, daily, resources] = await Promise.all([
    db.query(`SELECT b.complimentary,b.balance_ore,b.subscription_status,b.paid_until,b.trial_ends_at,b.exhausted_at,
      b.cpu_hour_ore,b.ram_gb_hour_ore,b.storage_gb_hour_ore,b.currency,b.host_limit,b.pilot_approved_at,b.pilot_ends_at,o.hosting_mode,
      GREATEST(0,5-COALESCE((SELECT sum(storage_hour_ore)/NULLIF(b.storage_gb_hour_ore,0) FROM billing_resources WHERE organization_id=b.organization_id),0)) AS free_storage_gib,
      (b.stripe_customer_id IS NOT NULL) AS has_customer,
      COALESCE((SELECT sum(CASE WHEN compute_until>now() THEN compute_hour_ore ELSE 0 END+storage_hour_ore) FROM billing_resources WHERE organization_id=b.organization_id),0) -CASE WHEN b.currency='usd' THEN LEAST(5*b.storage_gb_hour_ore,COALESCE((SELECT sum(storage_hour_ore) FROM billing_resources WHERE organization_id=b.organization_id),0)) ELSE 0 END AS hourly_ore,
      COALESCE((SELECT sum(reserved_hour_ore+storage_hour_ore)/60 FROM billing_resources WHERE organization_id=b.organization_id),0) AS reserved_ore
      FROM billing_accounts b JOIN organizations o ON o.id=b.organization_id WHERE b.organization_id=$1`, [org.organization_id]),
    db.query("SELECT id,amount_ore,kind,description,created_at FROM billing_ledger WHERE organization_id=$1 ORDER BY id DESC LIMIT 50", [org.organization_id]),
    db.query(`SELECT to_char(day,'YYYY-MM-DD') AS day, COALESCE(-sum(l.amount_ore),0) AS amount_ore
      FROM generate_series(((now() AT TIME ZONE 'UTC')::date-29)::timestamp,((now() AT TIME ZONE 'UTC')::date)::timestamp,interval '1 day') day
      LEFT JOIN billing_ledger l ON l.organization_id=$1 AND l.kind='usage'
        AND l.created_at >= day AT TIME ZONE 'UTC' AND l.created_at < (day+interval '1 day') AT TIME ZONE 'UTC'
      GROUP BY day ORDER BY day`, [org.organization_id]),
    db.query(`SELECT r.id,s.name AS environment_name,COALESCE(s.name, snap.name, v.name, r.id) AS name,
      CASE WHEN s.id IS NOT NULL THEN 'Environment' WHEN snap.id IS NOT NULL THEN 'Snapshot' WHEN v.id IS NOT NULL THEN 'Volume' ELSE 'Removed resource' END AS resource_type,
      CASE WHEN r.compute_until>now() THEN r.compute_hour_ore ELSE 0 END AS compute_hour_ore,r.storage_hour_ore
      FROM billing_resources r LEFT JOIN sandboxes s ON s.id=r.id AND s.organization_id=r.organization_id
      LEFT JOIN workspace_snapshots snap ON snap.id=r.id AND snap.organization_id=r.organization_id
      LEFT JOIN workspace_volumes v ON v.id=r.id AND v.organization_id=r.organization_id
      WHERE r.organization_id=$1 AND ($2::boolean OR can_access_environment(s.id,$3) OR can_access_environment(snap.source_sandbox_id,$3)) ORDER BY r.compute_hour_ore+r.storage_hour_ore DESC,r.id`, [org.organization_id, org.role === "admin", c.get("authSession").user.id]),
  ]);
  c.header("Cache-Control", "no-store");
  return c.json({ installation_mode: config.installationMode, ...account.rows[0], role: org.role, payments_available: !config.selfHosted && Boolean(stripe && webhookSecret), hybrid_monthly_ore: HYBRID_MONTHLY_ORE, hybrid_pilot_cents: HYBRID_PILOT_CENTS, hybrid_extra_host_cents: HYBRID_EXTRA_HOST_CENTS, topup_amounts: TOPUP_AMOUNTS, transactions: ledger.rows, daily_usage: daily.rows, resources: resources.rows });
}

export async function billingCheckout(c: Context<AppEnv>) {
  const org = await workspace(c, true);
  const input = await c.req.json().catch(() => null);
  const kind = input?.kind;
  if (kind !== "hybrid" && kind !== "topup" && kind !== "pilot") throw new HTTPException(400, { message: "Choose a plan or Cloud top-up" });
  const extraHosts = kind === "hybrid" ? (input?.extra_hosts ?? 0) : 0;
  if (!Number.isInteger(extraHosts) || extraHosts < 0 || extraHosts > 100) throw new HTTPException(400, { message: "Choose between 0 and 100 additional hosts" });
  const amount = kind === "hybrid" ? HYBRID_MONTHLY_ORE + extraHosts * HYBRID_EXTRA_HOST_CENTS : kind === "pilot" ? HYBRID_PILOT_CENTS : input?.amount_ore;
  if (kind === "topup" && !TOPUP_AMOUNTS.includes(amount)) throw new HTTPException(400, { message: "Choose $20, $50 or $100" });
  const provider = payments();
  await assertPaymentMode();
  const client = await db.connect();
  let checkout;
  let customer: string;
  try {
    await client.query("BEGIN");
    const result = await client.query(`SELECT b.*,o.hosting_mode FROM billing_accounts b JOIN organizations o ON o.id=b.organization_id WHERE b.organization_id=$1 FOR UPDATE OF b`, [org.organization_id]);
    const account = result.rows[0];
    if (account.complimentary) throw new HTTPException(409, { message: "This pilot organization has complimentary access. Contact support to switch to paid billing." });
    if ((kind !== "topup") !== (account.hosting_mode === "hybrid")) throw new HTTPException(409, { message: "This purchase does not match your hosting mode" });
    if (account.currency !== "usd") throw new HTTPException(409, { message: "Contact support to migrate this legacy SEK billing account before purchasing" });
    if (kind === "pilot" && (!account.pilot_approved_at || account.pilot_ends_at || account.stripe_subscription_id))
      throw new HTTPException(409, { message: "Pilot scope must be agreed with Driftverk before payment. Each organization can purchase one pilot." });
    if (kind === "hybrid" && account.stripe_subscription_id && !["canceled", "incomplete_expired"].includes(account.subscription_status))
      throw new HTTPException(409, { message: "Manage the existing subscription in the billing portal" });
    if (kind !== "topup") {
      const connected = Number((await client.query("SELECT count(*) FROM compute_agents WHERE organization_id=$1 AND revoked_at IS NULL", [org.organization_id])).rows[0].count);
      if (connected > 2+extraHosts) throw new HTTPException(409, { message: `Select capacity for all ${connected} connected hosts, or disconnect hosts first` });
      const pending = (await client.query("SELECT * FROM billing_checkouts WHERE organization_id=$1 AND kind IN ('hybrid','pilot') AND completed_at IS NULL AND abandoned_at IS NULL ORDER BY expires_at DESC LIMIT 1", [org.organization_id])).rows[0];
      if (pending) {
        if (new Date(pending.expires_at).getTime() <= Date.now()+60_000) {
          const remote = pending.stripe_session_id ? await provider.checkout.sessions.retrieve(pending.stripe_session_id) : null;
          if (remote?.status === "expired") await client.query("UPDATE billing_checkouts SET abandoned_at=now() WHERE id=$1", [pending.id]);
          else throw new HTTPException(409, { message: "Your previous checkout is still awaiting confirmation. Contact support if it does not update." });
        } else if (pending.kind !== kind || pending.amount_ore !== amount) throw new HTTPException(409, { message: "Finish the pending Hybrid checkout or wait for it to expire before changing the purchase" });
      }
    }
    customer = account.stripe_customer_id;
    if (!customer) {
      const created = await provider.customers.create({ name: org.organization_name, email: c.get("authSession").user.email, metadata: { organization_id: org.organization_id } }, { idempotencyKey: `driftverk-customer:${org.organization_id}` });
      customer = created.id;
      await client.query("UPDATE billing_accounts SET stripe_customer_id=$1 WHERE organization_id=$2", [customer, org.organization_id]);
    }
    checkout = (await client.query(`SELECT * FROM billing_checkouts WHERE organization_id=$1 AND kind=$2 AND amount_ore=$3 AND completed_at IS NULL AND expires_at>now()+interval '1 minute' ORDER BY expires_at DESC LIMIT 1`, [org.organization_id, kind, amount])).rows[0];
    if (!checkout) checkout = (await client.query(`INSERT INTO billing_checkouts(id,organization_id,kind,amount_ore,expires_at) VALUES($1,$2,$3,$4,now()+interval '35 minutes') RETURNING *`, [`checkout_${crypto.randomUUID()}`, org.organization_id, kind, amount])).rows[0];
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  if (checkout.url) return c.json({ url: checkout.url });
  const session = await provider.checkout.sessions.create({
    mode: kind === "hybrid" ? "subscription" : "payment", customer,
    ...(kind !== "topup" ? { payment_method_types: ["card" as const] } : {}),
    client_reference_id: checkout.id,
    metadata: { checkout_id: checkout.id },
    expires_at: Math.floor(new Date(checkout.expires_at).getTime()/1000),
    success_url: `${config.betterAuthUrl}/billing?checkout=success`,
    cancel_url: `${config.betterAuthUrl}/billing?checkout=canceled`,
    billing_address_collection: "required", customer_update: { address: "auto", name: "auto" },
    tax_id_collection: { enabled: true }, automatic_tax: { enabled: true },
    line_items: [{ quantity: 1, price_data: {
      currency: "usd", unit_amount: amount, tax_behavior: "exclusive",
      product_data: { name: kind === "hybrid" ? "Driftverk Hybrid" : kind === "pilot" ? "Driftverk Hybrid pilot · 30 days · 2 hosts" : `Driftverk Cloud · $${amount/100} balance` },
      ...(kind === "hybrid" ? { recurring: { interval: "month" as const } } : {}),
    } }],
    ...(kind === "hybrid" ? { subscription_data: { metadata: { organization_id: org.organization_id } } } : { invoice_creation: { enabled: true }, payment_intent_data: { metadata: { checkout_id: checkout.id } } }),
  }, { idempotencyKey: checkout.id });
  await db.query("UPDATE billing_checkouts SET stripe_session_id=$1,url=$2 WHERE id=$3", [session.id, session.url, checkout.id]);
  return c.json({ url: session.url });
}

export async function billingPortal(c: Context<AppEnv>) {
  const org = await workspace(c, true);
  payments();
  await assertPaymentMode();
  const account = (await db.query("SELECT stripe_customer_id FROM billing_accounts WHERE organization_id=$1", [org.organization_id])).rows[0];
  if (!account?.stripe_customer_id) throw new HTTPException(409, { message: "No billing customer yet" });
  const session = await payments().billingPortal.sessions.create({ customer: account.stripe_customer_id, return_url: `${config.betterAuthUrl}/billing` });
  return c.json({ url: session.url });
}

// Increase capacity with an immediately invoiced, payment-contingent Stripe update.
// Reductions are handled through support so connected hosts cannot lose slots silently.
export async function billingHosts(c: Context<AppEnv>) {
  const org = await workspace(c, true);
  const input = await c.req.json().catch(() => null);
  const extra = input?.extra_hosts;
  if (!Number.isInteger(extra) || extra < 1 || extra > 100) throw new HTTPException(400, { message: "Choose 1–100 additional hosts" });
  const provider = payments();
  await assertPaymentMode();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const account = (await client.query("SELECT * FROM billing_accounts WHERE organization_id=$1 FOR UPDATE", [org.organization_id])).rows[0];
    if (account.currency !== "usd" || !account.stripe_subscription_id || account.subscription_status !== "active" || extra+2 <= account.host_limit)
      throw new HTTPException(409, { message: "An active Hybrid subscription is required. Choose a higher host limit; contact support for reductions." });
    const sub = await provider.subscriptions.retrieve(account.stripe_subscription_id, { expand: ["latest_invoice"] });
    if (sub.pending_update) throw new HTTPException(409, { message: "Pay the pending invoice before changing your host limit again" });
    const item = sub.items.data[0];
    if (sub.items.data.length !== 1 || !item) throw new HTTPException(409, { message: "Contact support to update this subscription" });
    const product = typeof item.price.product === "string" ? item.price.product : item.price.product.id;
    const updated = await provider.subscriptions.update(sub.id, {
      items: [{ id: item.id, quantity: 1, price_data: { currency: "usd", product, unit_amount: HYBRID_MONTHLY_ORE+extra*HYBRID_EXTRA_HOST_CENTS, tax_behavior: "exclusive", recurring: { interval: "month" } } }],
      payment_behavior: "pending_if_incomplete", proration_behavior: "always_invoice", expand: ["latest_invoice"],
    }, { idempotencyKey: `hybrid-hosts:${sub.id}:${item.price.id}:${extra}` });
    // Do not call syncSubscription while holding a second connection/account lock.
    await syncSubscription(client, sub.id, provider);
    await client.query("COMMIT");
    const invoice = typeof updated.latest_invoice === "object" ? updated.latest_invoice : null;
    return c.json({ url: updated.pending_update && invoice?.hosted_invoice_url ? invoice.hosted_invoice_url : `${config.betterAuthUrl}/billing` });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

// Persist one credit per paid Checkout, regardless of event retries or event ordering.
export async function fulfillCheckout(client: PoolClient, session: Stripe.Checkout.Session) {
  if (session.livemode !== stripeLiveMode) throw new Error("Checkout Stripe mode mismatch");
  const checkout = (await client.query("SELECT * FROM billing_checkouts WHERE id=$1 FOR UPDATE", [session.client_reference_id])).rows[0];
  if (!checkout || checkout.completed_at) return;
  if (session.payment_status !== "paid" && checkout.kind !== "hybrid") return;
  const account = (await client.query("SELECT stripe_customer_id FROM billing_accounts WHERE organization_id=$1 FOR UPDATE", [checkout.organization_id])).rows[0];
  if (session.customer !== account.stripe_customer_id || session.currency !== checkout.currency || session.amount_subtotal !== checkout.amount_ore ||
      session.mode !== (checkout.kind === "hybrid" ? "subscription" : "payment") || (checkout.stripe_session_id && checkout.stripe_session_id !== session.id))
    throw new Error("Checkout does not match the recorded purchase");
  if (checkout.kind === "topup") {
    // Advance metering while the old balance still applies. Retained storage at
    // zero must not be charged retroactively against newly purchased credit.
    await client.query("SELECT billing_settle($1)", [checkout.organization_id]);
    const credit = await client.query(`INSERT INTO billing_ledger(organization_id,amount_ore,kind,reference,description) VALUES($1,$2,'purchase',$3,'Cloud balance purchase') ON CONFLICT(reference) DO NOTHING RETURNING id`, [checkout.organization_id, checkout.amount_ore, session.id]);
    if (credit.rowCount) await client.query("UPDATE billing_accounts SET balance_ore=balance_ore+$1,exhausted_at=NULL WHERE organization_id=$2", [checkout.amount_ore, checkout.organization_id]);
  } else if (checkout.kind === "pilot") {
    await client.query("UPDATE billing_accounts SET pilot_ends_at=COALESCE(pilot_ends_at,now()+interval '30 days') WHERE organization_id=$1", [checkout.organization_id]);
  } else {
    const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    if (!subscriptionId) throw new Error("Hybrid checkout has no subscription");
    await client.query("UPDATE billing_accounts SET stripe_subscription_id=$1 WHERE organization_id=$2", [subscriptionId, checkout.organization_id]);
  }
  await client.query("UPDATE billing_checkouts SET completed_at=CASE WHEN $3 THEN now() ELSE completed_at END,stripe_session_id=$1 WHERE id=$2", [session.id, checkout.id, session.payment_status === "paid"]);
}

export async function applyRefund(client: PoolClient, charge: Stripe.Charge) {
  const checkout = (await client.query("SELECT * FROM billing_checkouts WHERE id=$1 AND kind='topup'", [charge.metadata.checkout_id])).rows[0];
  if (!checkout || charge.amount<=0 || charge.currency!==checkout.currency) return;
  if (!checkout.completed_at) throw new Error("Retry refund after Checkout fulfillment");
  const account = (await client.query("SELECT * FROM billing_accounts WHERE organization_id=$1 FOR UPDATE", [checkout.organization_id])).rows[0];
  if (charge.customer!==account.stripe_customer_id) throw new Error("Refund customer mismatch");
  const desired = Math.floor(checkout.amount_ore * Math.min(charge.amount_refunded,charge.amount) / charge.amount);
  const prior = Number((await client.query("SELECT COALESCE(sum(amount_ore),0) AS amount FROM billing_ledger WHERE organization_id=$1 AND kind='refund' AND reference LIKE $2", [checkout.organization_id,`refund:${charge.id}:%`])).rows[0].amount);
  const amount = Math.max(0, desired+prior);
  if (!amount) return;
  await client.query("INSERT INTO billing_ledger(organization_id,amount_ore,kind,reference,description) VALUES($1,$2,'refund',$3,'Cloud purchase refunded')", [checkout.organization_id,-amount,`refund:${charge.id}:${desired}`]);
  await client.query("UPDATE billing_accounts SET balance_ore=balance_ore-$1 WHERE organization_id=$2", [amount,checkout.organization_id]);
}

export async function syncSubscription(client: Pick<PoolClient, "query">, id: string, provider: Stripe) {
  // Lock before retrieving current Stripe state: out-of-order webhooks cannot regress it.
  const account = (await client.query("SELECT organization_id,currency,host_limit FROM billing_accounts WHERE stripe_subscription_id=$1 FOR UPDATE", [id])).rows[0];
  if (!account) return;
  const sub = await provider.subscriptions.retrieve(id, { expand: ["latest_invoice"] });
  const invoice = typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
  const item = sub.items.data[0];
  const price = item?.price;
  const extras = ((price?.unit_amount ?? 0) - HYBRID_MONTHLY_ORE) / HYBRID_EXTRA_HOST_CENTS;
  const validUsdPlan = sub.items.data.length === 1 && item?.quantity === 1 && price?.currency === "usd" && price.recurring?.interval === "month" && price.recurring.interval_count === 1 && Number.isInteger(extras) && extras >= 0 && extras <= 100;
  const validLegacyPlan = account.currency === "sek" && sub.items.data.length === 1 && item?.quantity === 1 && price?.currency === "sek" && price.unit_amount === 99_000 && price.recurring?.interval === "month" && price.recurring.interval_count === 1;
  const validPlan = account.currency === "usd" ? validUsdPlan : validLegacyPlan;
  const hostLimit = validUsdPlan ? 2+extras : 2;
  const paid = sub.status === "active" && invoice?.status === "paid" && !sub.pause_collection && validPlan && !sub.pending_update;
  await client.query(`UPDATE billing_accounts SET subscription_status=$1,host_limit=CASE WHEN $2::boolean THEN $5 ELSE host_limit END,
    paid_until=CASE WHEN $2::boolean THEN to_timestamp($3) WHEN $1 IN ('canceled','unpaid','paused','incomplete_expired') THEN now() ELSE paid_until END
    WHERE stripe_subscription_id=$4`, [sub.status, Boolean(paid), item?.current_period_end ?? 0, id, hostLimit]);
}

export async function stripeWebhook(c: Context<AppEnv>) {
  if (config.selfHosted) return c.json({ error: "Billing is disabled" }, 404);
  const provider = payments();
  let event: Stripe.Event;
  try { event = provider.webhooks.constructEvent(await c.req.text(), c.req.header("stripe-signature") || "", webhookSecret); }
  catch { return c.json({ error: "Invalid Stripe signature" }, 400); }
  if (event.livemode !== stripeLiveMode) return c.json({ error: "Stripe event mode mismatch" }, 400);
  await assertPaymentMode();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const accepted = await client.query("INSERT INTO billing_stripe_events(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id", [event.id]);
    if (accepted.rowCount) {
      if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
        const session = event.data.object;
        await fulfillCheckout(client, session);
        const id = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        if (id) await syncSubscription(client, id, provider);
      } else if (event.type === "charge.refunded") {
        await applyRefund(client, event.data.object);
      } else if (event.type.startsWith("customer.subscription.")) {
        await syncSubscription(client, (event.data.object as Stripe.Subscription).id, provider);
      } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
        const sub = event.data.object.parent?.subscription_details?.subscription;
        if (sub) await syncSubscription(client, typeof sub === "string" ? sub : sub.id, provider);
      }
    }
    await client.query("COMMIT");
    return c.json({ received: true });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function reconcileCheckouts(provider = stripe) {
  if (config.selfHosted) return;
  if (!provider || !webhookSecret) return;
  await assertPaymentMode();
  const pending = await db.query(`SELECT id,stripe_session_id FROM billing_checkouts
    WHERE completed_at IS NULL AND abandoned_at IS NULL AND stripe_session_id IS NOT NULL
    AND (reconciled_at IS NULL OR reconciled_at < now()-interval '5 minutes')
    ORDER BY reconciled_at NULLS FIRST,id LIMIT 20`);
  for (const checkout of pending.rows) {
    // Rotate failures too, so one broken purchase cannot starve later ones.
    await db.query("UPDATE billing_checkouts SET reconciled_at=now() WHERE id=$1", [checkout.id]);
    try {
      const session = await provider.checkout.sessions.retrieve(checkout.stripe_session_id);
      if (session.livemode !== stripeLiveMode) throw new Error("Checkout Stripe mode mismatch");
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        if (session.status === "complete") await fulfillCheckout(client, session);
        if (session.status === "expired") await client.query("UPDATE billing_checkouts SET abandoned_at=now() WHERE id=$1 AND completed_at IS NULL", [checkout.id]);
        const subscription = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        if (subscription) await syncSubscription(client, subscription, provider);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    } catch (error) {
      console.error(JSON.stringify({ event: "billing_checkout_reconciliation_failed", checkout_id: checkout.id, message: error instanceof Error ? error.message : String(error) }));
    }
  }
}

export async function reconcileBilling() {
  if (config.selfHosted) return;
  const organizations = await db.query("SELECT organization_id FROM billing_accounts WHERE NOT complimentary ORDER BY organization_id");
  for (const { organization_id: org } of organizations.rows) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // Take sandbox locks first, consistently with lifecycle/report transactions.
      const environments = await client.query(`SELECT id,runtime_id FROM sandboxes WHERE organization_id=$1 AND state<>'deleted' ORDER BY id FOR UPDATE`, [org]);
      await client.query("SELECT billing_settle($1)", [org]);
      const account = (await client.query(`SELECT b.*,o.hosting_mode,COALESCE((SELECT sum(reserved_hour_ore+storage_hour_ore)/60 FROM billing_resources WHERE organization_id=$1),0) AS reserve FROM billing_accounts b JOIN organizations o ON o.id=b.organization_id WHERE b.organization_id=$1`, [org])).rows[0];
      if (!account.complimentary && account.hosting_mode === "managed" && Number(account.balance_ore)<=Math.max(1,Number(account.reserve))) {
        for (const env of environments.rows) {
          // In-flight setup is left to finish; the next pass stops it. Never erase data.
          const active = await client.query("SELECT 1 FROM compute_jobs WHERE sandbox_id=$1 AND status IN ('queued','leased')", [env.id]);
          if (active.rowCount) continue;
          if (!env.runtime_id) continue;
          const changed = await client.query("UPDATE sandboxes SET desired_state='stopped',state='provisioning',provisioning_step='allocating',updated_at=now() WHERE id=$1 AND state NOT IN ('stopped','deleted') RETURNING id", [env.id]);
          if (changed.rowCount) await client.query("INSERT INTO compute_jobs(id,sandbox_id,operation,status,provisioning_step) VALUES($1,$2,'stop','queued','allocating')", [`job_${crypto.randomUUID()}`, env.id]);
        }
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
