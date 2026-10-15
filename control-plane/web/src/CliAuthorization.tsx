import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "./api";
import { CheckCircle, TerminalWindow, UserCircle } from "@phosphor-icons/react";
import "./cli-authorization.css";

export function CliAuthorization({ email }: { email: string }) {
  const location = useLocation();
  const [code, setCode] = useState(new URLSearchParams(location.search).get("user_code") || "");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  useEffect(() => {
    if (new URLSearchParams(location.search).get("user_code")) void submit("review");
  }, []);

  async function submit(action: "review" | "approve" | "deny") {
    setBusy(true);
    setError("");
    try {
      if (action === "review") {
        const request = await api<{ status: string; client_id?: string }>("/api/auth/device?user_code=" + encodeURIComponent(code));
        if (request.status !== "pending" || request.client_id !== "driftverk-cli") throw new Error("This code is unavailable. Run driftverk login again.");
        setReviewed(true);
      } else {
        await api("/api/auth/device/" + action, { method: "POST", body: JSON.stringify({ userCode: code }) });
        setResult(action === "approve" ? "CLI connected. Return to your terminal." : "Request denied. You can close this tab.");
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not connect the CLI.";
      setError(["invalid_request", "expired_token"].includes(message)
        ? "This code is invalid or expired. Run driftverk login again." : message);
    } finally {
      setBusy(false);
    }
  }

  return <main className="cli-authorization">
    <header className="cli-brand"><img src="/driftverk-logo.svg?v=brand-1" alt="Driftverk" /></header>
    <div className="cli-authorization-content">
    <aside className="cli-introduction">
      <p className="eyebrow">From your terminal</p>
      <h2>Your environments.<br />One command away.</h2>
      <p>Create environments, connect over SSH, and keep working with your agents.</p>
      <img src="/illustrations/inspect-environment.svg?v=brand-1" alt="" />
    </aside>
    <section className="cli-connect-card" aria-labelledby="cli-title">
      <div className="cli-connect-icon" aria-hidden="true">{result ? <CheckCircle size={28} /> : <TerminalWindow size={28} />}</div>
      <p className="eyebrow">Driftverk CLI</p>
      <h1 id="cli-title">{result ? result.startsWith("CLI connected") ? "You're connected" : "Request denied" : "Connect your terminal"}</h1>
      {result ? <p className="cli-result" role="status">{result}</p> : <>
        <p className="cli-connect-description">Check that the code below matches your terminal. Only approve a login you started.</p>
        <div className="cli-account"><UserCircle size={24} aria-hidden="true" /><div><span>Signed in as</span><strong>{email}</strong></div></div>
        <form onSubmit={event => { event.preventDefault(); void submit(reviewed ? "approve" : "review"); }}>
          <label className="field cli-code"><span>Terminal code</span><input required autoComplete="off" autoCapitalize="characters" spellCheck={false} value={code} readOnly={reviewed} onChange={event => setCode(event.target.value)} /></label>
          {reviewed && <p className="muted">The CLI will use your account permissions to manage organizations and environments.</p>}
          {error && <p className="form-alert form-alert-error" role="alert">{error}</p>}
          <div className="cli-connect-actions"><button className="button button-primary" disabled={busy} type="submit">{busy ? "Connecting…" : reviewed ? "Confirm code and sign in" : "Continue"}</button>
          {reviewed && <button className="button button-secondary" disabled={busy} type="button" onClick={() => void submit("deny")}>Deny</button>}
          </div>
        </form>
      </>}
    </section>
    </div>
  </main>;
}
