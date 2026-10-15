# Billing

Billing belongs to an organization. Existing organizations at migration 0026 receive explicit complimentary pilot access. New organizations use Cloud prepaid usage or the Hybrid subscription. No existing customer is silently charged or suspended.

## Offer

Prices match [the public pricing page](https://driftverk.com/pricing), verified 2026-09-05. All new purchases use USD, excluding tax.

- Cloud: a fixed one-time $5 welcome credit for the first eligible Cloud organization created by a verified account. No exchange-rate lookup is needed and no payment card is required. Migration 0038 reduces future grants from $30 to $5; existing balances, claims and complimentary pilot access are preserved.
- The first admin membership grants the credit transactionally. Unique user and normalized-email claims survive organization deletion. Hosting changes, invitations and extra organizations do not issue another grant. This prevents simple retries, not multiple identities using different email addresses.
- Hybrid: $199 per organization per month includes two hosts. Additional hosts cost $49 each per month. Checkout selects the total host count; later increases invoice the prorated difference immediately and grant capacity only after Stripe confirms payment. Capacity reductions require support and removing surplus connected hosts. A renewed plan cannot select fewer slots than the current connected-host count.
- Guided Hybrid pilot: $299 once for 30 days and two hosts. There is no automatic renewal. The scope must first be agreed with Driftverk; an operator then sets that organization's `pilot_approved_at` to unlock Checkout. Paid fulfillment sets `pilot_ends_at` once. Monthly continuation requires a separate explicit purchase. Activating the monthly subscription during the pilot starts billing immediately.
- Existing trial dates are honored for compatibility. New starts stop when paid access ends; new connections have a three-day grace period. Billing does not stop customer-owned hosts or delete their data.
- Cloud top-ups: $20, $50 or $100. No automatic top-ups; purchased balance and welcome credit have no scheduled expiry.
- Cloud rates: $0.05/vCPU-hour, $0.016/GiB RAM-hour and $0.0001/GiB-hour of storage, billed per second. The first 5 GiB of total organization storage are included, shared across disks, snapshots and local volumes. Reservations conservatively use the full storage rate; only usage charges receive the allowance.

Migration 0027 preserves existing SEK account balances, rates, ledger entries and checkout currency. Existing SEK subscriptions can renew at their existing 990 SEK price. New accounts use USD. Legacy SEK accounts require an explicit, audited migration before new purchases; no historical amounts are relabeled as dollars. The existing `*_ore` field names remain API-compatible minor-unit fields: interpret them using account/checkout `currency` (USD cents or SEK öre).

The frontend keeps the existing English language. Billing and environment creation show current rates and the organization balance.

## Metering and admission

Migration 0026 installs account, ledger and resource tables plus database guards. Guarding job insertion and lease transitions covers panel, API, MCP, prebuilds and wake-on-access. Charges use numeric fractions of a currency minor unit and database time. Account row locks serialize balance checks, reservations, settlement and payments across app instances.

Queued image downloads are free. Updated Compute agents report runtime IDs immediately after Docker starts; setup and initialization are then billed. Runtime evidence expires after 90 seconds without a running-container sample or job heartbeat; compute billing pauses after that point. CPU/RAM also stop billing on acknowledged stop or deletion, including prebuild cleanup. Failed setup can leave compute running and therefore billable. The selected disk allocation is billed while the runtime exists, including while stopped. Snapshot sizes are reported by the agent. Local volume sizes are sampled every minute, including detached volumes still owned by a host. Customer-owned S3 volumes in Hybrid are not billed by Driftverk.

Creation/provisioning reserves 35 minutes of its resource rate, covering setup/initialization/readiness. Ready environments reserve one minute. The balance must cover all reservations in the organization; reservations are not charges. Reconciliation settles every minute and queues Cloud stops when the remaining balance cannot cover reservations. In-flight provisioning finishes before the stop is queued. A rejected lease is marked failed so it cannot starve other organizations in the shared queue. Stop/delete jobs remain available at zero balance.

Usage debits never push balance below zero. No more storage usage is debited at an empty balance. Data is retained for **at least seven days**; this change does not add an automatic data-deletion worker. Removal beyond that window is an operator task with customer notice, including freeing retained volumes/snapshots. Refund reversals can make an already-spent balance negative; further compute remains blocked until funded.

This is not an absolute infrastructure spend cap during control-plane/agent outages. A disconnected host cannot acknowledge a stop, and host disk quotas remain outside this change. Validate real Cloud-host stop behavior, storage measurement and quotas before public self-service compute. Existing agents must be updated for accurate billing during setup and for volume size reporting. Deploy control plane first, then the agent before admitting billed Cloud work.

## Stripe setup

Migration 0032 binds the billing database to one Stripe mode, inferred from existing Checkout session IDs or bound on the first payment operation for a fresh database. Signed events and retrieved Checkout sessions must match the configured key's mode. A key change cannot reuse a database bound to the other mode. Use a separate database for sandbox testing. Existing test credits and customer IDs need an audited reconciliation before any live transition; changing the mode row alone is not a migration of those records.

An independent worker checks up to 20 unfinished Checkout sessions every minute, retrying each at most once per five minutes. It uses the same transactional fulfillment as webhooks, so recovery and webhook retries cannot grant duplicate credit. Expired sessions are marked abandoned. Failures emit `billing_checkout_reconciliation_failed` with a purchase ID; route this and `billing_reconciliation_failed` to operator alerts. Purchases without a persisted Stripe session ID still require investigation. This worker does not reconcile later subscription renewals or dispute/refund state.

Top-up fulfillment settles usage before adding credit. This advances storage metering while an empty balance still applies and prevents retroactive charges for the unpaid retention interval.

The seven-day billing retention promise does not extend an explicitly configured environment automatic-deletion timer. Customers must remove that timer if they want to retain the environment longer.

Before public billing, verify tax results, failed payments, renewals, refunds and disputes, and configure delivery-failure alerts. Optional automatic top-ups remain unimplemented.

## Balance email alerts

Verified organization admins receive one email below $5 and another when the USD Cloud balance reaches zero. Complimentary, Hybrid, legacy SEK, and never-funded accounts are excluded. Each message names the organization and links to Billing. Recovering to at least $5 rearms the low-balance alert; a positive balance rearms the empty-balance alert. Jumping directly to zero sends only the empty-balance message.

Migration 0034 adds persistent per-recipient notifications. A separate minute worker uses a database advisory lock to prevent concurrent senders. It checks current admin membership and verified email before delivery, skips notifications invalidated by funding, and retries failures after five minutes with the same stored content and Resend idempotency key. Successful sends are recorded. Resend deduplicates requests for 24 hours; a process crash after sending but before recording success can cause a duplicate if recovery occurs after that window. Monitor `billing_email_failed` and `billing_email_worker_failed`. Mail delivery failures do not block billing settlement or compute stops.

1. Configure `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in the control-plane environment. Use matching test credentials locally and matching live credentials for production. No keys are committed. Without both keys, the payment buttons explain that payments are unavailable; welcome credits and access limits still work.
2. Configure Stripe Tax registrations/default product tax treatment and enable Customer Portal payment methods, invoices and cancellation. Checkout collects billing address and tax ID, uses automatic tax, and lists prices exclusive of tax. Verify actual tax results in the target Stripe account.
3. Register `POST /api/stripe/webhook`. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, and `charge.refunded`.
4. Run a Stripe test-mode top-up and Hybrid purchase end to end, then test failed payment, renewal, cancellation, refund and webhook retry. A local signed webhook fixture is not proof of a working Stripe account or live payment.

Hybrid and pilot Checkout use cards. Pending Hybrid purchases block another checkout and hosting-mode switches until confirmed or Stripe reports the old session expired. Pilot approval is an operator action after agreeing scope; it grants no access by itself. Full or partial pilot/subscription refunds require an operator access review; automatic refund reversal currently applies to Cloud purchases only.

Checkout uses server-selected amounts and a durable purchase ID as the Stripe idempotency key. Returning to the success URL grants nothing. Verified webhooks check customer, currency, amount, purchase type and session ID. The session ID is also the unique ledger reference, so different/retried events cannot double-credit. Subscriptions are fetched from Stripe under the account lock instead of trusting delivery order. Partial refunds reverse the net prepaid amount proportionately, separately from tax; early refund events retry until the purchase has been fulfilled.

## Validation

`npm run control:check`, `npm run control:build`, `npm run control:test` and `npm run compute:test`.

Set `CONTROL_PLANE_TEST_DATABASE_URL` to an isolated local PostgreSQL database to run the billing integration test. It creates a random schema, applies all migrations over a populated legacy organization, and removes only its own schema afterward. It exercises eligibility, hosting switches, numeric metering, simultaneous reservations, zero-balance cleanup, pilot gates, shared storage allowance, exchange-rate conversion, legacy SEK renewals, unpaid capacity changes, signed webhooks, mismatched customers, duplicate events, refunds and automatic stop queuing.

## Internal session API

Platform admins can grant finite Cloud credits from Admin > Organizations > Cloud billing. Enter an amount and reason, then confirm the customer. Grants do not collect payment, create Stripe objects, or enable unlimited complimentary access. They settle existing usage first and record the amount, reason and granting user in the billing ledger. Retrying the same request ID cannot fund twice. Customers see the reason in billing activity. Existing unlimited complimentary organizations do not need credit grants.

- `POST /api/admin/organizations/:id/credits`: `{amount_ore:5000,currency:"usd",reason:"Pilot program",request_id:"<UUID>"}`. Platform admin and trusted origin required. Positive integer minor units up to 1,000,000 per grant, account currency, and a nonblank reason of at most 300 characters. Only metered Cloud organizations are eligible.

- `GET /api/billing`: account currency, rates, balance, available shared storage allowance, paid/pilot dates, purchased host limit and recent transactions.
- `POST /api/billing/checkout`: `{kind:"topup",amount_ore:2000|5000|10000}`, `{kind:"hybrid",extra_hosts:0..100}` or `{kind:"pilot"}`. Admin only; server selects prices.
- `POST /api/billing/hosts`: `{extra_hosts:1..100}` increases the total number of additional slots on an active plan. Payment-contingent proration; returns the hosted invoice URL when payment needs action.
- `POST /api/billing/portal`: payment methods, invoices and cancellation.
- `POST /api/stripe/webhook`: signed, unauthenticated Stripe event endpoint.

Platform admins can toggle Free pilot access in Admin > Organizations > Complimentary access for Cloud or Hybrid. Enabling requires no active Stripe subscription or unresolved checkout. Disabling resumes normal billing requirements immediately, without billing usage from the complimentary period.
