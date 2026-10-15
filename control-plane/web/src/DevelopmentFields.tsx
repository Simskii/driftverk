import { OrganizationSecretPicker } from "./OrganizationSecrets";
import { Link } from "react-router-dom";
import { useEffect, useState, useRef, useId, useLayoutEffect } from "react";
import { api } from "./api";
import { Dialog } from "./Dialog";
import { LoadError } from "./LoadError";
import { Trash } from "@phosphor-icons/react";

export type TemplateConfiguration = {
  agent_id?: "codex" | "claude" | null;
  agent_auth_method?: "subscription" | "api_key";
  organization_secret_names?: string[];
  source_type: "image" | "snapshot"; image: string | null; snapshot_id: string | null; registry_id: string | null;
  workspace_path?: string | null; preview_port?: number | null; preview_enabled?: boolean;
  cpu: number; memory_mb: number; auto_stop_minutes: number | null;
  repository: string | null; repository_branch: string | null; setup_command: string | null; initialization_command?: string | null; startup_command?: string | null; readiness_command?: string | null;
};
export type Prebuild = { id: string; template_id: string; snapshot_id: string; configuration: TemplateConfiguration; name: string; status: "building" | "ready" | "failed"; repository_revision: string | null; error_message: string | null };
type Template = { id: string; name: string; configuration: TemplateConfiguration };
type Repository = { full_name: string; default_branch: string; private: boolean };

export function TemplatePicker({ configuration, onSelect, initialSelection = "" }: { initialSelection?: string; configuration: TemplateConfiguration; onSelect: (value: TemplateConfiguration) => void }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selected, setSelected] = useState(initialSelection);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => { api<{ templates: Template[] }>("/api/environment-templates").then(data => setTemplates(data.templates)).catch(error => setError(error.message)); }, []);
  async function save() {
    setBusy(true); setError(""); setNotice("");
    try {
      const data = await api<{ template: Template }>("/api/environment-templates", { method: "POST", body: JSON.stringify({ name, configuration }) });
      setTemplates(current => [...current, data.template]); setSelected(data.template.id); setSaving(false); setName(""); setNotice("Project setup saved.");
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save template"); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setConfirmDelete(false);
    setBusy(true); setError(""); setNotice("");
    try { await api(`/api/environment-templates/${selected}`, { method: "DELETE" }); setTemplates(current => current.filter(item => item.id !== selected)); setSelected(""); setNotice("Project setup deleted. Your current configuration is kept."); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not delete template"); }
    finally { setBusy(false); }
  }
  return <section className="form-section development-fields">
    <label className="field"><span>Project setup <small>Optional</small></span><select value={selected} disabled={busy} onChange={event => {
      setSelected(event.target.value); setConfirmDelete(false); setNotice(""); const template = templates.find(item => item.id === event.target.value); if (template) onSelect(template.configuration);
    }}><option value="">New setup</option>{templates.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <div className="development-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => setSaving(!saving)}>Save as project setup</button>{selected && <button type="button" className="button button-secondary" disabled={busy} onClick={remove}>{confirmDelete ? "Confirm delete template" : "Delete setup"}</button>}</div>
    {saving && <div className="development-fields"><label className="field"><span>Setup name</span><input value={name} maxLength={80} onChange={event => setName(event.target.value)} placeholder="Project development" /></label><p className="subtle">Saves source, repository, install, startup and readiness commands, resources and idle timeout. Variables and volume mounts are configured separately.</p><button type="button" className="button button-secondary" disabled={busy || !name.trim()} onClick={save}>{busy ? "Saving…" : "Save project setup"}</button></div>}
    {error && <p className="form-alert form-alert-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}

function RepositoryPicker({ repository, repositories, onSelect, nextPage, busy, onLoadMore, required = false }: {
  required?: boolean; repository: string; repositories: Repository[]; onSelect: (name: string, branch: string) => void;
  nextPage: number | null; busy: boolean; onLoadMore: () => void;
}) {
  const id = useId();
  const picker = useRef<HTMLDivElement>(null);
  const [menuHeight, setMenuHeight] = useState(228);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const options = repositories.filter(item => item.full_name.toLowerCase().includes(repository.trim().toLowerCase()));
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const field = picker.current;
      const scrollArea = field?.closest(".create-modal-fields");
      if (field && scrollArea) setMenuHeight(Math.max(76, Math.min(228, scrollArea.getBoundingClientRect().bottom - field.getBoundingClientRect().bottom - (nextPage ? 46 : 4))));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, nextPage]);
  function select(item: Repository) { onSelect(item.full_name, item.default_branch); setOpen(false); setActive(-1); }
  useEffect(() => { if (open && active >= 0) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" }); }, [active, open, id]);
  return <div ref={picker} className="repository-picker" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setOpen(false); setActive(-1); }
  }}>
    <label className="field"><span>Repository {!required && <small>Optional</small>}</span><input required={required} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined} aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
      autoComplete="off" placeholder="Search or enter owner/repository" value={repository}
      onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
      onChange={event => { onSelect(event.target.value, ""); setActive(-1); setOpen(true); }}
      onKeyDown={event => {
        if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); setActive(-1); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); setOpen(true);
          setActive(current => options.length ? (event.key === "ArrowDown" ? Math.min(current + 1, options.length - 1) : current <= 0 ? options.length - 1 : current - 1) : -1);
        }
        if (event.key === "Enter" && open) { event.preventDefault(); if (active >= 0 && options[active]) select(options[active]); else setOpen(false); }
      }} /></label>
    {open && <div className="repository-popover">
      <div id={`${id}-list`} role="listbox" aria-label="Repositories" className="repository-results" style={{ maxHeight: menuHeight }}>
        {options.map((item, index) => <div key={item.full_name} id={`${id}-${index}`} role="option" aria-selected={index === active} className="repository-option"
          onMouseDown={event => event.preventDefault()} onClick={() => select(item)}>
          <span>{item.full_name}</span>{item.private && <small>Private</small>}
        </div>)}
      </div>
      {!options.length && <p className="repository-empty" role="status">{repository.trim() ? "No matching repositories loaded. You can enter owner/repository directly." : "Enter owner/repository, or connect GitHub to browse."}</p>}
      {nextPage && <button type="button" className="button button-quiet repository-load-more" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => { picker.current?.querySelector("input")?.focus(); onLoadMore(); }}>{busy ? "Loading…" : "Load more repositories"}</button>}
    </div>}
  </div>;
}

