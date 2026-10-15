import { useInstallation } from "./Installation";
import { useEffect, useState } from "react";
import "./hosts.css";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { CaretDown, Check, Copy, Cpu, HardDrives, Plus, Trash } from "@phosphor-icons/react";
import { api } from "./api";
import { LoadError } from "./LoadError";

export type Host = { id: string; name: string; last_seen_at: string | null; version: string | null; storage_driver: string | null; environment_count: number; cpu_count?: number | null; memory_mb?: number | null; health_checked_at?: string | null; health?: { status: string; checks: { service: string; status: string; message?: string }[] } | null };
export type HostsData = { hosting_mode: "managed" | "hybrid"; role: string; hosts: Host[]; install_command: string; latest_agent_version?: string };
export function hostConnected(host: Pick<Host, "last_seen_at">) { return Boolean(host.last_seen_at && Date.now() - new Date(host.last_seen_at).getTime() < 60_000); }
function hostHealthFresh(host: Host) { return hostConnected(host) && Boolean(host.health_checked_at && Date.now() - Date.parse(host.health_checked_at) < 60_000); }
function hostHealthy(host: Host) { return hostHealthFresh(host) && host.health?.status === "healthy"; }
function formatMemory(memoryMb?: number | null) { return memoryMb ? `${Math.round(memoryMb / 1024)} GB` : "Unknown"; }

export function HostHealth({ host, latestVersion, compact = false, onDisconnect, disconnectDisabled = false }: { host: Host; latestVersion?: string; compact?: boolean; onDisconnect?: () => void; disconnectDisabled?: boolean }) {
  const fresh = hostHealthFresh(host);
  const healthyChecks = host.health?.checks.filter(check => check.status === "healthy").length || 0;
  const totalChecks = host.health?.checks.length || 0;
  const state = !fresh ? "Health details unavailable" : host.health?.status === "healthy" ? `${healthyChecks} services healthy` : "Services need attention";
  return <details className={`host-health${compact ? " host-health-compact" : ""}`}><summary><span>{compact ? state : `${host.name}: ${state}`}</span><CaretDown /></summary>
    <div className="host-health-body">{!fresh ? <p>No recent health report. Check the host connection and agent version.</p> : <>
      {host.health?.status !== 'healthy' && <p role="status">New starts and snapshots are paused until services recover. You can still stop or delete environments if Docker is available.</p>}
      <ul>{host.health?.checks.map((check, index) => <li key={`${check.service}-${index}`}><strong>{check.service}</strong>: {check.status}{check.message ? `. ${check.message}` : ''}</li>)}</ul>
    </>}
    {host.health_checked_at && <p>Last checked: {new Date(host.health_checked_at).toLocaleString()}</p>}
    <p>Agent version: {host.version || 'Unknown'}{latestVersion && host.version !== latestVersion ? `. Available version: ${latestVersion}` : ''}</p>
    {latestVersion && host.version !== latestVersion && <p>Run on this server: <code>sudo driftverk-agent update</code></p>}
    <p className="subtle">Host checks cover shared services on the server.</p>
    {totalChecks > 0 && <p className="host-health-count">{healthyChecks} of {totalChecks} checks passing</p>}
    {compact && <div className="host-health-meta"><code>{host.id}</code>{onDisconnect && <button className="host-remove" disabled={disconnectDisabled} onClick={onDisconnect}><Trash />Disconnect host</button>}</div>}</div>
  </details>;
}

export function HostingChoice({ value, onChange }: { value: "managed" | "hybrid"; onChange: (mode: "managed" | "hybrid") => void }) {
  const selfHosted = useInstallation().installationMode === "self-hosted";
  if (selfHosted) return <p>Environments run on your compute hosts.</p>;
  return <fieldset className="hosting-choice"><legend>Where should your environments run?</legend>
    <label className={value === "managed" ? "selected" : ""}><input type="radio" name="hosting" value="managed" checked={value === "managed"} onChange={() => onChange("managed")} /><span><strong>Driftverk Cloud</strong><small>We provide the compute. Your first eligible Cloud organization gets $5 in credits to try it. No card required.</small></span></label>
    <label className={value === "hybrid" ? "selected" : ""}><input type="radio" name="hosting" value="hybrid" checked={value === "hybrid"} onChange={() => onChange("hybrid")} /><span><strong>Hybrid</strong><small>Your own Linux servers. $199/month for two hosts, plus $49 per extra host. Optional guided pilot: $299 for 30 days. Prices exclude tax.</small></span></label>
  </fieldset>;
}

