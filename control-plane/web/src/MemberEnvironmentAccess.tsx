import { useEffect, useState } from "react";
import { api } from "./api";

type AccessRow = { id: string; name: string; email?: string; role?: string; has_access: boolean };

export function MemberEnvironmentAccess({ environmentId, memberId }: { environmentId?: string; memberId?: string }) {
  const [rows, setRows] = useState<AccessRow[] | null>(null);
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setRows(null); setError("");
    const path = environmentId ? `/api/environments/${encodeURIComponent(environmentId)}/members` : `/api/team/${encodeURIComponent(memberId!)}/environments`;
    api<{ members?: AccessRow[]; environments?: AccessRow[]; role?: string }>(path).then(data => {
      if (!cancelled) { setRows(data.members ?? data.environments ?? []); setAdmin(data.role === "admin" || data.role === "owner"); }
    }).catch(caught => { if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load access."); });
    return () => { cancelled = true; };
  }, [environmentId, memberId, revision]);

  async function toggle(row: AccessRow, hasAccess: boolean) {
    setBusy(row.id); setError("");
    try {
      await api(`/api/environments/${encodeURIComponent(environmentId ?? row.id)}/members/${encodeURIComponent(memberId ?? row.id)}`, {
        method: "PUT", body: JSON.stringify({ has_access: hasAccess }),
      });
      setRows(current => current?.map(value => value.id === row.id ? { ...value, has_access: hasAccess } : value) ?? null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not update access."); }
    finally { setBusy(null); }
  }

  return <section className="overview-section">
    <h2>{environmentId ? "Members" : "Environment access"}</h2>
    {!rows && !error && <p role="status">Loading access…</p>}
    {rows?.length === 0 && <p className="subtle">{environmentId ? "No members yet." : "No environments yet."}</p>}
    <div className="environment-member-list">{rows?.map(row => {
      const automatic = admin || row.role === "admin" || row.role === "owner";
      return <label className="setting-toggle" key={row.id}>
        <input type="checkbox" checked={row.has_access} disabled={Boolean(busy) || automatic} onChange={event => void toggle(row, event.target.checked)} />
        <span><strong>{row.name || row.email}</strong><small>{automatic ? "Admin" : row.email}</small></span>
      </label>;
    })}</div>
    {error && <div className="form-alert form-alert-error" role="alert">{error}{!rows && <button type="button" className="button button-secondary" onClick={() => setRevision(value => value + 1)}>Retry</button>}</div>}
  </section>;
}
