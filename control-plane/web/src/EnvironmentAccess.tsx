import { MemberEnvironmentAccess } from "./MemberEnvironmentAccess";
import { useEffect, useState } from "react";
import { api, type Environment } from "./api";

type TailscaleStatus = { state: string; pending: boolean; auth_url?: string; hostname?: string; ips?: string[]; checked_at?: string };

export function EnvironmentAccess({ environment, onSshChange }: { environment: Environment; onSshChange: (enabled: boolean) => void }) {
  const [sshBusy, setSshBusy] = useState(false);
  const [status, setStatus] = useState<TailscaleStatus>({ state: "unknown", pending: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = `/api/environments/${encodeURIComponent(environment.id)}`;
  const canConfigure = Boolean(environment.can_manage_configuration);
  const unavailableReason = !environment.can_manage_lifecycle ? "An organization admin can configure Tailscale."
    : !canConfigure ? "Tailscale setup requires a trusted environment."
      : environment.active_operation ? "Wait for the current environment operation to finish before configuring Tailscale."
        : environment.state !== "running" ? "Start the environment to configure Tailscale." : null;
  const available = unavailableReason === null;

  useEffect(() => {
    if (!canConfigure) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const value = await api<TailscaleStatus>(`${path}/tailscale`);
        if (cancelled) return;
        setStatus(value);
        if (value.pending) timer = setTimeout(() => void refresh(), 2000);
      } catch (caught) { if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not check Tailscale."); }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [path, canConfigure, busy]);

  async function toggleSsh(enabled: boolean) {
    setSshBusy(true); setError("");
    try {
      const result = await api<{ ssh_enabled: boolean }>(`${path}/ssh`, { method: "PUT", body: JSON.stringify({ enabled }) });
      onSshChange(result.ssh_enabled);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not update SSH access."); }
    finally { setSshBusy(false); }
  }

  async function tailscale(action: "status" | "connect" | "logout") {
    setBusy(true); setError("");
    try {
      setStatus(await api<TailscaleStatus>(`${path}/tailscale`, { method: "POST", body: JSON.stringify({ action }) }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not configure Tailscale."); }
    finally { setBusy(false); }
  }

  const messages: Record<string, string> = {
    unknown: "Connect this environment to your tailnet with Tailscale SSH.",
    checking: "Checking Tailscale…",
    not_installed: "Tailscale is not installed in this environment. Use the latest Driftverk Dev image, or install Tailscale in your custom image.",
    stopped: "Tailscale is installed and ready to set up.",
    logged_out: "Tailscale is signed out.",
    needs_login: "Authorize this environment in Tailscale to finish setup.",
    needs_approval: "Approve this device in your Tailscale admin console.",
    connected: "Connected to Tailscale.",
    error: "Tailscale setup could not finish. Check the installation and retry.",
  };

  return <>
    {environment.can_manage_lifecycle && <MemberEnvironmentAccess key={environment.id} environmentId={environment.id} />}
    <section className="overview-section"><h2>SSH access</h2>
      <label className="setting-toggle"><input type="checkbox" role="switch" aria-label="Allow SSH connections" checked={environment.ssh_enabled !== false} disabled={sshBusy || !environment.can_manage_lifecycle} onChange={event => void toggleSsh(event.target.checked)} /><span><strong>Allow SSH connections</strong><small>Connect through Driftverk’s SSH gateway.</small></span></label>
    </section>
    <section className="overview-section"><h2>Tailscale</h2>
      <p className="subtle" role="status">{unavailableReason || messages[status.state] || messages.unknown}</p>
      {available && <>
        {status.state === "connected" && <p><code>{status.hostname || status.ips?.[0]}</code></p>}
        <div className="development-actions">
          {status.state === "needs_login" && status.auth_url && <a className="button button-primary" href={status.auth_url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Authorize in Tailscale</a>}
          {status.state === "needs_approval" && <a className="button button-primary" href="https://login.tailscale.com/admin/machines" target="_blank" rel="noopener noreferrer">Open Tailscale admin</a>}
          {!["connected", "not_installed", "needs_login", "needs_approval"].includes(status.state) && <button type="button" className="button button-secondary" disabled={busy || status.pending} onClick={() => void tailscale("connect")}>Set up Tailscale</button>}
          <button type="button" className="button button-secondary" disabled={busy || status.pending} onClick={() => void tailscale("status")}>{status.pending ? ["needs_login", "needs_approval"].includes(status.state) ? "Waiting for authorization…" : "Checking…" : "Check status"}</button>
          {["connected", "needs_login", "needs_approval", "error", "stopped"].includes(status.state) && <button type="button" className="button button-secondary" disabled={busy || status.pending} onClick={() => void tailscale("logout")}>Sign out</button>}
        </div>
        {status.state === "connected" && <p className="subtle">SSH access follows your tailnet’s access rules. Sign out before capturing a snapshot.</p>}
      </>}
    </section>
    {error && <div className="form-alert form-alert-error" role="alert">{error}</div>}
  </>;
}