export function EnvironmentHostHealth({ nodeId }: { nodeId: string | null }) {
  const [data, setData] = useState<HostsData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    const refresh = () => api<HostsData>('/api/hosts').then(result => { if (!cancelled) { setData(result); setFailed(false); } }).catch(() => { if (!cancelled) { setFailed(true); setData(null); } });
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [nodeId]);
  const host = data?.hosts.find(host => host.id === nodeId);
  if (!nodeId) return null;
  if (failed) return <p role="status">Host health could not be loaded.</p>;
  return host ? <HostHealth host={host} latestVersion={data?.latest_agent_version} /> : null;
}

export function HostsPage() {
  const selfHosted = useInstallation().installationMode === "self-hosted";
  const [params] = useSearchParams();
  const [data, setData] = useState<HostsData | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [copied, setCopied] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<string | null>(null);
  async function refresh() { setData(await api<HostsData>("/api/hosts")); setLoadError(""); }
  useEffect(() => {
    const load = () => void refresh().catch(e => setLoadError(e.message));
    load(); const timer = setInterval(load, 3000); return () => clearInterval(timer);
  }, []);
  async function changeHosting(mode: "managed" | "hybrid") {
    setBusy(true); setError("");
    try { await api("/api/hosts/hosting", { method: "PUT", body: JSON.stringify({ hosting_mode: mode }) }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not change hosting"); }
    finally { setBusy(false); }
  }
  async function removeHost() {
    setBusy(true); setError("");
    try { await api(`/api/hosts/${remove}`, { method: "DELETE" }); setRemove(null); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not remove host"); }
    finally { setBusy(false); }
  }
  const connectedHosts = data?.hosts.filter(hostConnected).length || 0;
  const environmentCount = data?.hosts.reduce((total, host) => total + host.environment_count, 0) || 0;
  const healthyHosts = data?.hosts.filter(hostHealthy).length || 0;
  if (data?.hosting_mode === "managed") return <Navigate to="/environments" replace />;
  return <div className="page hosts-page">
    <header className="page-header"><div><p className="eyebrow">{params.has("welcome") ? "Your organization is ready" : "Infrastructure"}</p><h1>Compute hosts</h1><p>Connect servers and choose where your environments run.</p></div>{data?.hosting_mode === "hybrid" && data.role === "admin" && data.hosts.length > 0 && <button className="button button-secondary host-connect-trigger" type="button" aria-expanded={showConnect} onClick={() => setShowConnect(value => !value)}><Plus />Connect host</button>}</header>
    {error && <div role="alert" className="form-alert form-alert-error">{error}</div>}
    {loadError && <LoadError message={loadError} onRetry={() => { setLoadError(""); void refresh().catch(e => setLoadError(e.message)); }} />}
    {!data ? (!loadError && <p role="status">Loading hosts…</p>) : <>
      {data.role === "admin" && (!data.hosts.length || showConnect) && <section className="data-panel host-panel connect-panel"><div className="connect-panel-heading"><div><p className="eyebrow">{data.hosts.length ? "Add capacity" : "Connect a server"}</p><h2>Run this command on your server</h2></div>{data.hosts.length > 0 && <button className="connect-panel-close" type="button" onClick={() => setShowConnect(false)}>Close</button>}</div><p>Use a clean Ubuntu 22.04 or 24.04 server, amd64, with sudo access. Dependencies are installed automatically. No inbound product ports are needed.</p>
        <div className="host-command"><code>{data.install_command}</code><button className="button" onClick={() => void navigator.clipboard.writeText(data.install_command).then(() => setCopied(true)).catch(() => setError("Could not copy. Select and copy the command manually."))}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy command"}</button></div>
        <ol><li>Run the command on each server you want to connect.</li><li>Open the link it prints and approve the connection.</li><li>Wait for the host below, then create an environment.</li></ol>
        <p className="subtle">Snapshots start on the server’s local disk. You can configure your own S3 storage later. Local data depends on keeping that server.</p><Link to="/docs/hybrid-installation#storage">Storage and installation guide</Link>
      </section>}
      {!data.hosts.length ? <section className="data-panel host-panel host-waiting"><HardDrives /><div><h2>Waiting for your first host</h2><p role="status">Run the command above. This page updates when the server connects.</p></div></section> : <>
        <section className="host-summary" aria-label="Compute overview"><div><strong>{connectedHosts}</strong><span>{connectedHosts === 1 ? "host connected" : "hosts connected"}</span></div><div><strong>{environmentCount}</strong><span>{environmentCount === 1 ? "environment" : "environments"}</span></div><div><strong>{healthyHosts === data.hosts.length ? "All healthy" : `${healthyHosts} of ${data.hosts.length}`}</strong><span>host health</span></div></section>
        <section className="host-collection"><div className="host-collection-heading"><div><p className="eyebrow">Your infrastructure</p><h2>Connected hosts</h2></div><span>{data.hosts.length} total</span></div><div className="host-list">{data.hosts.map(host => {
          const connected = hostConnected(host);
          const healthLabel = !hostHealthFresh(host) ? "Unknown" : hostHealthy(host) ? "Healthy" : "Needs attention";
          return <article className="data-panel compute-host-card" key={host.id}><div className="host-card-heading"><div className="host-card-title"><div className="host-card-icon"><HardDrives /></div><div><div className="host-name-row"><h3>{host.name}</h3><span className={`host-status ${connected ? hostHealthy(host) ? "host-status-healthy" : "host-status-warning" : "host-status-offline"}`}><i />{connected ? healthLabel : host.last_seen_at ? "Offline" : "Installing"}</span></div><p>{connected ? "Connected now" : host.last_seen_at ? `Last seen ${new Date(host.last_seen_at).toLocaleString()}` : "Waiting for first connection"} · {host.storage_driver === "s3" ? "S3 snapshots" : "Local snapshots"}</p></div></div>{data.role === "admin" && <div className="host-actions"><Link className="button button-primary" to={`/environments/new?host=${host.id}`}><Plus />Create environment</Link></div>}</div>
            <div className="host-metrics"><div><span>Environments</span><strong>{host.environment_count}</strong></div><div><span>Compute</span><strong><Cpu />{host.cpu_count || "—"} vCPU</strong></div><div><span>Memory</span><strong>{formatMemory(host.memory_mb)}</strong></div><div><span>Storage</span><strong>{host.storage_driver === "s3" ? "S3" : "Local"}</strong></div></div>
            <HostHealth host={host} latestVersion={data.latest_agent_version} compact onDisconnect={data.role === "admin" ? () => setRemove(host.id) : undefined} disconnectDisabled={busy || host.environment_count > 0} />
          </article>;
        })}</div></section>
      </>}
      {remove && <section role="alert" className="data-panel host-panel"><h2>Disconnect this host?</h2><p>This revokes its connection to Driftverk. It does not uninstall software or erase files on the server.</p><button className="button button-secondary" onClick={() => setRemove(null)}>Cancel</button><button className="button button-primary" disabled={busy} onClick={() => void removeHost()}>Disconnect host</button></section>}
      {!selfHosted && !data.hosts.length && data.role === "admin" && <button className="button button-secondary" disabled={busy} onClick={() => void changeHosting("managed")}>Use Driftverk Cloud instead</button>}
    </>}
  </div>;
}

export function HostingSettings() {
  const navigate = useNavigate();
  const [data, setData] = useState<HostsData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<HostsData>("/api/hosts").then(setData).catch(() => setError("Could not load workspace compute settings."));
  }, []);

  async function useOwnServers() {
    setBusy(true); setError("");
    try {
      await api("/api/hosts/hosting", { method: "PUT", body: JSON.stringify({ hosting_mode: "hybrid" }) });
      navigate("/hosts");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not change hosting"); }
    finally { setBusy(false); }
  }

  if (!data && !error) return null;
  return <section className="data-panel settings-panel">
    <div className="panel-heading"><div><span className="eyebrow">Workspace</span><h2>Compute</h2></div></div>
    <div className="settings-form-body">
      {data?.hosting_mode === "managed" ? <><p>Your environments run on Driftverk Cloud.</p>{data.role === "admin" && <><p>You can switch to your own servers before creating environments. Hybrid requires a separate subscription after the trial.</p><button type="button" className="button button-secondary" disabled={busy} onClick={() => void useOwnServers()}>{busy ? "Switching…" : "Use my own servers"}</button></>}</> : data && <><p>Your environments run on your own servers.</p><Link className="button button-secondary" to="/hosts">Manage compute hosts</Link></>}
      {error && <p role="alert" className="form-alert form-alert-error">{error}</p>}
    </div>
  </section>;
}
