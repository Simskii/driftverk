import { CaretDown, UploadSimple, X } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Dialog } from "./Dialog";
import { parseEnvImport, type ImportedVariable } from "./env-import";

export function ActionDropdown({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  return <details ref={ref} className={`action-menu ${className}`} onKeyDown={(event) => {
    if (event.key === "Escape" && ref.current) { ref.current.open = false; ref.current.querySelector("summary")?.focus(); }
  }}>
    <summary className="button button-secondary">{label}<CaretDown /></summary>
    <div className="action-menu-popover" onClick={(event) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".copy-action") && target.closest("button:not(:disabled), a") && ref.current) ref.current.open = false;
    }}>{children}</div>
  </details>;
}

export function AdvancedSection({ title, summary, children, warning, icon }: { title: string; summary: string; children: ReactNode; warning?: string; icon?: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  return <details className="advanced-section">
    <summary aria-label={[title, summary, warning].filter(Boolean).join(". ")} onClick={(event) => {
      const details = event.currentTarget.parentElement as HTMLDetailsElement;
      if (!details.closest(".create-environment-modal")) return;
      event.preventDefault();
      content.current?.getAnimations().forEach(animation => animation.cancel());
      const animate = event.detail > 0 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      details.dataset.animate = String(animate);
      details.open = !details.open;
      if (details.open && animate) content.current?.animate(
        [{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "translateY(0)" }],
        { duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    }}>{icon && <span className="advanced-section-icon" aria-hidden="true">{icon}</span>}<span><strong>{title}</strong><small>{summary}</small>{warning && <small className="configuration-warning">{warning}</small>}</span><CaretDown /></summary>
    <div ref={content} className="advanced-section-content" onInvalidCapture={(event) => { event.currentTarget.closest("details")!.open = true; }}>{children}</div>
  </details>;
}

export function DurationField({ label, value, onChange, disabled = false }: { label: string; value: number | ""; onChange: (value: number | "") => void; disabled?: boolean }) {
  const presets: [number | "", string][] = [["", "Disabled"], [15, "15 minutes"], [30, "30 minutes"], [60, "1 hour"], [240, "4 hours"], [1440, "1 day"], [10080, "7 days"]];
  const [custom, setCustom] = useState(!presets.some(([minutes]) => minutes === value));
  const [unit, setUnit] = useState(1);
  return <div className="field duration-field">
    <label><span>{label}</span><select disabled={disabled} value={custom ? "custom" : String(value)} onChange={(event) => {
      const next = event.target.value;
      setCustom(next === "custom");
      if (next !== "custom") onChange(next === "" ? "" : Number(next));
      else {
        setUnit(value !== "" && value % 1440 === 0 ? 1440 : value !== "" && value % 60 === 0 ? 60 : 1);
        if (value === "") onChange(15);
      }
    }}>{presets.map(([minutes, text]) => <option key={String(minutes)} value={minutes}>{text}</option>)}<option value="custom">Custom duration</option></select></label>
    {custom && <div className="duration-custom"><input disabled={disabled} aria-label={`${label} amount`} type="number" min="1" max={Math.floor(525600 / unit)} step="1" required value={value === "" ? "" : value / unit} onChange={(event) => onChange(event.target.value ? Number(event.target.value) * unit : "")} /><select disabled={disabled} aria-label={`${label} unit`} value={unit} onChange={(event) => {
      const next = Number(event.target.value);
      if (value !== "") onChange(Math.min(Math.floor(525600 / next), Math.max(1, Math.round(value / unit))) * next);
      setUnit(next);
    }}><option value="1">minutes</option><option value="60">hours</option><option value="1440">days</option></select></div>}
  </div>;
}

export function EnvImport({ existingNames, onImport }: { existingNames: string[]; onImport: (variables: ImportedVariable[]) => void }) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("");
  const [fileError, setFileError] = useState("");
  const [replace, setReplace] = useState(false);
  const [notice, setNotice] = useState("");
  const result = parseEnvImport(source);
  const conflicts = result.variables.filter((variable) => existingNames.includes(variable.name));
  const exceedsLimit = new Set([...existingNames.filter(Boolean), ...result.variables.map((variable) => variable.name)]).size > 25;
  const fileRead = useRef(0);
  const titleId = useId();
  const close = () => { fileRead.current++; setOpen(false); setSource(""); setFileError(""); setReplace(false); };
  return <div className="env-import">
    <button type="button" className="button button-secondary" onClick={() => { setNotice(""); setOpen(true); }}><UploadSimple /> Import .env</button>
    {notice && <p role="status">{notice}</p>}
    {open && <Dialog className="env-import-dialog" labelledBy={titleId} onClose={close}>
      <div className="modal-header"><div><h2 id={titleId}>Import environment variables</h2><p>Review the variable names before adding them.</p></div><button type="button" className="icon-button" aria-label="Close import" onClick={close}><X /></button></div>
      <div className="env-import-body">
        <label className="field"><span>Choose a .env file</span><input type="file" onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          const readId = ++fileRead.current;
          setReplace(false); setFileError(""); setSource("");
          if (file.size > 1_048_576) { setFileError("Use a file smaller than 1 MB."); return; }
          try { const text = await file.text(); if (readId === fileRead.current) setSource(text); } catch { if (readId === fileRead.current) setFileError("Could not read this file."); }
        }} /></label>
        <label className="field"><span>Or paste .env contents</span><textarea autoComplete="off" spellCheck={false} value={source} placeholder={'API_URL=https://example.test\nAPP_MODE=development'} onChange={(event) => { fileRead.current++; setSource(event.target.value); setFileError(""); setReplace(false); }} /></label>
        <p className="subtle">Values stay in this form until you save. Variable references and shell expressions are kept literally.</p>
        <div aria-live="polite">
          {fileError && <p className="form-alert form-alert-error">{fileError}</p>}
          {exceedsLimit && <p className="form-alert form-alert-error">Use at most 25 environment variables, including existing variables.</p>}
          {result.errors.length > 0 && <ul className="import-errors">{result.errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}
          {result.variables.length > 0 && <><h3>{result.variables.length} variables found</h3><ul className="import-names">{result.variables.map((variable) => <li key={variable.name}><code>{variable.name}</code><span>{existingNames.includes(variable.name) ? "Replaces existing value" : "New variable"}</span></li>)}</ul></>}
        </div>
        {conflicts.length > 0 && <label className="check-field"><input type="checkbox" role="switch" checked={replace} onChange={(event) => setReplace(event.target.checked)} /><span>Replace {conflicts.length} existing value{conflicts.length === 1 ? "" : "s"}</span></label>}
        <div className="modal-actions"><button type="button" className="button button-secondary" onClick={close}>Cancel</button><button type="button" className="button button-primary" disabled={Boolean(fileError) || exceedsLimit || result.errors.length > 0 || result.variables.length === 0 || (conflicts.length > 0 && !replace)} onClick={() => {
          onImport(result.variables); setNotice(`${result.variables.length} variables added to the form.`); close();
        }}>Add to form</button></div>
      </div>
    </Dialog>}
  </div>;
}
