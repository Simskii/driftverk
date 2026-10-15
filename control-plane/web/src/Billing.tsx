import { LoadError } from "./LoadError";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "./api";
import { ArrowUpRight, CaretDown, ClockCounterClockwise, FileText } from "@phosphor-icons/react";
import "./billing.css";

export type Billing = {
  installation_mode?: "hosted" | "self-hosted";
  daily_usage: { day: string; amount_ore: string }[];
  resources: { id: string; name: string; resource_type: string; environment_name: string | null; compute_hour_ore: string; storage_hour_ore: string }[];
  currency: "usd" | "sek"; host_limit: number; pilot_approved_at: string | null; pilot_ends_at: string | null; hybrid_pilot_cents: number; hybrid_extra_host_cents: number; free_storage_gib: string;
  hosting_mode: "managed" | "hybrid"; complimentary: boolean; balance_ore: string;
  subscription_status: string; paid_until: string | null; trial_ends_at: string | null;
  exhausted_at: string | null; hourly_ore: string; reserved_ore: string;
  cpu_hour_ore: string; ram_gb_hour_ore: string; storage_gb_hour_ore: string;
  role: string; payments_available: boolean; has_customer: boolean; hybrid_monthly_ore: number; topup_amounts: number[];
  transactions: { id: string; amount_ore: string; description: string; created_at: string }[];
};
const money = (minor: string | number, digits = 2, currency = "usd") => (Number(minor)/100).toLocaleString("en-US", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
const date = (value: string) => new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function BillingPage() {
  const [data, setData] = useState<Billing | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [extraHosts, setExtraHosts] = useState(0);
  const [busy, setBusy] = useState(false);
  const [topup, setTopup] = useState<number | null>(null);
  const [params] = useSearchParams();
  useEffect(() => {
    let mounted = true;
    const refresh = () => api<Billing>("/api/billing").then(value => { if (mounted) { setData(value); setError(""); } }).catch(error => { if (mounted) setError(error.message); });
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [retry]);
  async function purchase(kind: "hybrid" | "pilot" | "hosts" | "topup" | "portal", amount?: number) {
    setBusy(true); setError("");
    try {
      const { url } = await api<{ url: string }>(`/api/billing/${kind === "portal" ? "portal" : kind === "hosts" ? "hosts" : "checkout"}`, { method: "POST", body: JSON.stringify({ kind, amount_ore: amount, extra_hosts: extraHosts }) });
      window.location.assign(url);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not open payment page"); setBusy(false); }
  }
  if (data?.installation_mode === "self-hosted") return <div className="page"><h1>Billing</h1><p>Billing is disabled for this installation.</p></div>;
  const validHosts = Number.isInteger(extraHosts) && extraHosts>=0 && extraHosts<=100;
  const hybrid = data?.hosting_mode === "hybrid";
  const admin = data?.role === "admin";
  const paid = Boolean(data?.paid_until && new Date(data.paid_until).getTime()>Date.now());
  const pilot = Boolean(data?.pilot_ends_at && new Date(data.pilot_ends_at).getTime()>Date.now());
  return <div className="page billing-page">
    <header className="page-header billing-header"><h1>Billing</h1><div className="billing-header-actions">
      {admin && data?.has_customer && <button className="billing-text-button" disabled={busy || !data.payments_available} onClick={() => void purchase("portal")}>Payment details <ArrowUpRight aria-hidden="true" size={16} /></button>}
      {data && !(hybrid && data.complimentary) && <span className="muted">{data.currency.toUpperCase()}, excl. tax</span>}
    </div></header>
    {error && (!data ? <LoadError message={error} onRetry={() => { setError(""); setRetry(value => value + 1); }} /> : <div className="form-alert form-alert-error" role="alert">{error}</div>)}
    {params.get("checkout") === "success" && <p className="form-alert" role="status">Checkout complete. Payment confirmation may take a few minutes.</p>}
    {!data ? (!error && <p role="status">Loading billing…</p>) : <>
      {!hybrid ? <>
        <div className="billing-overview">
          <CloudUsage data={data} />
          <aside className="billing-funding" aria-label="Organization balance">
            <div><h2>{data.complimentary ? "Complimentary access" : "Available balance"}</h2>
              {data.complimentary ? <p>No charges apply.</p> : <p className="billing-balance">{money(data.balance_ore,2,data.currency)}</p>}
              {!data.complimentary && Number(data.balance_ore)<500 && <p className="billing-balance-warning" role="status">{Number(data.balance_ore)<=Math.max(Number(data.reserved_ore),1) ? "Balance too low. Add funds to start or keep running." : "Balance running low."}</p>}
            </div>
            {!data.complimentary && <>
              <div><h3>Current usage</h3><p className="billing-current-rate"><strong>{money(data.hourly_ore,4,data.currency)}</strong><span> / hour</span></p></div>
              <div className="billing-topup">
                {admin ? <><label htmlFor="billing-topup-amount">Add funds</label>
                  <select id="billing-topup-amount" value={topup !== null && data.topup_amounts.includes(topup) ? topup : data.topup_amounts[0] ?? ""} disabled={busy || !data.payments_available || data.currency!=="usd" || !data.topup_amounts.length} onChange={event=>setTopup(Number(event.target.value))}>
                    {data.topup_amounts.map(amount=><option key={amount} value={amount}>{money(amount,0,"usd")}</option>)}
                  </select>
                  <button className="button button-primary" disabled={busy || !data.payments_available || data.currency!=="usd" || !data.topup_amounts.length} onClick={()=>void purchase("topup",topup !== null && data.topup_amounts.includes(topup) ? topup : data.topup_amounts[0])}>{busy ? "Opening checkout…" : "Add funds"}</button>
                </> : <p className="muted">An admin can add funds.</p>}
                <p className="muted">No automatic top-ups.</p>
                {data.currency!=="usd" && <p className="form-alert">Your SEK balance is preserved. Contact support before making a new purchase.</p>}
                {!data.payments_available && <p className="form-alert">Payments unavailable. Contact support to add funds.</p>}
              </div>
            </>}
          </aside>
        </div>
        <BillingActivity data={data} />
        <BillingDetails data={data} />
      </> : data.complimentary ? <section className="data-panel billing-card"><h2>Complimentary Hybrid access</h2><p>Compute and storage stay on your infrastructure. Driftverk does not charge this organization automatically.</p></section> : <>
        <section className="data-panel billing-card"><span className="eyebrow">Hybrid plan</span>
          <h2 className="billing-amount">{money(data.hybrid_monthly_ore,0)} / month</h2>
            <p>Two connected hosts included. Additional hosts cost {money(data.hybrid_extra_host_cents,0)} / month each. Compute and storage stay on your infrastructure.</p>
            <p>{paid ? `Subscription paid through ${date(data.paid_until!)}. ${data.host_limit} host slots.` : pilot ? `Your paid pilot ends ${date(data.pilot_ends_at!)}. Two hosts included. It will not renew automatically.` : "Connect and test your host, then activate Hybrid to run your environments."}</p>
            <Link className="button button-secondary" to="/hosts">Connect and test your host</Link>
            {admin && <>
              <label>Additional hosts <input aria-label="Additional hosts" type="number" step={1} min={0} max={100} value={extraHosts} onChange={event => setExtraHosts(Number(event.target.value))} /></label>
              {["none","canceled","incomplete_expired"].includes(data.subscription_status) ? <>
                <button className="button button-primary" disabled={busy || !data.payments_available || !validHosts} onClick={() => void purchase("hybrid")}>Activate Hybrid · {money(data.hybrid_monthly_ore+extraHosts*data.hybrid_extra_host_cents,0)}/month</button>
                <p className="subtle">Payment and the monthly subscription start immediately. During a pilot, you can wait until it ends.</p>
              </> : <>
                <button className="button button-primary" disabled={busy || !data.payments_available || !validHosts || extraHosts+2<=data.host_limit} onClick={() => void purchase("hosts")}>Increase to {2+extraHosts} hosts · {money(data.hybrid_monthly_ore+extraHosts*data.hybrid_extra_host_cents,0)}/month</button>
                <p className="subtle">Stripe charges the difference for the remaining month. New slots become available after payment. Contact support to reduce your host limit.</p>
              </>}
              {!data.pilot_ends_at && data.subscription_status==="none" && <div>
                <h3>Guided Hybrid pilot · {money(data.hybrid_pilot_cents,0)} for 30 days</h3>
                <p>Two hosts, guided setup and a final review. No automatic renewal.</p>
                {data.pilot_approved_at ? <button className="button button-secondary" disabled={busy || !data.payments_available} onClick={() => void purchase("pilot")}>Pay for agreed pilot · {money(data.hybrid_pilot_cents,0)}</button> : <a className="button button-secondary" href="https://driftverk.com/pricing#pilot" target="_blank" rel="noreferrer">Agree pilot scope with Driftverk</a>}
              </div>}
            </>}
          {data.currency!=="usd" && <p className="form-alert">Your legacy SEK balance is preserved. Contact support to migrate before making a new purchase.</p>}
          {!admin && <p className="subtle">An organization admin can manage payments.</p>}
          {!data.payments_available && <p className="form-alert">Payments are not available yet. Contact support to activate or add funds.</p>}
        </section>
      </>}
      {hybrid && <BillingActivity data={data} />}
    </>}
  </div>;
}

export function CloudEstimate({ cpu, memoryMb, diskGb = 40, compact = false }: { cpu: number; memoryMb: number; diskGb?: number; compact?: boolean }) {
  const [billing, setBilling] = useState<Billing | null>(null);
  useEffect(() => { let active=true; void api<Billing>("/api/billing").then(data=>{if(active)setBilling(data);}).catch(()=>{}); return ()=>{active=false;}; },[]);
  if (!billing || billing.hosting_mode!=="managed" || billing.complimentary) return null;
  const compute = cpu*Number(billing.cpu_hour_ore)+memoryMb/1024*Number(billing.ram_gb_hour_ore);
  const free = billing.currency==="usd" ? Number(billing.free_storage_gib) : 0;
  const disk = Math.max(0,diskGb-free)*Number(billing.storage_gb_hour_ore);
  if (compact) return <details className="compact-cloud-estimate"><summary><span>Estimated while running</span><strong>{money(compute + disk, 4, billing.currency)}/hour</strong></summary><p>Includes {diskGb} GiB allocated disk and the remaining shared storage allowance. Stopped storage: {money(disk, 4, billing.currency)}/hour. <Link to="/billing">View billing</Link></p></details>;
  return <p className="form-alert">Cloud: {money(compute+disk,4,billing.currency)} / hour while running, including {diskGb} GiB allocated disk and the remaining shared storage allowance. When stopped: {money(disk,4,billing.currency)} / hour for disk. Balance: {money(billing.balance_ore,2,billing.currency)}. <Link to="/billing">View billing</Link></p>;
}


export function CloudUsage({ data, environmentId }: { data: Billing; environmentId?: string }) {
  const resources = environmentId ? data.resources.filter(resource => resource.id === environmentId) : data.resources;
  const compute = resources.reduce((sum, resource) => sum + Number(resource.compute_hour_ore), 0);
  const storage = resources.reduce((sum, resource) => sum + Number(resource.storage_hour_ore), 0);
  const total = data.daily_usage.reduce((sum, day) => sum + Number(day.amount_ore), 0);
  const peak = Math.max(1, ...data.daily_usage.map(day => Number(day.amount_ore)));
  if (environmentId) return <section className="environment-billing">
    <div className="billing-section-heading"><h2>Current rate</h2><Link className="billing-inline-link" to="/billing">Organization billing <ArrowUpRight size={16} aria-hidden="true" /></Link></div>
    {data.complimentary ? <p className="billing-empty">Complimentary access. No charges apply.</p> : <>
      <div className="environment-billing-overview">
        <div className="environment-billing-total"><p className="billing-spend">{money(compute+storage,4,data.currency)}<span> / hour</span></p><p className="muted">Before shared storage allowance</p></div>
        <dl className="environment-billing-rates"><div><dt>Compute</dt><dd>{money(compute,4,data.currency)}<span> / hour</span></dd></div><div><dt>Storage</dt><dd>{money(storage,4,data.currency)}<span> / hour</span></dd></div></dl>
      </div>
      {!resources.length && <p className="muted">No metered resources yet.</p>}
    </>}
    <details className="billing-disclosure"><summary><FileText size={20} aria-hidden="true" /><span>Billing details</span><CaretDown className="billing-chevron" size={16} aria-hidden="true" /></summary><div className="billing-disclosure-body billing-explanation">
      <p>Compute reflects the latest running heartbeat. Storage is charged while stopped; all usage charges pause at an empty balance.</p>
      {data.currency==="usd" && <p>The first 5 GiB of organization storage are included. That shared allowance is applied to your organization total, not this resource rate.</p>}
      <p>Rates use allocated resources. Snapshots and volumes are billed separately. Charge history is available at organization level.</p>
    </div></details>
  </section>;
  return <section className="billing-usage" aria-label="Cloud usage">
      <div className="billing-section-heading"><h2>Usage</h2><span className="muted">Last 30 days</span></div>
      <p className="billing-spend">{money(total, 2, data.currency)}</p><p className="muted billing-spend-label">Total spend</p>
      {!data.daily_usage.length ? <p className="billing-empty">No usage charges yet.</p> : <>
      <div className="billing-chart-frame">
      <div className="billing-chart-scale" aria-hidden="true"><span>{money(peak,2,data.currency)}</span><span>{money(peak/2,2,data.currency)}</span><span>{money(0,2,data.currency)}</span></div>
      <div className="billing-chart" role="img" aria-label={`Daily Cloud charges over the last 30 days, total ${money(total, 2, data.currency)}. Daily values are available under Activity.`}>
        {data.daily_usage.map(day => <div key={day.day} title={`${day.day}: ${money(day.amount_ore, 4, data.currency)}`}><i style={{ height: `${Number(day.amount_ore) / peak * 100}%` }} /></div>)}
      </div>
      </div>
      <div className="billing-chart-labels"><span>{new Date(data.daily_usage[0]!.day).toLocaleDateString("en-US",{month:"short",day:"numeric",timeZone:"UTC"})}</span><span>Today</span></div>
      </>}
    <details className="billing-disclosure billing-resource-details"><summary><span>Resource breakdown</span><span className="billing-summary-hint">Current hourly rates</span><CaretDown className="billing-chevron" size={16} aria-hidden="true" /></summary><div className="billing-disclosure-body">
    {!resources.length ? <p>No metered resources yet.</p> : <div className="billing-table-wrap"><table className="billing-table"><thead><tr><th>Resource</th><th>Compute / hour</th><th>Storage / hour</th><th>Total / hour</th></tr></thead><tbody>{resources.map(resource => <tr key={resource.id}><td>{resource.environment_name ? <Link to={`/environments/${encodeURIComponent(resource.id)}?tab=billing`}>{resource.environment_name}</Link> : resource.name}<span className="subtle"> · {resource.resource_type}</span></td><td>{money(resource.compute_hour_ore,4,data.currency)}</td><td>{money(resource.storage_hour_ore,4,data.currency)}</td><td>{money(Number(resource.compute_hour_ore)+Number(resource.storage_hour_ore),4,data.currency)}</td></tr>)}</tbody></table></div>}
    <p className="subtle">Resource rates are before the shared storage allowance. Your organization total is {money(data.hourly_ore,4,data.currency)}/hour.</p>
    </div></details>
  </section>;
}

function BillingActivity({ data }: { data: Billing }) {
  return <details className="billing-disclosure"><summary><ClockCounterClockwise size={22} aria-hidden="true" /><span>Activity</span><span className="billing-summary-hint">{data.hosting_mode === "hybrid" ? "Billing history" : "Usage and balance top-ups"}</span><CaretDown className="billing-chevron" size={16} aria-hidden="true" /></summary><div className="billing-disclosure-body">
    {!data.transactions.length ? <p>No balance transactions yet.</p> : <div className="billing-table-wrap"><table className="billing-table"><thead><tr><th>Date</th><th>Description</th><th>Amount</th></tr></thead><tbody>{data.transactions.map(tx=><tr key={tx.id}><td>{date(tx.created_at)}</td><td>{tx.description}</td><td>{Number(tx.amount_ore)>0 ? "+" : ""}{money(tx.amount_ore,4,data.currency)}</td></tr>)}</tbody></table></div>}
    {data.hosting_mode==="managed" && data.daily_usage.length>0 && <details className="billing-daily-details"><summary>Daily charges</summary><p className="subtle">By settlement date in UTC. Today's total is still accumulating.</p><div className="billing-table-wrap"><table className="billing-table"><thead><tr><th>Date, UTC</th><th>Charged</th></tr></thead><tbody>{data.daily_usage.map(day=><tr key={day.day}><td>{day.day}</td><td>{money(day.amount_ore,4,data.currency)}</td></tr>)}</tbody></table></div></details>}
  </div></details>;
}

function BillingDetails({ data }: { data: Billing }) {
  return <details className="billing-disclosure"><summary><FileText size={22} aria-hidden="true" /><span>Rates &amp; billing details</span><span className="billing-summary-hint">Pricing and billing information</span><CaretDown className="billing-chevron" size={16} aria-hidden="true" /></summary><div className="billing-disclosure-body billing-details-grid">
    <dl className="billing-rates"><div><dt>vCPU / hour</dt><dd>{money(data.cpu_hour_ore,2,data.currency)}</dd></div><div><dt>RAM / GiB-hour</dt><dd>{money(data.ram_gb_hour_ore,3,data.currency)}</dd></div><div><dt>Storage / GiB-hour</dt><dd>{money(data.storage_gb_hour_ore,4,data.currency)}</dd></div><div><dt>Reserved for active starts</dt><dd>{money(data.reserved_ore,4,data.currency)}</dd></div></dl>
    <div className="billing-explanation"><p>Billed per second on allocated resources. Compute starts with the container, including setup. Queue time and image downloads before start are free.</p>
      <p>{data.currency==="usd" && "The first 5 GiB of organization storage are included. "}Stopped environments still use storage. Snapshots and volumes count toward storage usage.</p>
      <p>At an empty balance, compute stops and storage charges pause. Data is retained for at least seven days unless you set an automatic deletion timer.</p>
      <p>Purchased balance does not expire. The first eligible Cloud organization receives $5 once. AI provider charges are separate.</p>
    </div>
  </div></details>;
}
