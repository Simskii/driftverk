import { useEffect, useRef, useState } from "react";
import { ArrowSquareOut, CircleNotch, Desktop as DesktopIcon } from "@phosphor-icons/react";
import { api, type Environment } from "./api";
import "./desktop.css";

type Startup = { pending: boolean; ready: boolean; error: string | null };

export function Desktop({ environment }: { environment: Environment }) {
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const [connected, setConnected] = useState(false);
  const [slow, setSlow] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const request = useRef<AbortController | null>(null);
  const unavailable = !environment.preview_enabled ? "Enable HTTP preview in Settings to use the desktop."
    : environment.state !== "running" ? "Start the environment to use its desktop."
    : environment.active_operation ? "Wait for the current environment operation to finish." : "";

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (unavailable) { request.current?.abort(); setUrl(""); setBusy(false); }
  }, [unavailable]);
  useEffect(() => {
    setConnected(false); setSlow(false);
    if (!url) return;
    const origin = new URL(url).origin;
    const receive = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow || event.data?.type !== "driftverk-desktop") return;
      setConnected(event.data.connected === true);
    };
    window.addEventListener("message", receive);
    const timer = window.setTimeout(() => setSlow(true), 15000);
    return () => { window.removeEventListener("message", receive); window.clearTimeout(timer); };
  }, [url]);

  async function open(stop = false) {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]);
    setBusy(true); setStopping(stop); setError("");
    if (!stop) setUrl("");
    try {
      const base = `/api/environments/${encodeURIComponent(environment.id)}`;
      const result = await api<{ execution_id: string }>(`${base}/desktop?action=${stop ? "stop" : "start"}`, { method: "POST", signal });
      while (true) {
        const state = await api<Startup>(`${base}/desktop?execution=${encodeURIComponent(result.execution_id)}`, { signal });
        if (!state.pending) {
          if (!state.ready) throw new Error(state.error || "The desktop could not start.");
          break;
        }
        await new Promise<void>((resolve, reject) => {
          const abort = () => { window.clearTimeout(timer); reject(signal.reason); };
          const timer = window.setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1000);
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      }
      if (stop) { setUrl(""); return; }
      const preview = await api<{ url: string }>(`${base}/ports/6080/preview`, { method: "POST", signal });
      const viewer = new URL(preview.url);
      if (!["https:", "http:"].includes(viewer.protocol)) throw new Error("Invalid desktop URL");
      viewer.searchParams.set("view", "desktop");
      setUrl(viewer.href);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not open the desktop.");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  return <div className="desktop-panel">
    <div className="desktop-actions">
      <div><strong>Shared desktop</strong><p>{url ? "Use Take control in the viewer to interact. Agents keep running." : "Watch your agent and use the same browser, mouse and keyboard."}</p></div>
      <div className="desktop-buttons">
        {url && <a className="button button-secondary" href={url} target="_blank" rel="noopener noreferrer">Open in new tab <ArrowSquareOut /></a>}
        <button className="button button-secondary" disabled={busy || environment.state !== "running" || Boolean(environment.active_operation)} onClick={() => void open(true)}>Stop desktop</button>
        <button className="button button-primary" disabled={busy || Boolean(unavailable)} onClick={() => void open()}>{busy ? <CircleNotch className="spin" /> : <DesktopIcon />}{busy ? stopping ? "Stopping desktop…" : "Starting desktop…" : url ? "Reconnect" : "Open desktop"}</button>
      </div>
    </div>
    {unavailable && <p className="desktop-notice" role="status">{unavailable}</p>}
    {error && <p className="form-alert form-alert-error" role="alert">{error}</p>}
    {url ? <>
      {!connected && slow && <p className="desktop-notice" role="status">If the viewer cannot connect here, open it in a new tab. Your browser may block embedded preview cookies. Reconnect to refresh an expired link.</p>}
      <iframe ref={frame} src={url} title="Environment desktop" className="desktop-frame" allow="fullscreen" sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />
    </> : !busy && !error && <div className="desktop-empty"><DesktopIcon size={38} /><p>Included in new Driftverk Dev images.</p><p>The desktop stops after five minutes without viewers or an active prompt.</p></div>}
  </div>;
}
