import { useEffect, useState } from "react";
import { Check } from "@phosphor-icons/react";
import { api } from "./api";
import type { AgentProfile } from "./Agents";

type Login = { user_code: string; verification_url: string; expires_at: string };

export function ChatGPTConnection({ agent, onSaved }: { agent: AgentProfile; onSaved: () => Promise<void> }) {
  const [login, setLogin] = useState<Login | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [isDefault, setDefault] = useState(agent.is_default && agent.default_auth_method === "subscription");
  useEffect(() => { setDefault(agent.is_default && agent.default_auth_method === "subscription"); }, [agent.is_default, agent.default_auth_method]);
  useEffect(() => {
    if (!login) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        if (Date.now() >= new Date(login!.expires_at).getTime()) throw new Error("Sign-in expired. Try again.");
        const result = await api<{ status: string }>("/api/agents/codex/connection");
        if (cancelled) return;
        if (result.status === "connected") { setLogin(null); await onSaved(); return; }
        if (result.status !== "pending") throw new Error("Sign-in ended. Try again.");
        timeout = setTimeout(() => void poll(), 2000);
      } catch (caught) {
        if (!cancelled) { setLogin(null); setError(caught instanceof Error ? caught.message : "Could not check sign-in"); }
      }
    }
    timeout = setTimeout(() => void poll(), 1500);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [login]);

  async function act(action: "connect" | "disconnect" | "save") {
    setBusy(true); setError("");
    try {
      if (action === "connect") setLogin(await api<Login>("/api/agents/codex/connection", { method: "POST", body: "{}" }));
      else {
        await api("/api/agents/codex/connection", { method: action === "save" ? "PUT" : "DELETE", body: JSON.stringify(action === "save" ? { is_default: isDefault, model: null } : {}) });
        setLogin(null); await onSaved();
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not update connection"); }
    finally { setBusy(false); }
  }

  return <div className="agent-subscription">
    {agent.subscription_connected ? <>
      <p className="agent-notice"><Check /> ChatGPT connected</p>
      <form onSubmit={event => { event.preventDefault(); void act("save"); }}>
        <fieldset disabled={busy}>
          <label className="agent-default-toggle"><input type="checkbox" checked={isDefault} onChange={event => setDefault(event.target.checked)} /><span>Use by default in new environments</span></label>
          <div className="agent-actions"><button className="button button-primary" type="submit">Save</button><button className="button button-secondary" type="button" onClick={() => void act("disconnect")}>Disconnect</button></div>
        </fieldset>
      </form>
    </> : login ? <div className="agent-device-login" role="status">
      <p>Enter this code on OpenAI’s sign-in page.</p>
      <code className="agent-device-code">{login.user_code}</code>
      <div className="agent-actions"><a className="button button-primary" href={login.verification_url} target="_blank" rel="noopener noreferrer">Open OpenAI</a><button className="button button-secondary" disabled={busy} onClick={() => void act("disconnect")}>Cancel</button></div>
      <p className="subtle">Waiting for sign-in…</p>
    </div> : <>
      <button className="button button-primary" disabled={busy} onClick={() => void act("connect")}>{busy ? "Connecting…" : "Connect ChatGPT"}</button>
      <p className="subtle">Your account, available in your new environments.</p>
    </>}
    {error && <p role="alert" className="form-alert form-alert-error">{error}</p>}
  </div>;
}
