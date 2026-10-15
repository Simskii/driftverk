import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "./api";
export type MemberSettings = { enabled: boolean; cpu: number; memory_mb: number; disk_gb: number; image: string; image_name: string; role: string; can_create: boolean; existing: { id: string; name: string; state: string } | null };

export function MemberEnvironmentForm({ settings }: { settings: MemberSettings }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const created = await api<{ id: string }>("/api/environments", { method: "POST", body: JSON.stringify({ name: name || undefined, repository: repository || undefined, repository_branch: repository && branch || undefined }) });
      navigate(`/environments/${created.id}`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not create the environment."); }
    finally { setBusy(false); }
  }
  return <section className="page"><header className="page-header"><div><h1>Your environment</h1><p>Create one personal environment in this workspace.</p></div></header>
    <form className="data-panel settings-panel settings-form-body member-self-service" onSubmit={submit}>
      <p>{settings.image_name} · {settings.cpu} vCPU · {settings.memory_mb / 1024} GB memory · {settings.disk_gb} GB disk</p>
      <p className="subtle">Your workspace pays for usage. Auto-stop is set to 15 minutes. Stopped environments count toward your limit; environments assigned by an admin do not.</p>
      {settings.existing ? <p>You already have <Link to={`/environments/${settings.existing.id}`}>{settings.existing.name}</Link>. To replace it, delete it and wait for deletion to finish.</p> : !settings.enabled ? <p>Member creation is disabled. Ask a workspace admin for access to an environment.</p> : <>
        <label className="field"><span>Environment name <small>Optional</small></span><input value={name} onChange={event => setName(event.target.value)} pattern="[a-z0-9][a-z0-9-]{0,62}" placeholder="Generated automatically" disabled={busy} /></label>
        <label className="field"><span>GitHub repository <small>Optional</small></span><input value={repository} onChange={event => setRepository(event.target.value)} placeholder="owner/repository" disabled={busy} /></label>
        <label className="field"><span>Branch <small>Optional</small></span><input value={branch} onChange={event => setBranch(event.target.value)} placeholder="Repository default" disabled={busy || !repository} /></label>
        <p className="subtle">Leave the repository empty to start with development tools only. You can connect your agent after creation.</p>
        <section className="creation-summary" aria-label="Environment summary"><dl>
          <div><dt>Project</dt><dd>{repository ? `${repository} · ${branch || "default branch"}` : "Development tools only"}</dd></div>
          <div><dt>Resources</dt><dd>{settings.cpu} vCPU · {settings.memory_mb / 1024} GB memory</dd></div>
          <div><dt>Auto-stop</dt><dd>After 15 minutes of inactivity</dd></div>
        </dl><p className="subtle">Uses your workspace’s hosting and billing settings.</p></section>
        <button className="button button-primary" disabled={busy}>{busy ? "Creating…" : "Create environment"}</button></>}
      {error && <p role="alert" className="form-alert form-alert-error">{error}</p>}
    </form>
  </section>;
}

export function MemberCreationPolicy() {
  const [settings, setSettings] = useState<MemberSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { api<MemberSettings>("/api/member-environment-settings").then(setSettings).catch(error => setError(error.message)); }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!settings) return;
    setBusy(true); setMessage(""); setError("");
    try {
      setSettings(await api<MemberSettings>("/api/member-environment-settings", { method: "PUT", body: JSON.stringify({ enabled: settings.enabled, cpu: settings.cpu, memory_mb: settings.memory_mb }) }));
      setMessage("Member creation settings saved.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save settings."); }
    finally { setBusy(false); }
  }
  if (!settings) return error ? <p role="alert">{error}</p> : null;
  if (settings.role !== "admin") return null;
  return <form className="data-panel settings-panel settings-form-body member-self-service" onSubmit={save}>
    <h2>Member environments</h2>
    <label className="setting-toggle"><input type="checkbox" role="switch" checked={settings.enabled} disabled={busy} onChange={event => setSettings({ ...settings, enabled: event.target.checked })} /><span><strong>Allow each member to create one environment</strong><small>Your workspace pays for usage.</small></span></label>
    <p className="subtle">Members use Driftverk Dev with 40 GB disk and 15-minute auto-stop. Choose the size for new environments. Changes do not resize or remove existing environments.</p>
    <label className="field"><span>CPU</span><select value={settings.cpu} disabled={busy} onChange={event => setSettings({ ...settings, cpu: Number(event.target.value) })}>{[1,2,4,8].map(cpu => <option key={cpu} value={cpu}>{cpu} vCPU</option>)}</select></label>
    <label className="field"><span>Memory</span><select value={settings.memory_mb} disabled={busy} onChange={event => setSettings({ ...settings, memory_mb: Number(event.target.value) })}>{[1024,2048,4096,8192,16384].map(memory => <option key={memory} value={memory}>{memory / 1024} GB</option>)}</select></label>
    <button className="button button-secondary" disabled={busy}>{busy ? "Saving…" : "Save member settings"}</button>
    {error && <p role="alert" className="form-alert form-alert-error">{error}</p>}{message && <p role="status">{message}</p>}
  </form>;
}
