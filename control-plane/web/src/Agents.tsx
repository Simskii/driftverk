import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { CaretDown, Check, Star, ArrowRight, Robot } from "@phosphor-icons/react";
import { api } from "./api";
import { ChatGPTConnection } from "./ChatGPTConnection";
import { LoadError } from "./LoadError";
import "./agents.css";

export type AgentId = "codex" | "claude";
export type AgentProfile = { id: AgentId; name: string; model: string | null; connected: boolean; api_key_is_default: boolean; is_default: boolean; subscription_connected: boolean; subscription_model: string | null; default_auth_method: "subscription" | "api_key" };
export type AgentsPayload = { agents: AgentProfile[]; can_manage: boolean };
export const agentName = (id: AgentId) => id === "codex" ? "Codex" : "Claude Code";

export function AgentsPage() {
  const [data, setData] = useState<AgentsPayload | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<AgentId | null>(null);
  async function load() {
    try { setData(await api<AgentsPayload>("/api/agents")); setError(""); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not load agents"); }
  }
  useEffect(() => { void load(); }, []);
  return <div className="page agents-page">
    <header className="page-header"><div><h1>Agents</h1></div></header>
    {error && <LoadError message={error} onRetry={() => void load()} />}
    {!data && !error && <p role="status">Loading agents…</p>}
    {data && <>
      <div className="agent-list">
        {data.agents.map(agent => <AgentCard key={agent.id} agent={agent} canManage={data.can_manage} expanded={expanded === agent.id} onExpand={() => setExpanded(expanded === agent.id ? null : agent.id)} onSaved={load} />)}
      </div>
      <div className="agents-next"><Link className="button button-primary" to="/environments/new">Create environment <ArrowRight /></Link></div>
    </>}
  </div>;
}

function AgentCard({ agent, canManage, expanded, onExpand, onSaved }: { agent: AgentProfile; canManage: boolean; expanded: boolean; onExpand: () => void; onSaved: () => Promise<void> }) {
  const [key, setKey] = useState("");
  const [model, setModel] = useState(agent.model || "");
  const [customModel, setCustomModel] = useState(Boolean(agent.model));
  const [isDefault, setDefault] = useState(agent.api_key_is_default);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [authMethod, setAuthMethod] = useState<"subscription" | "api_key">(agent.subscription_connected ? "subscription" : agent.connected ? "api_key" : "subscription");
  useEffect(() => { setModel(agent.model || ""); setCustomModel(Boolean(agent.model)); setDefault(agent.api_key_is_default); }, [agent.model, agent.api_key_is_default]);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      await api(`/api/agents/${agent.id}`, { method: "PUT", body: JSON.stringify({ model: customModel ? model : null, is_default: isDefault, ...(key ? { api_key: key } : {}) }) });
      setKey(""); await onSaved(); setNotice("Saved. Ready to use in new environments.");
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save agent"); }
    finally { setBusy(false); }
  }
  async function testConnection() {
    setBusy(true); setError(""); setNotice("");
    try { const result = await api<{ message: string }>(`/api/agents/${agent.id}/test`, { method: "POST", body: "{}" }); setNotice(result.message); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not verify connection"); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    setBusy(true); setError(""); setNotice("");
    try { await api(`/api/agents/${agent.id}`, { method: "DELETE" }); setKey(""); setConfirmDisconnect(false); await onSaved(); setNotice("Disconnected for new environments. Existing environments keep their credentials."); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not disconnect agent"); }
    finally { setBusy(false); }
  }
  return <section className={`coding-agent-card${expanded ? " expanded" : ""}`}>
    <button type="button" className="agent-summary" aria-expanded={expanded} aria-controls={`agent-${agent.id}`} onClick={onExpand}>
      <span className="agent-mark" aria-hidden="true"><Robot size={24} /></span>
      <span className="agent-summary-copy"><strong>{agent.name}</strong><span className={agent.connected || agent.subscription_connected ? "agent-connected" : ""}>{agent.subscription_connected ? <><Check /> ChatGPT connected</> : agent.connected ? <><Check /> API key saved{agent.model ? ` · ${agent.model}` : ""}</> : "Sign in with your subscription"}</span></span>
      {agent.is_default && <span className="agent-default"><Star weight="fill" /> Default</span>}<CaretDown className="agent-chevron" />
    </button>
    <div id={`agent-${agent.id}`} className="agent-body" hidden={!expanded}>
      <div className="agent-auth-choices" role="group" aria-label={`${agent.name} authentication`}>
        <button type="button" className="button button-secondary" aria-pressed={authMethod === "subscription"} onClick={() => setAuthMethod("subscription")}>Subscription</button>
        <button type="button" className="button button-secondary" aria-pressed={authMethod === "api_key"} onClick={() => setAuthMethod("api_key")}>API key</button>
      </div>
      {authMethod === "subscription" ? agent.id === "codex" ? <ChatGPTConnection agent={agent} onSaved={onSaved} /> : <div className="agent-subscription"><h3>Use your Claude subscription</h3><p>Start an environment with {agent.name}, then complete the provider's sign-in in the agent pane. Your login stays in that environment.</p><Link className="button button-primary" to={`/environments/new?agent=${agent.id}`}>Set up {agent.name} <ArrowRight /></Link><p className="subtle">People with terminal access to that environment can use its signed-in account. Use an environment you trust.</p></div> : <>
      <form onSubmit={save}>
        <fieldset disabled={busy || !canManage}>
          <label className="field"><span>{agent.id === "codex" ? "OpenAI" : "Anthropic"} API key {agent.connected && <small>Saved</small>}</span><input type="password" autoComplete="new-password" spellCheck={false} aria-label={`${agent.name} API key`} value={key} onChange={event => { setKey(event.target.value); setNotice(""); }} required={!agent.connected} maxLength={4096} placeholder={agent.connected ? "Enter a new key to replace the saved key" : "Paste your API key"} /></label>
          <label className="field"><span>Default model</span><select aria-label={`${agent.name} model selection`} value={customModel ? "custom" : ""} onChange={event => setCustomModel(event.target.value === "custom")}><option value="">Agent default</option><option value="custom">Choose a model</option></select></label>
          {customModel && <label className="field"><span>Model ID</span><input aria-label={`${agent.name} model ID`} value={model} onChange={event => setModel(event.target.value)} required maxLength={128} placeholder={agent.id === "claude" ? "sonnet, opus, or a full model ID" : "Enter an OpenAI model ID"} /><small>Use a model available to your API key.</small></label>}
          <label className="agent-default-toggle"><input type="checkbox" checked={isDefault} onChange={event => setDefault(event.target.checked)} /><span>Use as the organization default</span></label>
          <div className="agent-actions"><button className="button button-primary" type="submit">{busy ? "Working…" : agent.connected ? "Save changes" : "Connect agent"}</button>{agent.connected && <button type="button" className="button button-secondary" disabled={Boolean(key)} onClick={() => void testConnection()}>Test connection</button>}{agent.connected && <button type="button" className="button button-quiet" onClick={() => setConfirmDisconnect(!confirmDisconnect)}>Disconnect</button>}</div>
        </fieldset>
      </form>
      {confirmDisconnect && <div className="agent-disconnect"><p>Remove the saved organization API key? Other setups using this key will need a replacement. Existing environments keep their copies; revoke the key with the provider to stop all use.</p><div className="agent-actions"><button className="button button-secondary" disabled={busy} onClick={() => void disconnect()}>Remove saved key</button><button className="button button-quiet" disabled={busy} onClick={() => setConfirmDisconnect(false)}>Cancel</button></div></div>}
      {error && <p role="alert" className="form-alert form-alert-error">{error}</p>}
      {notice && <p role="status" className="agent-notice">{notice}</p>}
      <p className="subtle agent-auth-note">Billed through your provider’s API account.</p>
      </>}
    </div>
  </section>;
}

export function AgentPicker({ agents, value, onChange, authMethod, onAuthMethod }: { agents: AgentProfile[]; value: AgentId | ""; onChange: (id: AgentId | "") => void; authMethod: "subscription" | "api_key"; onAuthMethod: (method: "subscription" | "api_key") => void }) {
  const selected = agents.find(agent => agent.id === value);
  return <div className="agent-picker"><label className="field"><span>Agent <Link to="/agents">Manage agents</Link></span><select value={value} onChange={event => onChange(event.target.value as AgentId | "")}><option value="">None</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}{agent.is_default ? " · Default" : ""}</option>)}</select></label>{value && <><label className="field"><span>Sign in with</span><select value={authMethod} onChange={event => onAuthMethod(event.target.value as "subscription" | "api_key")}><option value="subscription">My subscription{selected?.id === "codex" && !selected.subscription_connected ? " · Not connected" : ""}</option><option value="api_key" disabled={!selected?.connected}>Organization API key{!selected?.connected ? " · Not connected" : ""}</option></select></label><p className="subtle">{authMethod === "subscription" ? selected?.id === "codex" ? selected.subscription_connected ? "Uses your connected ChatGPT account." : <> <Link to="/agents">Connect ChatGPT</Link> to continue.</> : "Complete sign-in when the agent opens." : selected?.connected ? `${selected.name} will use the organization API key${selected.model ? ` and ${selected.model}` : ""}.` : "Connect an organization API key or choose your subscription."}</p></>}</div>;
}