export function RepositoryFields({ repository, branch, onRepository, onBranch, hideBranch = false, required = false }: { required?: boolean; hideBranch?: boolean; repository: string; branch: string; onRepository: (value: string) => void; onBranch: (value: string) => void }) {
  const [connection, setConnection] = useState<{ login: string; connection_type?: string } | null>(null);
  const [oauthAvailable, setOauthAvailable] = useState(false);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function loadRepositories(page = 1) {
    const data = await api<{ repositories: Repository[]; next_page: number | null }>(`/api/github/repositories?page=${page}`);
    setRepositories(current => page === 1 ? data.repositories : [...current, ...data.repositories]); setNextPage(data.next_page);
  }
  useEffect(() => { api<{ connection: { login: string; connection_type?: string } | null; oauth_available: boolean }>("/api/github/connection").then(async data => { setConnection(data.connection); setOauthAvailable(data.oauth_available); if (data.connection) await loadRepositories(); }).catch(error => setError(error.message)); }, []);
  function connect() {
    const returnPath = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/api/github/connect?return=${encodeURIComponent(returnPath)}`);
  }
  async function disconnect() {
    setBusy(true); setError("");
    try { await api("/api/github/connection", { method: "DELETE" }); setConnection(null); setRepositories([]); setNextPage(null); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not disconnect GitHub"); }
    finally { setBusy(false); }
  }
  if (hideBranch) return <section className="create-repository-fields">
    <RepositoryPicker required={required} repository={repository} repositories={repositories} onSelect={(name, defaultBranch) => { onRepository(name); onBranch(defaultBranch); }} nextPage={nextPage} busy={busy} onLoadMore={async () => {
      if (!nextPage) return;
      setBusy(true); setError("");
      try { await loadRepositories(nextPage); } catch (error) { setError(error instanceof Error ? error.message : "Could not load repositories"); } finally { setBusy(false); }
    }} />
    <div className="create-github-row"><span>{connection ? `Connected as ${connection.login}` : "Public repositories work without GitHub."}</span>
      {oauthAvailable && <button type="button" className="button button-quiet" disabled={busy} onClick={connect}>{connection ? "Manage access" : "Connect GitHub"}</button>}
    </div>
    {!oauthAvailable && <p className="subtle">GitHub connection is unavailable. Enter a public repository.</p>}
    {error && <p className="form-alert form-alert-error" role="alert">{error}</p>}
  </section>;
  return <section className="form-section development-fields">
    <div className="section-heading"><div><h2>GitHub repository</h2><p>Clone a repository into your environment, ready to open in your editor.</p></div></div>
    <div className="github-connect-card">
      <div><strong>{connection ? `Connected as ${connection.login}` : "Connect your GitHub account"}</strong><p>{connection ? "Driftverk can read repositories granted to its GitHub App." : "Sign in to GitHub, then choose which repositories Driftverk may read."}</p></div>
      <div className="development-actions"><button type="button" className="button button-secondary" disabled={busy || !oauthAvailable} onClick={connect}>{connection ? "Change repository access" : "Connect GitHub"}</button>{connection && <button type="button" className="button button-quiet" disabled={busy} onClick={disconnect}>Disconnect</button>}</div>
    </div>
    {!oauthAvailable && <p className="form-alert">GitHub connection is not configured for this Driftverk installation.</p>}
    {repositories.length > 0 && <label className="field"><span>Your repositories</span><select value={repositories.some(item => item.full_name === repository) ? repository : ""} onChange={event => { const selected = repositories.find(item => item.full_name === event.target.value); onRepository(selected?.full_name || ""); onBranch(selected?.default_branch || ""); }}><option value="">Choose a repository</option>{repositories.map(item => <option key={item.full_name} value={item.full_name}>{item.full_name}{item.private ? " · Private" : ""}</option>)}</select></label>}
    {nextPage && <button type="button" className="button button-secondary" disabled={busy} onClick={async () => { setBusy(true); try { await loadRepositories(nextPage); } catch (error) { setError(error instanceof Error ? error.message : "Could not load repositories"); } finally { setBusy(false); } }}>Load more repositories</button>}
    <div className="repository-fields"><label className="field"><span>Repository {!hideBranch && <small>Optional</small>}</span><input placeholder="owner/repository" value={repository} onChange={event => { onRepository(event.target.value); onBranch(""); }} /></label>{!hideBranch && <label className="field"><span>Branch</span><input placeholder="Default branch" disabled={!repository.trim()} value={branch} onChange={event => onBranch(event.target.value)} /></label>}</div>
    <p className="subtle">Public repositories also work without a connection.{!hideBranch && " Leave empty to start without a checkout."}</p>
    {error && <p className="form-alert form-alert-error" role="alert">{error}</p>}
  </section>;
}

export function ProjectCommands({ repository, branch, setup, initialization, startup, readiness, prebuilt = false, onSetup, onInitialization, onStartup, onReadiness }: {
  repository: string; branch: string; setup: string; initialization: string; startup: string; readiness: string; prebuilt?: boolean;
  onSetup: (value: string) => void; onInitialization: (value: string) => void; onStartup: (value: string) => void; onReadiness: (value: string) => void;
}) {
  const [suggestion, setSuggestion] = useState<{ compose_file?: string; setup_command: string; startup_command: string; readiness_command: string; notes: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(() => { request.current++; setSuggestion(null); setError(""); setBusy(false); return () => { request.current++; }; }, [repository, branch]);
  async function detect() {
    const current = ++request.current;
    setBusy(true); setError(""); setSuggestion(null);
    try {
      const result = await api<{ compose_file?: string; setup_command: string; startup_command: string; readiness_command: string; notes: string[] }>(`/api/github/project-setup?${new URLSearchParams({ repository, branch })}`);
      if (current === request.current) setSuggestion(result);
    } catch (error) { if (current === request.current) setError(error instanceof Error ? error.message : "Could not inspect repository"); }
    finally { if (current === request.current) setBusy(false); }
  }
  return <section className="form-section development-fields">
    <div className="section-heading"><div><h2>Prepare your project</h2><p>Review the commands that make this repository ready to work in.</p></div></div>
    {repository && !prebuilt && <button type="button" className="button button-secondary" disabled={busy} onClick={() => void detect()}>{busy ? "Inspecting repository…" : "Detect project setup"}</button>}
    {suggestion && <div className="project-suggestion" role="status">{suggestion.notes.map(note => <p key={note}>{note}</p>)}<p>Install: <code>{suggestion.setup_command || "Not required"}</code></p><p>Start: <code>{suggestion.startup_command || (suggestion.compose_file ? "Automatic Compose startup" : "Enter manually")}</code></p>{suggestion.readiness_command && <p>Ready: <code>{suggestion.readiness_command}</code></p>}{(suggestion.compose_file || suggestion.setup_command || suggestion.startup_command) && <button type="button" className="button button-secondary" onClick={() => { onSetup(suggestion.setup_command); onStartup(suggestion.startup_command); onReadiness(suggestion.readiness_command); setSuggestion(null); }}>{suggestion.compose_file ? "Use automatic Compose startup" : "Use suggested commands"}</button>}</div>}
    {error && <p className="form-alert form-alert-error" role="alert">{error} You can enter commands below.</p>}
    <label className="field"><span>Install dependencies <small>Optional</small></span><textarea disabled={prebuilt} value={setup} maxLength={8000} rows={2} onChange={event => onSetup(event.target.value)} placeholder="npm ci" /></label>
    <p className="subtle">Runs once after cloning, with a 15-minute limit. Prebuilds run this without runtime variables. Keep secrets out of this command.</p>
    <label className="field"><span>Initialize each environment <small>Optional</small></span><textarea value={initialization} maxLength={8000} rows={2} onChange={event => onInitialization(event.target.value)} placeholder="npm run db:seed" /></label>
    <p className="subtle">Runs once in each new environment, after its variables are injected and before services start. Use this to create isolated development data. Must be safe to retry; shared databases are not isolated automatically.</p>
    <label className="field"><span>Start services <small>Optional</small></span><textarea value={startup} maxLength={8000} rows={2} onChange={event => onStartup(event.target.value)} placeholder="npm run dev -- --host 0.0.0.0" /></label>
    <p className="subtle">Runs in the background on creation and each resume. Use your project's command and bind web services to 0.0.0.0.</p>
    <label className="field"><span>Check the app is ready <small>Optional</small></span><textarea value={readiness} maxLength={8000} rows={2} onChange={event => onReadiness(event.target.value)} placeholder="curl -fsS http://127.0.0.1:3000/ > /dev/null" /></label>
    <p className="subtle">Use your app's actual port or another check. Exit code 0 means ready. Retried for up to 2 minutes inside the environment. Without a check, app readiness is unverified.</p>
  </section>;
}

export function ProjectSetupsPage() {
  const [canManage, setCanManage] = useState(false);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [prebuilds, setPrebuilds] = useState<Prebuild[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [deleting, setDeleting] = useState<Template | null>(null);
  useEffect(() => {
    let alive = true;
    async function refresh() {
      try {
        const [setupData, buildData] = await Promise.all([api<{ templates: Template[]; can_manage: boolean }>("/api/environment-templates"), api<{ prebuilds: Prebuild[] }>("/api/prebuilds")]);
        if (alive) { setTemplates(setupData.templates); setCanManage(setupData.can_manage); setPrebuilds(buildData.prebuilds); setError(""); }
      } catch (error) { if (alive) setError(error instanceof Error ? error.message : "Could not load blueprints"); }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [retry]);
  async function build(templateId: string) {
    setBusy(templateId); setError("");
    try {
      await api("/api/prebuilds", { method: "POST", body: JSON.stringify({ template_id: templateId }) });
      setPrebuilds((await api<{ prebuilds: Prebuild[] }>("/api/prebuilds")).prebuilds);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not start prebuild"); }
    finally { setBusy(null); }
  }
  async function remove(template: Template) {
    setBusy(template.id); setError("");
    try {
      await api(`/api/environment-templates/${encodeURIComponent(template.id)}`, { method: "DELETE" });
      setTemplates(current => current?.filter(item => item.id !== template.id) ?? null);
      setPrebuilds(current => current.filter(item => item.template_id !== template.id));
      setDeleting(null);
    } catch (error) { setDeleting(null); setError(error instanceof Error ? error.message : "Could not delete the blueprint"); }
    finally { setBusy(null); }
  }
  return <div className="page"><div className="page-header"><div><h1>Blueprints</h1><p>Reuse an environment’s image, repository and commands.</p></div><Link className="button button-primary" to="/environments/new">Create environment</Link></div>
    {error && (!templates ? <LoadError message={error} onRetry={() => { setError(""); setRetry(value => value + 1); }} /> : <p className="form-alert form-alert-error" role="alert">{error}</p>)}
    {!templates && !error && <p role="status">Loading blueprints…</p>}
    {templates?.length === 0 && <section className="empty-state data-panel"><h2>No blueprints yet</h2><p>Open an environment and choose More → Save as blueprint.</p><Link className="button button-primary" to="/environments">View environments</Link></section>}
    {Boolean(templates?.length) && <section className="data-panel environment-table-wrap blueprint-table-wrap"><table className="data-table blueprint-table"><thead><tr><th>Blueprint</th><th>Resources</th><th>Secrets</th><th>Prebuild</th><th>Preview</th><th>Actions</th></tr></thead><tbody>{templates?.map(template => {
      const latest = prebuilds.find(build => build.template_id === template.id);
      const ready = prebuilds.find(build => build.template_id === template.id && build.status === "ready");
      const supportsPreparedPreview = template.configuration.source_type === "snapshot" && Boolean(template.configuration.startup_command) && Boolean(template.configuration.readiness_command);
      return <tr key={template.id}>
        <td><strong>{template.name}</strong><span className="subtle">{template.configuration.repository || "Blank environment"}{template.configuration.repository_branch ? ` · ${template.configuration.repository_branch}` : ""}</span></td>
        <td><div className="resource-pills"><span>{template.configuration.cpu} vCPU</span><span>{template.configuration.memory_mb / 1024} GB RAM</span></div></td>
        <td><BlueprintSecrets template={template} onSaved={configuration => setTemplates(current => current?.map(item => item.id === template.id ? {...item, configuration} : item) || null)} /></td>
        <td>{latest ? <><span className={`blueprint-build-status ${latest.status}`} role="status">{latest.status === "building" ? "Building…" : latest.status === "ready" ? "Ready" : "Failed"}</span>{latest.status !== "failed" && latest.repository_revision && <code className="subtle">{latest.repository_revision.slice(0, 8)}</code>}</> : <span className="subtle">Not built</span>}</td>
        <td>{supportsPreparedPreview && canManage ? <PreparedPreviewSetting template={template} /> : <span className="subtle">—</span>}</td>
        <td><div className="table-actions blueprint-table-actions">{ready && <Link className="button button-primary" to={`/environments/new?prebuild=${encodeURIComponent(ready.id)}`}>Start from prebuild</Link>}<Link className="button button-secondary" to={`/environments/new?template=${encodeURIComponent(template.id)}`}>Use blueprint</Link>
          {template.configuration.source_type === "image" && <button className="button button-secondary" disabled={busy === template.id || latest?.status === "building"} onClick={() => void build(template.id)}>{busy === template.id || latest?.status === "building" ? "Building…" : ready ? "Rebuild prebuild" : "Build prebuild"}</button>}
          <button className="icon-button danger blueprint-delete" disabled={busy === template.id} onClick={() => setDeleting(template)} aria-label={`Delete ${template.name}`} title="Delete blueprint"><Trash /></button></div>
        </td>
      </tr>;
    })}</tbody></table></section>}
    {deleting && <Dialog className="confirm-dialog" labelledBy="delete-blueprint-title" describedBy="delete-blueprint-description" alert busy={busy === deleting.id} onClose={() => setDeleting(null)}>
      <div className="confirm-copy"><h2 id="delete-blueprint-title">Delete blueprint?</h2><p id="delete-blueprint-description">{deleting.name} will no longer be available when creating environments. Existing environments are not affected.</p></div>
      <div className="confirm-actions"><button data-dialog-autofocus type="button" className="button button-secondary" disabled={busy === deleting.id} onClick={() => setDeleting(null)}>Cancel</button><button type="button" className="button button-danger-solid" disabled={busy === deleting.id} onClick={() => void remove(deleting)}>{busy === deleting.id ? "Deleting…" : "Delete blueprint"}</button></div>
    </Dialog>}
  </div>;
}

function BlueprintSecrets({template, onSaved}: {template: Template; onSaved: (configuration: TemplateConfiguration) => void}) {
  const [editing, setEditing] = useState(false);
  const [names, setNames] = useState(template.configuration.organization_secret_names || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [canManage, setCanManage] = useState(false);
  useEffect(() => { api<{can_manage: boolean}>("/api/organization-secrets").then(data => setCanManage(data.can_manage)).catch(() => {}); }, []);
  async function save() {
    setBusy(true); setError("");
    try { await api(`/api/environment-templates/${template.id}`, {method: "PUT", body: JSON.stringify({name: template.name, configuration: {...template.configuration, organization_secret_names: names}})}); onSaved({...template.configuration, organization_secret_names: names}); setEditing(false); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not update blueprint."); } finally { setBusy(false); }
  }
  const titleId = `blueprint-secrets-${template.id}`;
  return <><span className="blueprint-secret-status">{template.configuration.organization_secret_names?.length ? "Configured" : "None"}</span>{canManage && <button type="button" className="row-link" onClick={() => { setNames(template.configuration.organization_secret_names || []); setEditing(true); }}>Configure</button>}
    {editing && <Dialog className="modal-dialog resource-dialog blueprint-secrets-dialog" labelledBy={titleId} busy={busy} onClose={() => setEditing(false)}><div className="modal-header"><div><h2 id={titleId}>Configure secrets</h2><p>{template.name}</p></div></div><fieldset className="resource-form" disabled={busy}><OrganizationSecretPicker value={names} onChange={setNames} />{error && <p className="form-alert form-alert-error" role="alert">{error}</p>}<div className="modal-actions"><button data-dialog-autofocus type="button" className="button button-secondary" onClick={() => setEditing(false)}>Cancel</button><button type="button" className="button button-primary" onClick={() => void save()}>{busy ? "Saving…" : "Save secrets"}</button></div></fieldset></Dialog>}</>;
}

function PreparedPreviewSetting({template}: {template: Template}) {
  const [value,setValue]=useState<{enabled:boolean;status:string;can_manage:boolean;environment_id?:string;error?:string} | null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  useEffect(()=>{let alive=true; const read=()=>api<NonNullable<typeof value>>(`/api/environment-templates/${template.id}/prepared-preview`).then(data=>{if(alive)setValue(data);}).catch(err=>{if(alive)setError(err.message);}); void read(); const timer=setInterval(()=>void read(),15000); return()=>{alive=false;clearInterval(timer);};},[template.id]);
  async function change(enabled:boolean) {
    setBusy(true);setError("");
    try { await api(`/api/environment-templates/${template.id}/prepared-preview`,{method:"PUT",body:JSON.stringify({enabled})});setValue(current=>current?{...current,enabled,status:enabled?"preparing":"off"}:current); }
    catch(err){setError(err instanceof Error?err.message:"Could not save setting");} finally{setBusy(false);}
  }
  const labels:Record<string,string>={preparing:"Preparing a preview",waiting:"Waiting to start",failed:"Preparation failed"};
  const statusLabel=value ? labels[value.status] : undefined;
  return <div className="blueprint-preview-setting"><label><input type="checkbox" role="switch" aria-label="Keep a preview ready" checked={value?.enabled || false} disabled={busy || !value?.can_manage} onChange={event=>void change(event.target.checked)} /><span><strong>Keep a preview ready</strong></span></label>
    {value?.enabled && statusLabel && <p role="status">{statusLabel}</p>}
    {(error || value?.error) && <p className="form-alert form-alert-error" role="alert">{error || value?.error}</p>}
  </div>;
}
