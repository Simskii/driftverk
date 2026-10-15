import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "./api";

type Secret = { name: string; updated_at: string };
export function OrganizationSecretPicker({ value, onChange }: { value: string[]; onChange: (names: string[]) => void }) {
  const [secrets, setSecrets] = useState<Secret[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api<{ secrets: Secret[] }>("/api/organization-secrets").then(data => setSecrets(data.secrets)).catch(error => setError(error.message)); }, []);
  return <div className="organization-secret-picker"><p className="subtle">Selected secrets are added when the environment is created. Manage values in <Link to="/settings">Settings</Link>.</p>
    {error && <p role="alert" className="form-alert form-alert-error">{error}</p>}
    {!secrets && !error && <p>Loading organization secrets…</p>}
    {secrets?.length === 0 && <p>No organization secrets configured.</p>}
    {[...new Set([...(secrets?.map(secret => secret.name) || []), ...value])].map(name => <label key={name} style={{display: "block", marginBlock: 8}}><input type="checkbox" checked={value.includes(name)} onChange={event => onChange(event.target.checked ? [...value, name] : value.filter(item => item !== name))} /> <code>{name}</code>{secrets && !secrets.some(secret => secret.name === name) && <span role="alert"> · Missing, add it in Settings before creating an environment.</span>}</label>)}
  </div>;
}
export function OrganizationSecrets() {
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState("");
  async function load() { const data = await api<{secrets: Secret[]; can_manage: boolean}>("/api/organization-secrets"); setSecrets(data.secrets); setCanManage(data.can_manage); }
  useEffect(() => { void load().catch(error => setError(error.message)); }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try { await api("/api/organization-secrets", {method: "POST", body: JSON.stringify({name, value})}); setValue(""); setName(""); await load(); setNotice("Secret saved. New environments using this secret will receive the current value."); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not save secret."); } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError("");
    try { await api(`/api/organization-secrets/${encodeURIComponent(removing)}`, {method: "DELETE"}); setRemoving(""); await load(); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not remove secret."); } finally { setBusy(false); }
  }
  const replacing = secrets.some(secret => secret.name === name);
  return <section className="data-panel settings-panel organization-secrets"><div className="panel-heading"><div><span className="eyebrow">Environment setup</span><h2>Organization secrets</h2></div></div><div className="settings-form-body">
    <p>Blueprints reference secrets by name. Values stay encrypted and changes only apply to new environments.</p>
    {error && <p role="alert" className="form-alert form-alert-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className={`organization-secret-layout${canManage ? "" : " organization-secret-layout-readonly"}`}>
      <section className="organization-secret-list" aria-labelledby="saved-secrets-heading">
        <div className="organization-secret-section-heading"><div><span className="eyebrow">Saved</span><h3 id="saved-secrets-heading">{secrets.length} {secrets.length === 1 ? "secret" : "secrets"}</h3></div><span>Values hidden</span></div>
        {!secrets.length && <p className="organization-secret-empty">No organization secrets added yet.</p>}
        {secrets.map(secret => <div className="organization-secret-row" key={secret.name}><code>{secret.name}</code>{canManage && <div className="organization-secret-actions"><button className="button button-secondary" disabled={busy} onClick={() => { setName(secret.name); setValue(""); }}>Replace</button><button className="button button-secondary button-danger" disabled={busy} onClick={() => setRemoving(secret.name)}>Remove</button></div>}</div>)}
      </section>
      {canManage && <form className="organization-secret-editor" onSubmit={save}><fieldset className="organization-secret-fields" disabled={busy}><legend>{replacing ? "Replace secret" : "Add a secret"}</legend><p>{replacing ? "Enter a new value. The saved value is never displayed." : "Use the same name in blueprints that need this value."}</p><label className="field"><span>Secret name</span><input required pattern="[A-Za-z_][A-Za-z0-9_]*" maxLength={128} placeholder="API_TOKEN" value={name} onChange={event => setName(event.target.value)} /></label><label className="field"><span>Secret value</span><input required type="password" autoComplete="new-password" data-1p-ignore value={value} maxLength={32768} onChange={event => setValue(event.target.value)} /></label><button className="button button-primary" disabled={busy || !name || !value}>{busy ? "Saving…" : replacing ? "Replace secret" : "Add secret"}</button></fieldset></form>}
    </div>
    {removing && <div className="organization-secret-confirm" role="alert"><p>Remove <code>{removing}</code>? Blueprints using it cannot start new environments until it is restored.</p><div><button className="button button-secondary" disabled={busy} onClick={() => setRemoving("")}>Cancel</button><button className="button button-danger-solid" disabled={busy} onClick={() => void remove()}>Remove secret</button></div></div>}
  </div></section>;
}
