import { Desktop } from "./Desktop";
import { MemberCreationPolicy, MemberEnvironmentForm, type MemberSettings } from "./MemberSelfService";
import { AgentsPage, AgentPicker, agentName, type AgentsPayload, type AgentProfile, type AgentId } from "./Agents";
import { CliAuthorization } from "./CliAuthorization";
import { OrganizationSecrets, OrganizationSecretPicker } from "./OrganizationSecrets";
import { defaultPreviewPort } from "./preview-port";
import previewLoadingHtml from "./preview-loading.html?raw";
import previewErrorHtml from "./preview-error.html?raw";
import previewLoadingStylesheet from "./preview-loading.css?url&no-inline";
import { InstallationContext, useInstallation, type Installation } from "./Installation";
import { exampleApp, exampleEditCommand, isExampleApp } from "./example-app";
import { BillingPage, CloudEstimate, CloudUsage, type Billing } from "./Billing";
import { RepositoryFields, ProjectCommands, ProjectSetupsPage, type TemplateConfiguration, type Prebuild } from "./DevelopmentFields";
import { HostsPage, HostingSettings, HostingChoice, hostConnected, EnvironmentHostHealth, type Host, type HostsData } from "./Hosts";
import {
  ArrowRight,
  BookOpen,
  CaretDown,
  Check,
  CircleNotch,
  Copy,
  Cpu,
  Database,
  ChartLine,
  GearSix,
  GitBranch,
  GlobeHemisphereWest,
  HardDrives,
  EnvelopeSimple,
  Blueprint,
  MagnifyingGlass,
  ImageSquare,
  Key,
  Lifebuoy,
  Pause,
  Play,
  Plus,
  SignOut,
  Stack,
  TerminalWindow,
  Robot,
  Trash,
  UserPlus,
  FloppyDisk,
  FolderOpen,
  UsersThree,
  WebhooksLogo,
  X,
} from "@phosphor-icons/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Component, lazy, Suspense, type ErrorInfo, type FormEvent, type ReactNode, startTransition, useEffect, useRef, useState } from "react";
import {
  Link,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { api, apiWhenReady, ApiError, type AdminOrganization, type DriftverkApiKey, type Environment, type EnvironmentTelemetry, type EnvironmentsPayload, type Registry, type Session, type Snapshot, type SshKey, type TeamPayload, type Volume, type WebhookEventType, type WebhooksPayload } from "./api";
import { EnvironmentAccess } from "./EnvironmentAccess";
const Docs = lazy(() => import("./Docs").then((module) => ({ default: module.Docs })));
import { ActionDropdown, AdvancedSection, DurationField, EnvImport } from "./EnvironmentControls";
import { mergeImportedVariables } from "./env-import";
import { Dialog } from "./Dialog";
import { LoadError } from "./LoadError";

type SessionState = Session | null | undefined;

function escapePreviewMarkup(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

type ConfirmationOptions = {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "danger" | "warning";
  icon?: ReactNode;
};

function ConfirmDialog({ options, onClose }: { options: ConfirmationOptions; onClose: (confirmed: boolean) => void }) {
  return <Dialog className="confirm-dialog" alert labelledBy="confirm-title" describedBy="confirm-description" onClose={() => onClose(false)}>
    <div className={`confirm-icon${options.tone === "warning" ? " confirm-icon-warning" : ""}`}>{options.icon ?? <Trash />}</div>
    <div className="confirm-copy"><h2 id="confirm-title">{options.title}</h2><p id="confirm-description">{options.description}</p></div>
    <div className="confirm-actions"><button autoFocus type="button" className="button button-secondary" onClick={() => onClose(false)}>Cancel</button><button type="button" className={`button ${options.tone === "warning" ? "button-primary" : "button-danger-solid"}`} onClick={() => onClose(true)}>{options.confirmLabel}</button></div>
  </Dialog>;
}

function useConfirmation(): [(options: ConfirmationOptions) => Promise<boolean>, ReactNode] {
  const [options, setOptions] = useState<ConfirmationOptions | null>(null);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);

  useEffect(() => () => resolver.current?.(false), []);

  function confirm(nextOptions: ConfirmationOptions) {
    return new Promise<boolean>((resolve) => {
      resolver.current?.(false);
      resolver.current = resolve;
      setOptions(nextOptions);
    });
  }

  function close(confirmed: boolean) {
    const resolve = resolver.current;
    resolver.current = null;
    setOptions(null);
    resolve?.(confirmed);
  }

  return [confirm, options ? <ConfirmDialog options={options} onClose={close} /> : null];
}

function SnapshotDialog({ defaultName, hasSecrets, busy, error, onClose, onSubmit }: { defaultName: string; hasSecrets: boolean; busy: boolean; error: string; onClose: () => void; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(defaultName);
  const [acknowledged, setAcknowledged] = useState(false);
  return <Dialog className="confirm-dialog snapshot-dialog" labelledBy="snapshot-dialog-title" busy={busy} onClose={onClose}>
    <div className="confirm-icon confirm-icon-warning"><FloppyDisk /></div>
    <div className="confirm-copy"><h2 id="snapshot-dialog-title">Create snapshot</h2><p>Save files, installed tools, startup commands, and preview settings for a new environment.</p></div>
    <form onSubmit={(event) => { event.preventDefault(); if (!hasSecrets || acknowledged) onSubmit(name); }}>
      <label className="field"><span>Snapshot name <small>Optional</small></span><input data-dialog-autofocus onFocus={event => event.currentTarget.select()} value={name} maxLength={63} pattern="[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?" onChange={(event) => setName(event.target.value)} /></label>
      <p className="subtle snapshot-contents">Running processes and mounted volume data are not saved. Configure variables and volumes when launching. Stop the environment before creating a snapshot.</p>
      {hasSecrets && <label className="setting-toggle snapshot-warning"><input type="checkbox" required checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /><span><strong>I have checked for secrets</strong><small>This environment has received variables. Their values may remain in saved files or container settings and be copied into future environments.</small></span></label>}
      {error && <div className="form-alert form-alert-error" role="alert">{error}</div>}
      <div className="confirm-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="button button-primary" disabled={busy || (hasSecrets && !acknowledged)}>{busy && <CircleNotch className="spin" />}{busy ? "Creating…" : "Create snapshot"}</button></div>
    </form>
  </Dialog>;
}

function Modal({ title, description, onClose, children, className = "", busy = false }: { title: string; description?: string; onClose: () => void; children: ReactNode; className?: string; busy?: boolean }) {
  return <Dialog className={`modal-dialog ${className}`} labelledBy="modal-title" describedBy={description ? "modal-description" : undefined} onClose={onClose} busy={busy}>
    <header className="modal-header"><div><h2 id="modal-title">{title}</h2>{description && <p id="modal-description">{description}</p>}</div><button type="button" className="icon-button" disabled={busy} onClick={onClose} aria-label="Close"><X /></button></header>
    {children}
  </Dialog>;
}

export function App() {
  const [installation, setInstallation] = useState<Installation | null>(null);
  const [installationError, setInstallationError] = useState("");
  useEffect(() => { api<Installation>("/api/config").then(setInstallation).catch(() => setInstallationError("Could not load installation settings.")); }, []);
  const location = useLocation();
  const [session, setSession] = useState<SessionState>(undefined);
  const navigate = useNavigate();

  async function refreshSession(destination?: string, error?: string) {
    const next = await api<Session | null>("/api/auth/get-session").catch(() => null);
    startTransition(() => {
      setSession(next);
      if (next && destination) navigate(destination, { replace: true, state: error ? { error } : null });
    });
    return next;
  }

  useEffect(() => {
    void refreshSession();
  }, []);

  if (session === undefined && !/^\/docs(?:\/|$)/.test(location.pathname)) return <LoadingScreen />;

  if (/^\/docs(?:\/|$)/.test(location.pathname)) return <Routes><Route path="/docs/*" element={<Suspense fallback={<LoadingScreen />}><Docs signedIn={Boolean(session)} /></Suspense>} /></Routes>;

  if (!installation) return installationError ? <LoadError message={installationError} onRetry={() => window.location.reload()} /> : <LoadingScreen />;

  return (
    <InstallationContext.Provider value={installation}><Routes>
      <Route path="/cli" element={session ? <CliAuthorization email={session.user.email} /> : <Navigate to={`/sign-in?redirect=${encodeURIComponent(location.pathname + location.search)}`} replace />} />
      <Route path="/sign-in" element={session ? <Navigate to="/environments" replace /> : <AuthPage mode="sign-in" onAuthenticated={refreshSession} />} />
      <Route path="/sign-up" element={session ? <Navigate to="/environments" replace /> : <AuthPage mode="sign-up" onAuthenticated={refreshSession} />} />
      <Route path="/forgot-password" element={<AuthPage mode="forgot-password" onAuthenticated={refreshSession} />} />
      <Route path="/reset-password" element={<AuthPage mode="reset-password" onAuthenticated={refreshSession} />} />
      <Route path="/oauth/consent" element={session ? <OAuthConsentPage /> : <OAuthConsentSignInRedirect />} />
      <Route path="/accept-invitation" element={session ? <AcceptInvitationPage /> : <InvitationSignInRedirect />} />
      <Route path="/connect" element={session ? <ComputeAgentConnectPage /> : <ComputeAgentConnectSignInRedirect />} />
      <Route path="/create-organization" element={session ? <CreateOrganizationPage /> : <Navigate to="/sign-in" replace />} />
      <Route path="/docs/*" element={<Suspense fallback={<LoadingScreen />}><Docs signedIn={Boolean(session)} /></Suspense>} />
      <Route element={session ? <Shell session={session} onSignOut={() => setSession(null)} /> : <Navigate to="/sign-in" replace />}>
        <Route index element={<Navigate to="/environments" replace />} />
        <Route path="/environments" element={<EnvironmentsPage />}>
          <Route path="example" element={<CreateExamplePage />} />
          <Route path="new" element={<CreateEnvironmentPage />} />
        </Route>
        <Route path="/environments/:id" element={<PageErrorBoundary><EnvironmentDetailPage /></PageErrorBoundary>} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/blueprints" element={<ProjectSetupsPage />} />
        <Route path="/project-setups" element={<Navigate to="/blueprints" replace />} />
        <Route path="/snapshots" element={<SnapshotsPage />} />
        <Route path="/volumes" element={<VolumesPage />}>
          <Route path="new" element={<CreateVolumePage />} />
        </Route>
        <Route path="/registries" element={<RegistriesPage />}>
          <Route path="new" element={<CreateRegistryPage />} />
        </Route>
        <Route path="/webhooks" element={<WebhooksPage />} />
        <Route path="/api-keys" element={<ApiKeysPage />} />
        <Route path="/team" element={<TeamPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/billing" element={<BillingPage />} />
        <Route path="/hosts" element={<HostsPage />} />
        <Route path="/admin/organizations" element={<AdminOrganizationsPage />} />
      </Route>
      <Route path="*" element={<Navigate to={session ? "/environments" : "/sign-in"} replace />} />
    </Routes></InstallationContext.Provider>
  );
}

function LoadingScreen() {
  return (
    <div className="loading-screen">
      <div className="loading-mark">D</div>
      <CircleNotch size={22} className="spin" aria-label="Loading" />
    </div>
  );
}

class PageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Environment detail render failed", error, info);
  }

  render() {
    if (this.state.error) return <Page><div className="form-alert form-alert-error">The environment view could not be rendered: {this.state.error.message}</div></Page>;
    return this.props.children;
  }
}

type AuthMode = "sign-in" | "sign-up" | "forgot-password" | "reset-password";

function AuthPage({ mode, onAuthenticated }: { mode: AuthMode; onAuthenticated: (destination?: string, error?: string) => Promise<Session | null> }) {
  const installation = useInstallation();
  const navigate = useNavigate();
  const location = useLocation();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [allowSignUp, setAllowSignUp] = useState(false);
  const [invitation, setInvitation] = useState<{ id: string; email: string; organization_name: string } | null>(null);
  const requestedRedirect = new URLSearchParams(location.search).get("redirect");
  const redirectTo = requestedRedirect?.startsWith("/") && !requestedRedirect.startsWith("//") ? requestedRedirect : "/environments";
  const invitationUrl = requestedRedirect?.startsWith("/accept-invitation?")
    ? new URL(requestedRedirect, window.location.origin) : null;
  const invitationToken = invitationUrl?.searchParams.get("token") ?? "";

  useEffect(() => {
    setError("");
    setMessage("");
    setInvitation(null);
    if (!invitationToken) return;
    let active = true;
    api<{ id: string; email: string; organization_name: string }>("/api/auth/invitation-preview", {
      headers: { "x-driftverk-invitation": invitationToken },
    }).then(value => { if (active) setInvitation(value); })
      .catch(caught => { if (active) setError(caught instanceof Error ? caught.message : "Could not load the invitation."); });
    return () => { active = false; };
  }, [invitationToken, mode]);

  useEffect(() => {
    api<{ allowSignUp: boolean }>("/api/config").then((value) => setAllowSignUp(value.allowSignUp)).catch(() => undefined);
  }, []);

  const copy = {
    "sign-in": ["Sign in", "", "Sign in"],
    "sign-up": ["Create account", "Create your first Driftverk account.", "Create account"],
    "forgot-password": ["Reset password", "We will send you a secure reset link.", "Send reset link"],
    "reset-password": ["Choose a new password", "Use at least 12 characters.", "Save password"],
  }[mode];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    let path = "";
    let body: Record<string, unknown> = {};
    if (mode === "sign-in") {
      path = "/api/auth/sign-in/email";
      body = { email: data.email, password: data.password, callbackURL: redirectTo };
    } else if (mode === "sign-up") {
      path = "/api/auth/sign-up/email";
      body = { name: data.name, email: data.email, password: data.password, callbackURL: redirectTo, acceptedTerms: data.acceptedTerms === "on", acceptedTermsVersion: installation.termsVersion };
    } else if (mode === "forgot-password") {
      path = "/api/auth/request-password-reset";
      body = { email: data.email, redirectTo: "/reset-password" };
    } else {
      const token = new URLSearchParams(window.location.search).get("token");
      if (!token) {
        setError("The reset link is missing its token.");
        setBusy(false);
        return;
      }
      path = "/api/auth/reset-password";
      body = { newPassword: data.password, token };
    }

    try {
      const oauthQuery = new URLSearchParams(location.search).has("sig")
        ? location.search.slice(1)
        : undefined;
      if (oauthQuery && (mode === "sign-in" || mode === "sign-up")) body.oauth_query = oauthQuery;
      const authResult = await api<{ url?: string; redirect_uri?: string }>(path, {
        method: "POST",
        body: JSON.stringify(body),
        ...(invitationToken ? { headers: { "x-driftverk-invitation": invitationToken } } : {}),
      });
      if (invitation && (mode === "sign-up" || mode === "sign-in")) {
        try {
          await api("/api/auth/organization/accept-invitation", {
            method: "POST", body: JSON.stringify({ invitationId: invitation.id }),
          });
        } catch (caught) {
          await onAuthenticated(redirectTo, caught instanceof Error ? caught.message : "Could not accept the invitation.");
          return;
        }
        await onAuthenticated("/team");
      } else if (mode === "sign-up") setMessage(installation.requireEmailVerification ? "Account created. Verify your email before signing in." : "Account created. You can sign in.");
      else if (mode === "forgot-password") setMessage("If the account exists, a reset link has been sent.");
      else if (mode === "reset-password") navigate("/sign-in?reset=1");
      else {
        const oauthRedirect = authResult?.redirect_uri || authResult?.url;
        if (oauthRedirect) {
          window.location.assign(oauthRedirect);
          return;
        }
        await onAuthenticated(redirectTo);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-layout auth-layout-simple">
      <section className="auth-form-panel">
        <form className="auth-card" onSubmit={submit}>
          <div className="auth-mobile-brand"><Brand /></div>
          {invitation && <p className="eyebrow">Team invitation</p>}
          <h2>{copy[0]}</h2>
          <p className="muted">{invitation ? `${mode === "sign-up" ? "Create an account" : "Sign in"} to join ${invitation.organization_name}. Your invitation verifies your email address.` : copy[1]}</p>
          {mode === "sign-up" && <Field label="Name" name="name" autoComplete="name" required />}
          {mode !== "reset-password" && <Field key={invitation?.email ?? "email"} label="Email" name="email" type="email" autoComplete="email" defaultValue={invitation?.email} readOnly={Boolean(invitationToken)} required />}
          {mode !== "forgot-password" && (
            <Field
              label={mode === "reset-password" ? "New password" : "Password"}
              name="password"
              type="password"
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              minLength={mode === "sign-in" ? undefined : 12}
              required
            />
          )}
          {mode === "sign-up" && installation.termsUrl && <div className="auth-legal">
            <label className="auth-terms-checkbox">
              <input type="checkbox" name="acceptedTerms" required />
              <span>I agree to the <a href={installation.termsUrl} target="_blank" rel="noreferrer">Terms of service</a>.</span>
            </label>
            {installation.privacyUrl && <p><a href={installation.privacyUrl} target="_blank" rel="noreferrer">Privacy policy</a></p>}
          </div>}
          {mode === "sign-up" && !installation.termsUrl && installation.privacyUrl && <p><a href={installation.privacyUrl} target="_blank" rel="noreferrer">Privacy policy</a></p>}
          {error && <div className="form-alert form-alert-error">{error}</div>}
          {message && <div className="form-alert form-alert-success">{message}</div>}
          <button className="button button-primary button-wide" disabled={busy || Boolean(invitationToken && !invitation)}>
            {busy && <CircleNotch size={18} className="spin" />}
            {invitation ? `${copy[2]} and join` : copy[2]}
          </button>
          <div className="auth-links">
            {mode === "sign-in" ? (
              <>
                <Link to="/forgot-password">Forgot password?</Link>
                {allowSignUp && <Link to={`/sign-up${location.search}`}>Create account</Link>}
              </>
            ) : (
              <Link to={`/sign-in${location.search}`}>Back to sign in</Link>
            )}
          </div>
        </form>
      </section>
    </main>
  );
}

function OAuthConsentSignInRedirect() {
  const location = useLocation();
  return <Navigate to={`/sign-in${location.search}`} replace />;
}

type OAuthConsentContext = {
  client_name: string;
  organization: { id: string; name: string };
  scopes: Array<{ id: string; label: string }>;
};

function OAuthConsentPage() {
  const location = useLocation();
  const [context, setContext] = useState<OAuthConsentContext | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<OAuthConsentContext>(`/api/oauth/consent-context${location.search}`)
      .then(setContext)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load connection details."));
  }, [location.search]);

  async function decide(accept: boolean) {
    setBusy(true);
    setError("");
    try {
      const response = await api<{ redirect_uri?: string; url?: string }>("/api/auth/oauth2/consent", {
        method: "POST",
        body: JSON.stringify({ accept, oauth_query: location.search.slice(1) }),
      });
      const redirect = response.redirect_uri || response.url;
      if (!redirect) throw new Error("The authorization server did not return a redirect URL");
      window.location.assign(redirect);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not complete the connection.");
      setBusy(false);
    }
  }

  return <main className="auth-layout oauth-consent-layout">
    <section className="auth-brand-panel">
      <Brand />
      <div><p className="eyebrow eyebrow-light">Connect an AI client</p><h1>Keep each environment inside the right workspace.</h1></div>
      <span className="auth-footnote">Driftverk control plane</span>
    </section>
    <section className="auth-form-panel">
      <section className="auth-card oauth-consent-card">
        <p className="eyebrow">Authorization</p>
        <h2>Connect {context?.client_name || "AI client"}?</h2>
        <p className="muted">It will act in <strong>{context?.organization.name || "your Driftverk workspace"}</strong>.</p>
        {context && <ul className="oauth-scope-list">{context.scopes.map((scope) => <li key={scope.id}><Check /><span>{scope.label}</span></li>)}</ul>}
        {error && <div className="form-alert form-alert-error">{error}</div>}
        <div className="oauth-consent-actions">
          <button className="button button-secondary" type="button" disabled={busy} onClick={() => void decide(false)}>Cancel</button>
          <button className="button button-primary" type="button" disabled={busy || !context} onClick={() => void decide(true)}>{busy && <CircleNotch className="spin" />}Connect</button>
        </div>
      </section>
    </section>
  </main>;
}

function InvitationSignInRedirect() {
  const location = useLocation();
  const path = new URLSearchParams(location.search).has("token") ? "/sign-up" : "/sign-in";
  return <Navigate to={`${path}?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`} replace />;
}

function ComputeAgentConnectSignInRedirect() {
  const location = useLocation();
  return <Navigate to={`/sign-in?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`} replace />;
}

function CreateOrganizationPage() {
  const selfHosted = useInstallation().installationMode === "self-hosted";
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [hostingMode, setHostingMode] = useState<"managed" | "hybrid">("hybrid");
  const [step, setStep] = useState(1);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;
    if (step === 1 && !selfHosted) { setStep(2); return; }
    setBusy(true);
    setError("");
    const slug = trimmedName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "workspace";
    try {
      await api("/api/auth/organization/create", {
        method: "POST",
        body: JSON.stringify({ name: trimmedName, slug: `${slug}-${crypto.randomUUID().slice(0, 8)}`, hostingMode }),
      });
      navigate(hostingMode === "managed" ? "/environments" : "/hosts?welcome=1", { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the organization.");
    } finally {
      setBusy(false);
    }
  }

  if (selfHosted) return <main className="auth-layout auth-layout-simple"><section className="auth-form-panel"><form className="auth-card" onSubmit={create}>
    <div className="auth-mobile-brand"><Brand /></div><h2>Create organization</h2>
    <Field label="Organization name" name="organization-name" value={name} onChange={event => setName(event.target.value)} autoComplete="organization" required />
    {error && <p className="form-alert form-alert-error" role="alert">{error}</p>}
    <button className="button button-primary button-wide" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create organization"}</button>
  </form></section></main>;

  return <main className="auth-layout">
    <section className="auth-brand-panel"><Brand /><div><p className="eyebrow eyebrow-light">Your Driftverk workspace</p><h1>Set up your organization.</h1><p>Use an organization to keep environments, team members and compute hosts together.</p></div><span className="auth-footnote">Driftverk control plane</span></section>
    <section className="auth-form-panel"><form className="auth-card" onSubmit={create}><div className="auth-mobile-brand"><Brand /></div><p className="eyebrow">Step {step} of 2</p><h2>{step === 1 ? "Create organization" : "Choose your compute"}</h2>{step === 1 ? <><p className="muted">You will become the organization admin.</p><Field label="Organization name" name="organization-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="organization" required /></> : <><p className="muted">Environments for {name} will run here. You can change this before connecting hosts or creating environments.</p><HostingChoice value={hostingMode} onChange={setHostingMode} /></>}{error && <div className="form-alert form-alert-error">{error}</div>}<button className="button button-primary button-wide" disabled={busy || !name.trim()}>{busy && <CircleNotch size={18} className="spin" />}{busy ? "Creating..." : step === 1 ? "Continue" : "Create organization"}</button>{step === 2 && <button type="button" className="button button-secondary button-wide" disabled={busy} onClick={() => setStep(1)}>Back</button>}</form></section>
  </main>;
}

type ComputeAgentSetup = {
  code: string;
  agent_name: string;
  organization_name: string;
  can_approve: boolean;
  approved: boolean;
  consumed: boolean;
  host?: Host | null;
};

function ComputeAgentConnectPage() {
  const navigate = useNavigate();
  const initialCode = new URLSearchParams(window.location.search).get("code") ?? "";
  const [code, setCode] = useState(initialCode);
  const [setup, setSetup] = useState<ComputeAgentSetup | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);

  async function findSetup(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<ComputeAgentSetup>(`/api/compute-agent-setup?code=${encodeURIComponent(code)}`);
      setSetup(result);
      setCode(result.code);
      window.history.replaceState(null, "", `/connect?code=${encodeURIComponent(result.code)}`);
    } catch (caught) {
      setSetup(null);
      setError(caught instanceof Error ? caught.message : "Could not find the setup request.");
    } finally { setBusy(false); }
  }

  useEffect(() => { if (initialCode) void findSetup(); }, []);
  useEffect(() => {
    if (setup?.approved && setup.host && hostConnected(setup.host)) navigate("/hosts", { replace: true });
  }, [setup, navigate]);
  useEffect(() => {
    if (!approved && !setup?.approved) return;
    const timer = setInterval(() => {
      void api<ComputeAgentSetup>(`/api/compute-agent-setup?code=${encodeURIComponent(code)}`)
        .then(setSetup).catch(e => setError(e.message));
    }, 2000);
    return () => clearInterval(timer);
  }, [approved, setup?.approved, code]);

  async function approve() {
    if (!setup) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/compute-agent-setup/approve", { method: "POST", body: JSON.stringify({ code: setup.code }) });
      setApproved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not approve the Compute agent.");
    } finally { setBusy(false); }
  }

  return <main className="connect-layout">
    <section className="connect-card">
      <Brand />
      <div className="connect-progress"><span className={setup ? "complete" : "active"}>1</span><i /><span className={approved ? "complete" : setup ? "active" : ""}>2</span><i /><span className={approved ? "active" : ""}>3</span></div>
      {approved || setup?.approved ? <div className="connect-result">
        <div className="connect-check"><Check /></div>
        <p className="eyebrow">Connection approved</p>
        <h1>{setup?.host && hostConnected(setup.host) ? "Your host is connected" : "Preparing your host…"}</h1>
        <p>{setup?.host && hostConnected(setup.host) ? `${setup.agent_name} is ready in ${setup.organization_name}.` : "Keep the installer running on your server. This page updates when it connects."}</p>
        {error && <div role="alert" className="form-alert form-alert-error">{error}</div>}
        <Link className="button button-primary" to="/hosts">View compute hosts</Link>
      </div> : <>
        <p className="eyebrow">Connect a compute node</p>
        <h1>Authorize Driftverk Compute agent</h1>
        <p className="muted">Only approve a code that is currently shown in the terminal on a machine you control.</p>
        {!setup ? <form className="connect-code-form" onSubmit={findSetup}>
          <label className="field"><span>Setup code</span><input className="mono" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="ABCD-2345" autoComplete="one-time-code" autoFocus required /></label>
          {error && <div className="form-alert form-alert-error">{error}</div>}
          <button className="button button-primary button-wide" disabled={busy || !code}>{busy ? <CircleNotch className="spin" /> : <ArrowRight />}Continue</button>
        </form> : <div className="connect-confirmation">
          <dl><div><dt>Compute agent</dt><dd>{setup.agent_name}</dd></div><div><dt>Organization</dt><dd>{setup.organization_name}</dd></div><div><dt>Code</dt><dd className="mono">{setup.code}</dd></div></dl>
          {error && <div className="form-alert form-alert-error">{error}</div>}
          {!setup.can_approve ? <div className="form-alert form-alert-error">This request can no longer be approved.</div> : <button className="button button-primary button-wide" onClick={() => void approve()} disabled={busy}>{busy ? <CircleNotch className="spin" /> : <Check />}Authorize Compute agent</button>}
          <button className="button button-secondary button-wide" onClick={() => { setSetup(null); setError(""); }} disabled={busy}>Use another code</button>
        </div>}
      </>}
      <button type="button" className="connect-cancel" onClick={() => navigate("/environments")}>Back to Driftverk</button>
    </section>
  </main>;
}

function AcceptInvitationPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const invitationId = new URLSearchParams(window.location.search).get("id");
  const [error, setError] = useState(typeof location.state?.error === "string" ? location.state.error : "");
  const [busy, setBusy] = useState(false);

  async function accept() {
    if (!invitationId) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/organization/accept-invitation", {
        method: "POST",
        body: JSON.stringify({ invitationId }),
      });
      navigate("/team", { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not accept the invitation.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-layout">
    <section className="auth-brand-panel"><Brand /><div><p className="eyebrow eyebrow-light">Join your workspace</p><h1>One team, isolated environments.</h1><p>Accept the invitation to create and manage devboxes with your team.</p></div><span className="auth-footnote">Driftverk control plane</span></section>
    <section className="auth-form-panel"><div className="auth-card"><div className="auth-mobile-brand"><Brand /></div><p className="eyebrow">Team invitation</p><h2>Join the workspace</h2><p className="muted">Your account will be added to the invited Driftverk workspace.</p>{!invitationId && <div className="form-alert form-alert-error">The invitation link is missing its ID.</div>}{error && <div className="form-alert form-alert-error">{error}</div>}<button className="button button-primary button-wide" onClick={() => void accept()} disabled={busy || !invitationId}>{busy ? <CircleNotch className="spin" /> : <Check />}Accept invitation</button><div className="auth-links"><Link to="/environments">Not now</Link></div></div></section>
  </main>;
}

function Field(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string; name: string }) {
  const { label, ...inputProps } = props;
  return (
    <label className="field">
      <span>{label}</span>
      <input {...inputProps} />
    </label>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  if (compact) return <Link className="brand brand-compact" to="/environments" aria-label="Driftverk home"><svg viewBox="0 0 64 72" aria-hidden="true"><path fill="currentColor" d="M4 4h42l12 10-12 10H4V4Zm0 24h42l12 10-12 10H4V28Zm0 24h42l12 10-12 10H4V52Z" /><path className="brand-mark-middle" d="M4 28h42l12 10-12 10H4V28Z" /><circle cx="44" cy="14" r="3" /><circle cx="44" cy="38" r="3" /><circle cx="44" cy="62" r="3" /></svg><span>Driftverk</span></Link>;
  return <div className="brand"><img src="/favicon.svg" alt="" aria-hidden="true" /><span>Driftverk</span></div>;
}

function SettingsNav() {
  return <nav className="settings-links" aria-label="Workspace settings">
    <NavLink to="/settings" end>SSH keys</NavLink>
    <NavLink to="/webhooks">Webhooks</NavLink>
    <NavLink to="/api-keys">API keys</NavLink>
  </nav>;
}

function Shell({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const installation = useInstallation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [hostingMode, setHostingMode] = useState<HostsData["hosting_mode"] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<HostsData>("/api/hosts").then(data => {
      if (!cancelled) setHostingMode(data.hosting_mode);
    }).catch(() => { if (!cancelled) setHostingMode(null); });
    return () => { cancelled = true; };
  }, [pathname, session]);
  const [platformAdmin, setPlatformAdmin] = useState(false);
  const [organizationState, setOrganizationState] = useState<"loading" | "ready" | "missing">("loading");
  const [organizations, setOrganizations] = useState<{ id: string; name: string }[]>([]);
  const [activeOrganizationId, setActiveOrganizationId] = useState("");
  const [switchingOrganization, setSwitchingOrganization] = useState(false);
  const [organizationError, setOrganizationError] = useState("");

  useEffect(() => {
    void api<{ platform_admin: boolean }>("/api/admin/access")
      .then((result) => setPlatformAdmin(result.platform_admin))
      .catch(() => setPlatformAdmin(false));
  }, []);

  useEffect(() => {
    void api<{ id: string; name: string }[]>("/api/auth/organization/list")
      .then(async (items) => {
        setOrganizations(items);
        setOrganizationState(items.length ? "ready" : "missing");
        if (items.length) {
          try {
            const result = await api<EnvironmentsPayload>("/api/environments");
            setActiveOrganizationId(result.workspace.id);
          } catch {
            setOrganizationError("Could not load the current organization. Select one to continue.");
          }
        }
      })
      .catch(() => setOrganizationState("missing"));
  }, []);

  async function switchOrganization(organizationId: string) {
    if (!organizationId || organizationId === activeOrganizationId || switchingOrganization) return;
    setSwitchingOrganization(true);
    setOrganizationError("");
    try {
      await api("/api/auth/organization/set-active", {
        method: "POST",
        body: JSON.stringify({ organizationId }),
      });
      window.location.assign("/environments");
    } catch (caught) {
      setOrganizationError(caught instanceof Error ? caught.message : "Could not switch organization.");
      setSwitchingOrganization(false);
    }
  }

  if (organizationState === "loading") return <LoadingScreen />;
  if (organizationState === "missing") return <Navigate to="/create-organization" replace />;

  async function signOut() {
    await api("/api/auth/sign-out", { method: "POST", body: "{}" }).catch(() => undefined);
    onSignOut();
    navigate("/sign-in");
  }

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <Brand compact />
        <div className="organization-switcher">
          <label htmlFor="active-organization">Organization</label>
          <select id="active-organization" title={organizations.find(organization => organization.id === activeOrganizationId)?.name} value={activeOrganizationId} disabled={switchingOrganization} onChange={(event) => void switchOrganization(event.target.value)} aria-describedby={organizationError ? "organization-switch-error" : undefined}>
            {!activeOrganizationId && <option value="" disabled>Select organization</option>}
            {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
          </select>
          {switchingOrganization && <span role="status">Switching organization...</span>}
          {organizationError && <span id="organization-switch-error" role="alert">{organizationError}</span>}
        </div>
        <nav className="primary-nav" aria-label="Main navigation">
          <NavItem to="/environments" icon={<TerminalWindow />} label="Environments" />
          <NavItem to="/agents" icon={<Robot />} label="Agents" />
          <NavItem to="/blueprints" icon={<Blueprint />} label="Blueprints" />
          <NavItem to="/snapshots" icon={<Stack />} label="Snapshots" />
          <NavItem to="/volumes" icon={<FolderOpen />} label="Volumes" />
          <NavItem to="/registries" icon={<Database />} label="Registries" />
          {hostingMode === "hybrid" && <NavItem to="/hosts" icon={<HardDrives />} label="Compute hosts" />}
          <NavItem to="/team" icon={<UsersThree />} label="Team" />
          {installation.installationMode === "hosted" && <NavItem to="/billing" icon={<ChartLine />} label="Billing" />}
          <NavItem to="/settings" icon={<GearSix />} label="Settings" />
          {platformAdmin && <div className="platform-nav" role="group" aria-label="Platform"><span className="platform-nav-label">Platform</span><NavItem to="/admin/organizations" icon={<HardDrives />} label="Admin" /></div>}
        </nav>
        <div className="sidebar-bottom">
          <Link to="/docs" className="support-link"><BookOpen /> Documentation</Link>
          {installation.installationMode === "hosted" && <a href="mailto:hello@driftverk.com" className="support-link"><Lifebuoy /> Help and support</a>}
          <div className="profile-card">
            <div className="avatar">{initials(session.user.name || session.user.email)}</div>
            <div><strong>{session.user.name || session.user.email}</strong><span>{session.user.email}</span></div>
            <button className="icon-button icon-button-dark" onClick={signOut} aria-label="Sign out" title="Sign out"><SignOut /></button>
          </div>
        </div>
      </aside>
      <main className="content"><Outlet /></main>
    </div>
  );
}

function NavItem({ to, icon, label }: { to: string; icon: ReactNode; label: string }) {
  const location = useLocation();
  const settingsActive = to === "/settings" && ["/webhooks", "/api-keys"].some(path => location.pathname === path || location.pathname.startsWith(`${path}/`));
  return <NavLink to={to} className={({ isActive }) => `nav-item${isActive || settingsActive ? " active" : ""}`}>{icon}<span>{label}</span></NavLink>;
}

function EnvironmentsPage() {
  const location = useLocation();
  const [data, setData] = useState<EnvironmentsPayload | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  async function load() {
    try {
      setData(await api<EnvironmentsPayload>("/api/environments"));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load environments.");
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const filtered = data?.environments.filter((environment) =>
    (!stateFilter || environment.state === stateFilter) &&
    `${environment.name} ${environment.id}`.toLowerCase().includes(search.trim().toLowerCase()),
  ) ?? [];
  const selected = data?.environments.find((environment) => environment.id === selectedId);
  return (
    <Page className="environments-page">
      <PageHeader
        eyebrow="Control plane"
        title="Development environments"
        action={data && data.environments.length > 0 ? <div className="development-actions"><Link className="button button-secondary" to="/environments/new?quickstart=1">Quickstart</Link><Link className="button button-primary" to="/environments/new"><Plus /> Create environment</Link></div> : undefined}
      />
      {location.search.includes("created=1") && <div className="notice"><Check size={18} /> The environment has been queued.</div>}
      {error && (!data ? <LoadError message={error} onRetry={() => { setError(""); void load(); }} /> : <div className="form-alert form-alert-error" role="alert">{error}</div>)}
      {data && data.environments.length > 0 && <div className="environment-filters">
        <label className="field"><span>Search environments</span><input type="search" placeholder="Search by name or ID" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <label className="field"><span>Status</span><select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}><option value="">All statuses</option><option value="running">Running</option><option value="stopped">Stopped</option><option value="provisioning">Starting / queued</option><option value="degraded">Failed</option></select></label>
        <span role="status">{filtered.length} of {data.environments.length} environments</span>
      </div>}
      {!data ? (!error && <TableSkeleton />) : data.environments.length === 0 ? <EmptyEnvironments /> : filtered.length ? <EnvironmentTable environments={filtered} onInspect={setSelectedId} /> : <section className="empty-state data-panel"><h2>No matching environments</h2><p>Try a different name or status.</p><button className="button button-secondary" onClick={() => { setSearch(""); setStateFilter(""); }}>Clear filters</button></section>}
      {selected && <EnvironmentQuickView environment={selected} onClose={() => setSelectedId(null)} />}
      <Outlet />
    </Page>
  );
}

function EnvironmentTable({ environments, onInspect }: { environments: Environment[]; onInspect?: (id: string) => void }) {
  return (
    <section className="data-panel environment-table-wrap environment-list-table">
      <table className="data-table">
        <thead><tr><th>Environment</th><th>Status</th><th>Source</th><th>Resources</th><th>Last changed</th><th /></tr></thead>
        <tbody>
          {environments.map((environment) => (
            <tr key={environment.id}>
              <td><Link className="environment-name" to={`/environments/${environment.id}`}>{environment.name}</Link></td>
              <td><div className="environment-status-stack"><StatusBadge state={environment.state} provisioningStep={environment.provisioning_step} computeNodeId={environment.compute_node_id} activeOperation={environment.active_operation} /></div>{environment.queue_reason === "insufficient_capacity" && <span className="queue-reason">Not enough free CPU or memory</span>}</td>
              <td>{environment.source_image ? <CopyAction compact className="image-reference" label={formatImageName(environment.source_image)} value={environment.source_image} /> : <strong title={environment.snapshot_id || undefined}>{environment.snapshot_id ? shortId(environment.snapshot_id) : "Unknown source"}</strong>}{environment.source_type === "snapshot" && <span className="subtle">Snapshot</span>}</td>
              <td><div className="resource-pills"><span>{formatResourceSize(environment.cpu_count, environment.memory_mb)}</span><span>{environment.cpu_count} vCPU</span><span>{formatMemory(environment.memory_mb)}</span></div></td>
              <td>{timeAgo(environment.updated_at)}</td>
              <td><div className="environment-row-actions">{onInspect && <button className="row-link" aria-label={`Quick view ${environment.name}`} onClick={() => onInspect(environment.id)}>Quick view</button>}<Link className="row-link" to={`/environments/${environment.id}`}>Open <ArrowRight /></Link></div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function EnvironmentQuickView({ environment, onClose }: { environment: Environment; onClose: () => void }) {
  return <Dialog className="environment-drawer" labelledBy="quick-view-title" onClose={onClose}>
    <header className="modal-header"><div><p>Environment details</p><h2 id="quick-view-title">{environment.name}</h2></div><button className="icon-button" aria-label="Close quick view" onClick={onClose}><X /></button></header>
    <div className="drawer-content">
      <StatusBadge state={environment.state} provisioningStep={environment.provisioning_step} computeNodeId={environment.compute_node_id} activeOperation={environment.active_operation} />
      {environment.queue_reason === "insufficient_capacity" && <p className="notice notice-warning">No connected compute host has enough free CPU or memory. Stop another environment, choose fewer resources, or add host capacity.</p>}
      {environment.error_message && <p className="form-alert form-alert-error">{environment.error_message}</p>}
      <OverviewSection title="Overview"><OverviewRow label="Source" value={environment.source_image ? formatImageName(environment.source_image) : environment.snapshot_id || "Unknown"} mono /><OverviewRow label="Host" value={environment.compute_host_name || (environment.compute_node_id ? "Driftverk compute" : "Awaiting host")} /><OverviewRow label="Created" value={timeAgo(environment.created_at)} /><OverviewRow label="Last activity" value={timeAgo(environment.last_activity_at || environment.updated_at)} /></OverviewSection>
      <OverviewSection title="Resources"><p className="resource-size-name">{formatResourceSize(environment.cpu_count, environment.memory_mb)}</p><div className="compact-resources"><span><Cpu />{environment.cpu_count} vCPU</span><span><HardDrives />{formatMemory(environment.memory_mb)}</span></div><p className="subtle">Shared disk storage, no per-environment limit.</p></OverviewSection>
      <OverviewSection title="Lifecycle"><OverviewRow label="Auto-stop" value={formatMinutes(environment.auto_stop_minutes)} /><OverviewRow label="Delete at" value={environment.auto_delete_minutes ? new Date(new Date(environment.created_at).getTime() + environment.auto_delete_minutes * 60_000).toLocaleString() : "Disabled"} /></OverviewSection>
      <OverviewSection title="Access"><p className="subtle">Preview links expire after 1 hour. Anyone with the full link can open them.</p><Link className="row-link" to="/settings">Manage SSH keys <ArrowRight /></Link></OverviewSection>
    </div>
    <footer className="drawer-footer"><Link className="button button-primary" to={`/environments/${environment.id}`}>Open environment <ArrowRight /></Link><Link className="button button-secondary" to={`/environments/${environment.id}?tab=terminal`}>Terminal</Link></footer>
  </Dialog>;
}

function EmptyEnvironments() {
  return <section className="data-panel quickstart-welcome" aria-labelledby="quickstart-heading">
    <h2 id="quickstart-heading">Create your first environment</h2>
    <p>Start with your repository or a clean development environment. You can add code and connect an agent later.</p>
    <div className="development-actions"><Link className="button button-primary" to="/environments/new"><Plus /> Create environment</Link></div>
    <p className="subtle">Want to explore first? <Link to="/environments/example">Try an example app</Link>.</p>
  </section>;
}

function CreateExamplePage() {
  const navigate = useNavigate();
  const [hosts, setHosts] = useState<HostsData | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([api<HostsData>("/api/hosts"), api<Billing>("/api/billing")]).then(([hosts, billing]) => {
      if (active) { setHosts(hosts); setBilling(billing); }
    }).catch(error => { if (active) setError(error instanceof Error ? error.message : "Could not load configuration."); });
    return () => { active = false; };
  }, []);
  const needsHost = hosts?.hosting_mode === "hybrid" && !hosts.hosts.some(hostConnected);
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const created = await api<{ id: string }>("/api/environments", { method: "POST", body: JSON.stringify({ ...exampleApp, name: `example-${crypto.randomUUID().slice(0, 8)}` }) });
      navigate(`/environments/${created.id}`);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not create the example."); }
    finally { setBusy(false); }
  }
  return <CreateEnvironmentModal title="Try an example app" busy={busy} onClose={() => navigate("/environments")}>
    <form className="create-modal-form" onSubmit={create}>
      <div className="create-modal-fields example-intro">
        <p>Start a small web app, open its preview, then change the heading from Terminal. No repository connection needed.</p>
        <p className="subtle">1 vCPU · 1 GB memory · Stops after 15 minutes of inactivity. Your files remain until you delete the environment.</p>
        {billing && <CloudEstimate compact cpu={1} memoryMb={1024} />}
        {billing?.hosting_mode === "managed" && !billing.complimentary && <p className="subtle">Normal Cloud rates apply. Storage is billed while stopped. <Link to="/billing">View billing</Link></p>}
        {hosts && hosts.role !== "admin" && <p className="form-alert">Ask a workspace admin to create an example environment.</p>}
        {needsHost && <p className="form-alert"><Link to="/hosts">Connect a compute host</Link> before starting the example.</p>}
        {(!hosts || !billing) && !error && <p role="status">Loading configuration…</p>}
        {error && <p className="form-alert form-alert-error" role="alert">{error}</p>}
      </div>
      <footer className="create-modal-footer"><Link className="button button-secondary" to="/environments/new">Use your repository</Link><button className="button button-primary" disabled={busy || !hosts || hosts.role !== "admin" || !billing || needsHost}>{busy ? "Creating…" : "Start example app"}</button></footer>
    </form>
  </CreateEnvironmentModal>;
}

function CreateEnvironmentModal({ children, busy, onClose, title = "Create environment" }: { children: ReactNode; busy: boolean; onClose: () => void; title?: string }) {
  return <Dialog className="create-environment-modal" labelledBy="create-environment-title" busy={busy} onClose={onClose}>
    <header className="modal-header"><div><h2 id="create-environment-title">{title}</h2></div><button type="button" className="icon-button" disabled={busy} onClick={onClose} aria-label="Close"><X /></button></header>
    {children}
  </Dialog>;
}

function CreateEnvironmentPage() {
  const [settings, setSettings] = useState<MemberSettings | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api<MemberSettings>("/api/member-environment-settings").then(setSettings).catch(error => setError(error.message)); }, []);
  if (!settings) return <Page>{error ? <p role="alert">{error}</p> : <p role="status">Loading configuration…</p>}</Page>;
  return settings.role === "admin" ? <AdminCreateEnvironmentPage /> : <MemberEnvironmentForm settings={settings} />;
}

function AdminCreateEnvironmentPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const requestedPrebuild = params.get("prebuild");
  const requestedSnapshot = params.get("snapshot");
  const requestedTemplate = params.get("template") || "";
  const startedQuickstart = params.get("quickstart") === "1" && !requestedSnapshot && !requestedPrebuild && !requestedTemplate;
  const [quickstart, setQuickstart] = useState(startedQuickstart);
  const [sourceChoice, setSourceChoice] = useState<"blueprint" | "fresh" | "snapshot">(requestedSnapshot || requestedPrebuild ? "snapshot" : requestedTemplate ? "blueprint" : "fresh");
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [agentId, setAgentId] = useState<AgentId | "">("");
  const [agentAuthMethod, setAgentAuthMethod] = useState<"subscription" | "api_key">("subscription");
  const creationPreferencesKey = useRef("");
  const [blueprints, setBlueprints] = useState<{ id: string; name: string; configuration: TemplateConfiguration }[]>([]);
  const [blueprintId, setBlueprintId] = useState(requestedTemplate);
  const blueprintPicker = useRef<HTMLSelectElement>(null);
  const [defaultImage, setDefaultImage] = useState("");
  const [baseSource, setBaseSource] = useState<"default" | "image">("default");
  const [defaultSnapshotId, setDefaultSnapshotId] = useState("");
  const [prebuild, setPrebuild] = useState<Prebuild | null>(null);
  const [hostId, setHostId] = useState(params.get("host") || "");
  const [hostData, setHostData] = useState<HostsData | null>(null);
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [snapshotId, setSnapshotId] = useState("");
  const [registryId, setRegistryId] = useState("");
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("");
  const [setupCommand, setSetupCommand] = useState("");
  const [initializationCommand, setInitializationCommand] = useState("");
  const [startupCommand, setStartupCommand] = useState("");
  const [readinessCommand, setReadinessCommand] = useState("");
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesRetry, setSourcesRetry] = useState(0);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [registries, setRegistries] = useState<Registry[]>([]);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [cpu, setCpu] = useState(1);
  const [memory, setMemory] = useState(2048);
  const [autoStop, setAutoStop] = useState<number | "">(15);
  const [autoDelete, setAutoDelete] = useState<number | "">("");
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [defaultPort, setDefaultPort] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [organizationSecretNames, setOrganizationSecretNames] = useState<string[]>([]);
  const [variables, setVariables] = useState<Array<{ name: string; value: string }>>([]);
  const [volumeMounts, setVolumeMounts] = useState<Array<{ volume_id: string; mount_path: string; subpath: string; read_only: boolean }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function applySnapshot(snapshot?: Snapshot) {
    const saved = snapshot?.launch_configuration;
    setStartupCommand(saved?.startup_command || ""); setReadinessCommand(saved?.readiness_command || "");
    setWorkspacePath(saved?.workspace_path || ""); setDefaultPort(saved?.preview_port ? String(saved.preview_port) : "");
    setPreviewEnabled(saved?.preview_enabled ?? true); setCpu(saved?.cpu ?? 1); setMemory(saved?.memory_mb ?? 2048);
    setInitializationCommand(""); setSetupCommand("");
  }

  function applyTemplate(value: TemplateConfiguration) {
    setAgentId(value.agent_id || "");
    setAgentAuthMethod(value.agent_auth_method || "api_key");
    setOrganizationSecretNames(value.organization_secret_names || []);
    setImage(value.image || defaultImage); setSnapshotId(value.snapshot_id || ""); setRegistryId(value.registry_id || "");
    setCpu(value.cpu); setMemory(value.memory_mb); setAutoStop(value.auto_stop_minutes ?? "");
    setRepository(value.repository || ""); setBranch(value.repository_branch || ""); setSetupCommand(value.setup_command || "");
    setInitializationCommand(value.initialization_command || ""); setStartupCommand(value.startup_command || ""); setReadinessCommand(value.readiness_command || "");
    setDefaultPort(value.preview_port ? String(value.preview_port) : ""); setPreviewEnabled(value.preview_enabled ?? true); setWorkspacePath(value.workspace_path || "");
    setError("");
  }

  function selectBlueprint(id: string) {
    setBlueprintId(id);
    const selected = blueprints.find(item => item.id === id);
    // Blueprints follow their branch. A ready prebuild may contain an older
    // checkout, so only explicit prebuild links restore a pinned snapshot.
    setPrebuild(null);
    if (selected) applyTemplate(selected.configuration);
  }

  function openBlueprintPicker() {
    const picker = blueprintPicker.current;
    picker?.focus();
    // Browsers without native picker support retain keyboard selection.
    try { picker?.showPicker?.(); } catch { /* Focus remains on the select. */ }
  }

  function selectSource(next: "blueprint" | "fresh" | "snapshot") {
    if (next === sourceChoice) return;
    setSourceChoice(next); setError("");
    if (next === "blueprint") { selectBlueprint(blueprintId); return; }
    // A new source must never inherit a prepared checkout or hidden commands.
    setOrganizationSecretNames([]);
    const defaultAgent = agents.find(agent => agent.is_default);
    setAgentId(defaultAgent?.id || "");
    setAgentAuthMethod(defaultAgent?.default_auth_method || "subscription");
    setPrebuild(null); setRepository(""); setBranch(""); setImage(defaultImage); setRegistryId("");
    setSetupCommand(""); setInitializationCommand(""); setStartupCommand(""); setReadinessCommand("");
    setSnapshotId(snapshots[0]?.id ?? "");
    applySnapshot(next === "snapshot" ? snapshots[0] : undefined);
  }

  useEffect(() => {
    let cancelled = false;
    setSourcesLoading(true);
    setError("");
    void Promise.all([
      api<{ snapshots: Snapshot[] }>("/api/snapshots"), api<{ registries: Registry[] }>("/api/registries"), api<{ volumes: Volume[] }>("/api/volumes"),
      api<{ defaultImage: string; defaultSnapshotId?: string | null }>("/api/config"), api<HostsData>("/api/hosts"),
      api<{ templates: { id: string; name: string; configuration: TemplateConfiguration }[] }>("/api/environment-templates"),
      api<AgentsPayload>("/api/agents"),
      requestedPrebuild ? api<{ prebuilds: Prebuild[] }>("/api/prebuilds") : Promise.resolve({ prebuilds: [] as Prebuild[] }),
      api<{ user: { id: string }; session: { activeOrganizationId?: string } }>("/api/auth/get-session"),
    ]).then(([snapshotData, registryData, volumeData, configData, hosts, templateData, agentData, prebuildData, session]) => {
      if (cancelled) return;
      setError("");
      setHostData(hosts);
      setAgents(agentData.agents);
      const requestedAgent = params.get("agent");
      const defaultAgent = agentData.agents.find(agent => agent.is_default);
      setAgentId(requestedAgent === "codex" || requestedAgent === "claude" ? requestedAgent : defaultAgent?.id || "");
      setAgentAuthMethod(requestedAgent ? "subscription" : defaultAgent?.default_auth_method || "subscription");
      if (session?.user?.id && session.session.activeOrganizationId) {
        creationPreferencesKey.current = `driftverk:create:${session.user.id}:${session.session.activeOrganizationId}`;
        if (!requestedSnapshot && !requestedTemplate && !requestedPrebuild) {
          try {
            const saved = JSON.parse(localStorage.getItem(creationPreferencesKey.current) || "null");
            if (saved && typeof saved.repository === "string" && saved.repository.length < 512) {
              setRepository(saved.repository);
              if (typeof saved.branch === "string" && saved.branch.length < 256) setBranch(saved.branch);
              if (!requestedAgent && !defaultAgent && ["", "codex", "claude"].includes(saved.agentId) && ["subscription", "api_key"].includes(saved.authMethod)) {
                setAgentId(saved.agentId); setAgentAuthMethod(saved.authMethod);
              }
            }
          } catch { /* Browser storage is optional. */ }
        }
      }
      setBlueprints(templateData.templates);
      const ready = snapshotData.snapshots.filter(snapshot => snapshot.status === "ready");
      setSnapshots(ready); setSnapshotId(requestedSnapshot ? ready.find(snapshot => snapshot.id === requestedSnapshot)?.id ?? "" : ready[0]?.id ?? "");
      const systemSnapshotId = configData.defaultSnapshotId || "";
      setDefaultSnapshotId(systemSnapshotId);
      if (requestedSnapshot) applySnapshot(ready.find(snapshot => snapshot.id === requestedSnapshot));
      setRegistries(registryData.registries); setVolumes(volumeData.volumes); setDefaultImage(configData.defaultImage); setImage(configData.defaultImage);
      if (requestedSnapshot && !ready.some(snapshot => snapshot.id === requestedSnapshot)) setError("The selected snapshot is unavailable. Choose another ready snapshot.");
      if (requestedTemplate) {
        const template = templateData.templates.find(item => item.id === requestedTemplate);
        if (template) { applyTemplate(template.configuration); setPrebuild(null); }
        else setError("This blueprint is unavailable. Choose another blueprint or start fresh.");
      }
      if (requestedPrebuild) {
        const build = prebuildData.prebuilds.find(item => item.id === requestedPrebuild && item.status === "ready");
        if (build) { applyTemplate(build.configuration); setBlueprintId(build.template_id); setPrebuild(build); }
        else setError("This prebuild is unavailable. Choose a ready snapshot or start fresh.");
      }
      setSourcesLoading(false);
    }).catch(caught => { if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load sources."); });
    return () => { cancelled = true; };
  }, [sourcesRetry]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sourceChoice === "blueprint" && !blueprints.some(item => item.id === blueprintId)) { setError("Choose a blueprint."); return; }
    if (variables.length > 25 || new Set(variables.map(variable => variable.name.trim())).size !== variables.length) { setError("Use at most 25 variables, each with a unique name."); return; }
    const freshSnapshot = sourceChoice === "fresh" && baseSource === "default" && Boolean(defaultSnapshotId);
    const source = freshSnapshot || sourceChoice === "snapshot" || prebuild || (sourceChoice === "blueprint" && blueprints.find(item => item.id === blueprintId)?.configuration.source_type === "snapshot") ? "snapshot" : "image";
    setBusy(true); setError("");
    try {
      const created = await api<{ id: string }>("/api/environments", {
        method: "POST", body: JSON.stringify({
          name, agent_id: agentId || null, agent_auth_method: agentAuthMethod, prebuild_id: prebuild?.id, initialization_command: initializationCommand,
          repository: sourceChoice !== "snapshot" ? repository : "", repository_branch: repository && sourceChoice !== "snapshot" ? branch : "",
          setup_command: sourceChoice !== "snapshot" ? setupCommand : "", startup_command: startupCommand, readiness_command: readinessCommand,
          compute_node_id: hostId || undefined, source_type: source, image: source === "image" ? (sourceChoice === "fresh" && baseSource === "default" ? defaultImage : image) : undefined,
          snapshot_id: source === "snapshot" ? (freshSnapshot ? defaultSnapshotId : prebuild?.snapshot_id || snapshotId) : undefined, registry_id: source === "image" && !(sourceChoice === "fresh" && baseSource === "default") ? registryId || undefined : undefined,
          cpu, memory_mb: memory, auto_stop_minutes: autoStop || null, auto_archive_minutes: null, auto_delete_minutes: autoDelete || null,
          preview_enabled: previewEnabled, preview_port: defaultPort ? Number(defaultPort) : null, workspace_path: workspacePath || null, ephemeral: false, organization_secret_names: organizationSecretNames, environment_variables: variables.filter(variable => variable.name), volume_mounts: volumeMounts,
        })
      });
      try {
        if (creationPreferencesKey.current && sourceChoice === "fresh") localStorage.setItem(creationPreferencesKey.current, JSON.stringify({ repository, branch, agentId, authMethod: agentAuthMethod }));
      } catch { /* Creation succeeds even when browser storage is unavailable. */ }
      navigate(`/environments/${created.id}${startedQuickstart && !agentId ? "?quickstart=1" : ""}`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not create the environment."); } finally { setBusy(false); }
  }

  const selectedBlueprint = blueprints.find(item => item.id === blueprintId);
  const selectedSnapshot = snapshots.find(snapshot => snapshot.id === snapshotId);
  const projectSummary = prebuild ? "Prepared snapshot" : [setupCommand, initializationCommand, startupCommand, readinessCommand].filter(Boolean).length ? "Custom commands" : "Optional commands";
  const settingsSummary = `${formatResourceSize(cpu, memory)} · ${cpu} vCPU · ${formatMemory(memory)} · ${autoStop ? `Auto-stop ${autoStop} min` : "Always on"}`;
  const usesSnapshot = sourceChoice === "snapshot" || Boolean(prebuild) || (sourceChoice === "blueprint" && selectedBlueprint?.configuration.source_type === "snapshot");
  const needsHost = hostData?.hosting_mode === "hybrid" && !hostData.hosts.some(hostConnected);
  const cannotCreate = busy || Boolean(agentId === "codex" && agentAuthMethod === "subscription" && !agents.some(agent => agent.id === "codex" && agent.subscription_connected)) || Boolean(agentId && agentAuthMethod === "api_key" && !agents.some(agent => agent.id === agentId && agent.connected)) || (quickstart && !repository.trim()) || hostData?.role !== "admin" || (sourceChoice === "blueprint" && !selectedBlueprint) || (usesSnapshot ? !(prebuild?.snapshot_id || snapshotId) : (sourceChoice !== "fresh" || baseSource === "image") && !image.trim()) || (quickstart ? needsHost : hostData?.hosting_mode === "hybrid" && !hostData.hosts.length);

  return <CreateEnvironmentModal title={quickstart ? "Open a repository" : "Create environment"} busy={busy} onClose={() => navigate("/environments")}>
    {sourcesLoading ? <div className="create-modal-loading">{error ? <LoadError message={error} onRetry={() => setSourcesRetry(value => value + 1)} /> : <p role="status">Loading configuration…</p>}</div> : <form className="create-modal-form" onSubmit={submit}>
      <fieldset disabled={busy} className={`create-modal-fields${quickstart ? " quickstart-fields" : ""}`}>
        {quickstart && <div className="quickstart-intro"><p>Start with your code. We’ll prepare a separate environment for you.</p><p className="subtle">1 vCPU · 2 GB memory · Stops after 15 minutes of inactivity.</p></div>}
        {!quickstart && <>
        <label className="field create-name-field"><span>Environment name <small>Optional</small></span><input value={name} onChange={event => setName(event.target.value.toLowerCase())} pattern="[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?" placeholder="Generated automatically" /></label>
        <span className="create-field-label">Start from</span>
        <div className="create-source-tabs" role="tablist" aria-label="Environment source" onKeyDown={event => {
          const choices = ["blueprint", "fresh", "snapshot"] as const;
          const index = choices.indexOf(sourceChoice);
          const next = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : -1;
          if (next < 0) return;
          event.preventDefault(); selectSource(choices[next]); (event.currentTarget.children[next] as HTMLButtonElement).focus();
        }}>
          {([["blueprint", "Blueprint", Blueprint], ["fresh", "New environment", Plus], ["snapshot", "Snapshot", Stack]] as const).map(([value, label, Icon]) => <button key={value} id={`source-${value}`} type="button" role="tab" aria-label={label} aria-controls="create-source-panel" tabIndex={sourceChoice === value ? 0 : -1} aria-selected={sourceChoice === value} className={sourceChoice === value ? "selected" : ""} onClick={() => selectSource(value)}><Icon aria-hidden="true" /><span><strong>{label}</strong></span></button>)}
        </div>

        </>}
        <section id="create-source-panel" className={`create-source-panel create-source-${sourceChoice}`} role={quickstart ? undefined : "tabpanel"} aria-label={quickstart ? "Repository" : undefined} aria-labelledby={quickstart ? undefined : `source-${sourceChoice}`}>
          {sourceChoice === "blueprint" && (blueprints.length ? <>
            <label className="field blueprint-field"><span>Blueprint</span><div className="blueprint-select"><MagnifyingGlass aria-hidden="true" /><select ref={blueprintPicker} required value={blueprintId} onChange={event => selectBlueprint(event.target.value)}><option value="" disabled>Choose a blueprint</option>{blueprints.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>{selectedBlueprint && <small>{selectedBlueprint.configuration.repository || (selectedBlueprint.configuration.image ? formatImageName(selectedBlueprint.configuration.image) : "Snapshot")}{selectedBlueprint.configuration.repository && ` · ${branch || "Default branch"}`}</small>}<CaretDown aria-hidden="true" /></div></label>
            {selectedBlueprint && <div className="blueprint-ready" role="status"><Blueprint /><div><strong>{repository ? "Tracks your branch" : "Setup runs on creation"}</strong><small>{repository ? `Uses the latest code from ${branch || "the default branch"}` : "Uses the saved image and project commands"}</small></div><button type="button" className="row-link" onClick={openBlueprintPicker}>Change blueprint</button></div>}
          </> : <div className="inline-empty"><Blueprint /><div><strong>No blueprints yet</strong><span>Start fresh, then use More → Save as blueprint on your environment.</span><button type="button" className="row-link" onClick={() => selectSource("fresh")}>Start fresh <ArrowRight /></button></div></div>)}
          {sourceChoice === "fresh" && <div className="create-repository-grid"><RepositoryFields hideBranch required={quickstart} repository={repository} branch={branch} onRepository={setRepository} onBranch={setBranch} /><label className="field"><span>Branch <small>Optional</small></span><input placeholder="Default branch" disabled={!repository.trim()} value={branch} onChange={event => setBranch(event.target.value)} /></label></div>}
          {sourceChoice === "snapshot" && (snapshots.length ? <label className="field"><span>Snapshot</span><select required value={snapshotId} onChange={event => { setSnapshotId(event.target.value); setPrebuild(null); applySnapshot(snapshots.find(snapshot => snapshot.id === event.target.value)); }}><option value="" disabled>Choose a ready snapshot</option>{snapshots.filter(snapshot => !snapshot.is_system || snapshot.is_default || snapshot.id === snapshotId).map(snapshot => <option key={snapshot.id} value={snapshot.id}>{snapshot.is_system ? "Driftverk Dev" : snapshot.name}</option>)}</select><small>{prebuild ? `Prepared checkout · ${prebuild.repository_revision?.slice(0, 7) || "No repository"}` : selectedSnapshot?.is_system ? "System snapshot maintained by Driftverk. Restores its tools, files, and writable state." : selectedSnapshot?.launch_configuration ? "Saved startup commands, resources, and preview settings are filled in below." : "This snapshot has no saved launch settings. Review startup commands before creating."}</small></label> : <div className="inline-empty"><Stack /><div><strong>No ready snapshots</strong><span>Create a snapshot from an existing environment first.</span></div></div>)}
        </section>

        <AgentPicker agents={agents} value={agentId} onChange={setAgentId} authMethod={agentAuthMethod} onAuthMethod={setAgentAuthMethod} />
        <AdvancedSection title="Advanced" summary={settingsSummary} icon={<GearSix />}>
        {sourceChoice === "snapshot" && selectedSnapshot && <p className="subtle snapshot-launch-note">Creates a separate environment. Running processes and mounted volume data are not restored. Review variables and volume mounts below.</p>}
        {sourceChoice === "blueprint" && repository && <AdvancedSection title="Branch" summary={branch || "Default branch"} icon={<GitBranch />}><label className="field"><span>Branch</span><input value={branch} placeholder="Default branch" onChange={event => setBranch(event.target.value)} /></label><p className="subtle">Checks out the latest code when the environment is created. Overrides apply to this environment only.</p></AdvancedSection>}
        {!quickstart && sourceChoice === "fresh" && <AdvancedSection title="Environment source" summary={baseSource === "default" ? "Driftverk Dev" : image ? image === defaultImage || image.startsWith("ghcr.io/simskii/") ? "Default image" : formatImageName(image) : "Custom image"} icon={<ImageSquare />}>
          <div className="create-source-tabs create-base-source-tabs" role="group" aria-label="Base environment source">
            <button type="button" className={baseSource === "default" ? "selected" : ""} aria-pressed={baseSource === "default"} onClick={() => setBaseSource("default")}>Driftverk Dev</button>
            <button type="button" className={baseSource === "image" ? "selected" : ""} aria-pressed={baseSource === "image"} onClick={() => setBaseSource("image")}>Custom image</button>
          </div>
          {baseSource === "default" ? <p className="subtle">The maintained Driftverk development environment.</p> : <div className="create-image-grid"><label className="field"><span>OCI image</span><input required={!image.startsWith("ghcr.io/simskii/")} value={image.startsWith("ghcr.io/simskii/") ? "" : image} onChange={event => setImage(event.target.value)} placeholder={image.startsWith("ghcr.io/simskii/") ? "Default image" : "ubuntu:24.04"} /></label><label className="field"><span>Registry</span><select value={registryId} onChange={event => setRegistryId(event.target.value)}><option value="">Public registry</option>{registries.map(registry => <option key={registry.id} value={registry.id}>{registry.name}</option>)}</select></label></div>}
        </AdvancedSection>}
        {sourceChoice !== "blueprint" && <AdvancedSection title={quickstart ? "Setup commands" : "Project setup"} summary={quickstart && projectSummary === "Optional commands" ? "Optional · Compose starts automatically" : projectSummary} icon={<TerminalWindow />}>
          {sourceChoice === "snapshot" && <label className="field"><span>Working directory <small>Optional</small></span><input value={workspacePath} onChange={event => setWorkspacePath(event.target.value)} placeholder="/workspace" /><small>Where startup and readiness commands run.</small></label>}
          <ProjectCommands prebuilt={sourceChoice === "snapshot"} initialization={initializationCommand} onInitialization={setInitializationCommand} repository={sourceChoice === "fresh" ? repository : ""} branch={branch} setup={setupCommand} startup={startupCommand} readiness={readinessCommand} onSetup={setSetupCommand} onStartup={setStartupCommand} onReadiness={setReadinessCommand} />
        </AdvancedSection>}

        {!quickstart && <>
        <AdvancedSection title="Ports and preview" summary={!previewEnabled ? "Preview disabled" : defaultPort ? `HTTP · ${defaultPort}` : "Detect web port"} icon={<GlobeHemisphereWest />}>
          <label className="setting-toggle"><input type="checkbox" checked={previewEnabled} onChange={event => setPreviewEnabled(event.target.checked)} /><span><strong>HTTP preview</strong><small>Links expire after 1 hour. Anyone with the full link can open them.</small></span></label>
          <label className="field"><span>Default preview port <small>Optional</small></span><input type="number" min="1" max="65535" step="1" inputMode="numeric" disabled={!previewEnabled} value={defaultPort} onChange={event => setDefaultPort(event.target.value)} placeholder="Detect automatically" /><small>For example, 3000 or 5173. Your app must listen on 0.0.0.0. Other listening ports appear after startup.</small></label>
        </AdvancedSection>
        <AdvancedSection title="Environment settings" summary={settingsSummary} icon={<GearSix />}>
          <section className="form-section create-settings-section">
            {hostData?.hosting_mode === "hybrid" && <label className="field"><span>Compute host</span><select value={hostId} onChange={event => setHostId(event.target.value)}><option value="">Automatic · next available host</option>{hostData.hosts.map(host => <option key={host.id} value={host.id}>{host.name} · {hostConnected(host) ? "Connected" : "Offline"}</option>)}</select></label>}
          </section>
          <div className="resource-presets" aria-label="Environment size">
            {RESOURCE_SIZES.map(size => <button key={size.name} type="button" aria-pressed={cpu === size.cpu && memory === size.memoryMb} onClick={() => { setCpu(size.cpu); setMemory(size.memoryMb); }}><strong>{size.name}</strong><span>{size.cpu} vCPU · {formatMemory(size.memoryMb)}</span></button>)}
          </div>
          <details className="custom-resources"><summary>Custom resources</summary><div className="resource-selects"><SelectField icon={<Cpu />} label="vCPU limit" value={cpu} onChange={value => setCpu(Number(value))} options={[[1, "1"], [2, "2"], [4, "4"], [8, "8"]]} /><SelectField icon={<HardDrives />} label="Memory limit" value={memory} onChange={value => setMemory(Number(value))} options={[[1024, "1 GB"], [2048, "2 GB"], [4096, "4 GB"], [8192, "8 GB"], [16384, "16 GB"]]} /></div></details>
          <AdvancedSection title="Lifecycle" summary={`Auto-stop: ${formatMinutes(autoStop || null)}`}><div className="lifecycle-grid"><DurationField label="Stop after inactivity" value={autoStop} onChange={setAutoStop} /><DurationField label="Delete after total lifetime" value={autoDelete} onChange={setAutoDelete} /></div></AdvancedSection>
        </AdvancedSection>
        <AdvancedSection title="Variables and volumes" summary={variables.length || volumeMounts.length ? `${variables.length} variables · ${volumeMounts.length} volumes` : "Configure per environment"} icon={<Database />}>
          <AdvancedSection title="Volumes" summary={volumeMounts.length ? `${volumeMounts.length} mounted` : "No volumes mounted"}>{volumes.length ? <div className="volume-mount-list">{volumeMounts.map((mount, index) => <div className="volume-mount-row" key={index}><label><span>Volume</span><select value={mount.volume_id} onChange={event => setVolumeMounts(current => current.map((item, i) => i === index ? { ...item, volume_id: event.target.value } : item))}>{volumes.map(volume => <option key={volume.id} value={volume.id}>{volume.name}</option>)}</select></label><label><span>Mount path</span><input value={mount.mount_path} onChange={event => setVolumeMounts(current => current.map((item, i) => i === index ? { ...item, mount_path: event.target.value } : item))} /></label><button type="button" className="icon-button" aria-label="Remove volume mount" onClick={() => setVolumeMounts(current => current.filter((_, i) => i !== index))}><Trash /></button></div>)}{volumeMounts.length < 5 && <button type="button" className="button button-secondary" onClick={() => setVolumeMounts(current => [...current, { volume_id: volumes[0]!.id, mount_path: "/workspace/data", subpath: "", read_only: true }])}><Plus /> Mount volume</button>}</div> : <p className="subtle">No volumes available.</p>}</AdvancedSection>
          <AdvancedSection title="Organization secrets" summary={`${organizationSecretNames.length} selected`}><OrganizationSecretPicker value={organizationSecretNames} onChange={setOrganizationSecretNames} /></AdvancedSection>
          <AdvancedSection title="Environment variables" summary={`${variables.filter(variable => variable.name).length} configured`}><div className="variable-list">{variables.map((variable, index) => <div className="variable-row" key={index}><input aria-label={`Variable ${index + 1} name`} name={`environment-variable-name-${index}`} autoComplete="off" data-1p-ignore placeholder="NAME" required value={variable.name} onChange={event => setVariables(current => current.map((item, i) => i === index ? { ...item, name: event.target.value } : item))} /><input aria-label={`Variable ${index + 1} value`} name={`environment-variable-value-${index}`} autoComplete="new-password" data-1p-ignore data-lpignore="true" placeholder="Value" type="password" value={variable.value} onChange={event => setVariables(current => current.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} /><button type="button" className="icon-button" aria-label="Remove variable" onClick={() => setVariables(current => current.filter((_, i) => i !== index))}><Trash /></button></div>)}<button type="button" className="button button-secondary" onClick={() => setVariables(current => [...current, { name: "", value: "" }])}><Plus /> Add variable</button><EnvImport existingNames={variables.map(variable => variable.name)} onImport={imported => setVariables(current => mergeImportedVariables(current, imported))} /></div></AdvancedSection>
        </AdvancedSection>
        </>}
        {quickstart && <div className="quickstart-customize"><p className="subtle">Have a Compose file? It starts automatically. For other apps, add setup commands above or start them from the terminal.</p><button type="button" className="row-link" onClick={() => setQuickstart(false)}>Customize environment <ArrowRight /></button></div>}
        </AdvancedSection>
        <section className="creation-summary" aria-label="Environment summary">
          <dl><div><dt>Runs on</dt><dd>{!hostData ? "Loading hosting settings…" : hostData.hosting_mode === "hybrid" ? hostData.hosts.find(host => host.id === hostId)?.name || "Your hosts · automatic placement" : "Driftverk Cloud"}</dd></div><div><dt>Resources</dt><dd>{cpu} vCPU · {formatMemory(memory)}</dd></div><div><dt>Auto-stop</dt><dd>{autoStop ? `After ${autoStop} minutes of inactivity` : "Disabled · stays running"}</dd></div>{autoDelete && <div><dt>Automatic deletion</dt><dd>After {autoDelete} minutes of total lifetime, including files</dd></div>}</dl>
          {agentId && <p className="subtle">Web agent sessions keep the environment running for up to one hour.</p>}
          <CloudEstimate compact cpu={cpu} memoryMb={memory} />
        </section>
        {needsHost && <p className="form-alert"><Link to="/hosts">Connect a compute host</Link> or bring an existing host online to start your environment.</p>}
        {hostData && hostData.role !== "admin" && <p className="form-alert">Ask a workspace admin to create an environment.</p>}
        {error && <div className="form-alert form-alert-error" role="alert">{error}</div>}
      </fieldset>
      <footer className="create-modal-footer"><button type="button" className="button button-secondary" disabled={busy} onClick={() => navigate("/environments")}>Cancel</button><button className="button button-primary" disabled={cannotCreate}>{busy && <CircleNotch className="spin" />}{busy ? "Creating…" : quickstart ? "Start environment" : "Create environment"}</button></footer>
    </form>}
  </CreateEnvironmentModal>;
}


function SelectField({ icon, label, value, onChange, options }: { icon: ReactNode; label: string; value: number; onChange: (value: string) => void; options: [number, string][] }) {
  return <label className="select-card">{icon}<span><small>{label}</small><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([option, text]) => <option key={option} value={option}>{text}</option>)}</select></span></label>;
}


function EnvironmentDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const requestedTab = new URLSearchParams(location.search).get("tab");
  const [showQuickstart, setShowQuickstart] = useState(new URLSearchParams(location.search).get("quickstart") === "1");
  const [billing, setBilling] = useState<Billing | null>(null);
  useEffect(() => { let active = true; const refresh = () => api<Billing>("/api/billing").then(data => { if (active) setBilling(data); }).catch(() => { if (active) setBilling(null); }); void refresh(); const timer = window.setInterval(() => void refresh(), 15000); return () => { active = false; window.clearInterval(timer); }; }, [id]);
  const [agentTerminal, setAgentTerminal] = useState(false);
  const openedEnvironment = useRef<string | null>(null);
  useEffect(() => {
    if (!environment || openedEnvironment.current === environment.id) return;
    openedEnvironment.current = environment.id;
    if (!requestedTab && environment.agent_configuration) { setAgentTerminal(true); setTab("terminal"); }
  }, [environment, requestedTab]);
  const [tab, setTab] = useState<"logs" | "metrics" | "ports" | "terminal" | "desktop" | "settings" | "billing">(requestedTab === "desktop" || requestedTab === "logs" || requestedTab === "ports" || requestedTab === "terminal" || requestedTab === "settings" || requestedTab === "billing" ? requestedTab : "metrics");
  const [telemetry, setTelemetry] = useState<EnvironmentTelemetry>({ metrics: [], logs: [], ports: [] });
  const [telemetryError, setTelemetryError] = useState("");
  const logPanel = useRef<HTMLDivElement>(null);
  const logsPositioned = useRef(false);
  const [previewPort, setPreviewPort] = useState("80");
  const [savedPreviewPort, setSavedPreviewPort] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [resourcesBusy, setResourcesBusy] = useState(false);
  const [resourceCpu, setResourceCpu] = useState(1);
  const [resourceMemory, setResourceMemory] = useState(2048);
  useEffect(() => {
    setResourceCpu(environment?.cpu_count ?? 1);
    setResourceMemory(environment?.memory_mb ?? 2048);
  }, [id, environment?.cpu_count, environment?.memory_mb]);
  async function saveResources(event: FormEvent) {
    event.preventDefault();
    setResourcesBusy(true);
    setError("");
    try {
      await api(`/api/environments/${encodeURIComponent(id)}/resources`, {
        method: "PUT", body: JSON.stringify({ cpu: resourceCpu, memory_mb: resourceMemory }),
      });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save environment size.");
    } finally { setResourcesBusy(false); }
  }
  const [autoStop, setAutoStop] = useState<number | "">("");
  const [openingPreviewPort, setOpeningPreviewPort] = useState<number | null>(null);
  const [variableName, setVariableName] = useState("");
  const [variableValue, setVariableValue] = useState("");
  const [variableBusy, setVariableBusy] = useState("");
  const [importedVariables, setImportedVariables] = useState<Array<{ name: string; value: string }>>([]);
  const [snapshotDialogOpen, setSnapshotDialogOpen] = useState(false);
  const [snapshotError, setSnapshotError] = useState("");
  const [blueprintName, setBlueprintName] = useState<string | null>(null);
  const [blueprintError, setBlueprintError] = useState("");
  const [canSaveBlueprint, setCanSaveBlueprint] = useState(false);
  useEffect(() => {
    let active = true;
    setCanSaveBlueprint(false);
    void api<HostsData>("/api/hosts")
      .then(data => { if (active) setCanSaveBlueprint(data.role === "admin"); })
      .catch(() => { });
    return () => { active = false; };
  }, [id]);
  const [confirm, confirmationDialog] = useConfirmation();

  async function load() {
    try {
      const result = await api<{ environment: Environment }>(`/api/environments/${encodeURIComponent(id)}`);
      setEnvironment(result.environment);
      setLoadError("");
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : "Could not load the environment.");
    }
  }

  useEffect(() => { setAutoStop(environment?.auto_stop_minutes ?? ""); }, [environment?.auto_stop_minutes]);

  async function saveLifecycle(event: FormEvent) {
    event.preventDefault();
    setLifecycleBusy(true);
    setError("");
    try {
      await api(`/api/environments/${encodeURIComponent(id)}/lifecycle`, {
        method: "PUT", body: JSON.stringify({ auto_stop_minutes: autoStop || null }),
      });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save lifecycle settings.");
    } finally { setLifecycleBusy(false); }
  }

  useEffect(() => {
    void load();
    const loadTelemetry = () => api<EnvironmentTelemetry | null>(`/api/environments/${encodeURIComponent(id)}/telemetry`)
      .then((value) => {
        setTelemetry(normalizeTelemetry(value));
        setTelemetryError("");
      })
      .catch((caught) => setTelemetryError(caught instanceof Error ? caught.message : "Could not load runtime logs."));
    void loadTelemetry();
    const environmentTimer = window.setInterval(() => void load(), 5000);
    const telemetryTimer = window.setInterval(() => void loadTelemetry(), 15000);
    return () => {
      window.clearInterval(environmentTimer);
      window.clearInterval(telemetryTimer);
    };
  }, [id]);

  useEffect(() => {
    if (tab !== "logs") {
      logsPositioned.current = false;
      return;
    }
    if (logsPositioned.current || !telemetry.logs.length) return;
    logPanel.current?.scrollTo({ top: logPanel.current.scrollHeight });
    logsPositioned.current = true;
  }, [tab, telemetry.logs.length]);

  async function action(next: "start" | "stop" | "delete") {
    if (next === "stop" && environment?.agent_protection && !await confirm({ title: "Stop the agent and environment?", description: "This ends the running agent session. Files are preserved, but its processes cannot resume.", confirmLabel: "Stop environment" })) return;
    if (next === "delete" && !await confirm({ title: "Delete environment?", description: "This ends any running agent work and permanently deletes the environment. It cannot be undone.", confirmLabel: "Delete environment" })) return;
    setBusy(true);
    setSnapshotError("");
    setError("");
    try {
      await api(`/api/environments/${encodeURIComponent(id)}/actions`, { method: "POST", body: JSON.stringify({ action: next }) });
      if (next === "delete") navigate("/environments");
      else await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveBlueprint(event: FormEvent) {
    event.preventDefault();
    if (!environment || busy || !blueprintName?.trim()) return;
    setBusy(true);
    setBlueprintError("");
    const configuration: TemplateConfiguration = {
      agent_id: environment.agent_configuration?.id || null,
      agent_auth_method: environment.agent_configuration?.auth_method || "api_key",
      organization_secret_names: environment.organization_secret_names || [],
      source_type: environment.source_type,
      image: environment.source_image,
      snapshot_id: environment.snapshot_id,
      registry_id: environment.source_registry_id,
      repository: environment.repository ?? null,
      repository_branch: environment.repository_branch ?? null,
      setup_command: environment.setup_command ?? null,
      initialization_command: environment.initialization_command ?? null,
      startup_command: environment.startup_command ?? null,
      readiness_command: environment.readiness_command ?? null,
      workspace_path: environment.workspace_path, preview_enabled: environment.preview_enabled, preview_port: environment.preview_port,
      cpu: environment.cpu_count,
      memory_mb: environment.memory_mb,
      auto_stop_minutes: environment.auto_stop_minutes,
    };
    try {
      const result = await api<{ template: { id: string } }>("/api/environment-templates", {
        method: "POST", body: JSON.stringify({ name: blueprintName.trim(), configuration }),
      });
      navigate(`/environments/new?template=${encodeURIComponent(result.template.id)}`);
    } catch (caught) {
      setBlueprintError(caught instanceof Error ? caught.message : "Could not save the blueprint.");
    } finally { setBusy(false); }
  }

  async function captureSnapshot(snapshotName: string) {
    setBusy(true);
    setError("");
    try {
      const created = await api<{ id: string }>("/api/snapshots", { method: "POST", body: JSON.stringify({ environment_id: id, name: snapshotName }) });
      setSnapshotDialogOpen(false);
      navigate(`/snapshots?created=${encodeURIComponent(created.id)}`);
    } catch (caught) {
      setSnapshotError(caught instanceof Error ? caught.message : "Could not capture the snapshot.");
    } finally { setBusy(false); }
  }

  async function openPreview(port: number) {
    if (openingPreviewPort !== null) return;
    const previewWindow = window.open("about:blank", "_blank");
    if (previewWindow) previewWindow.opener = null;
    setOpeningPreviewPort(port);
    setError("");
    const stylesheetUrl = new URL(previewLoadingStylesheet, window.location.href).href;
    try {
      if (previewWindow) {
        previewWindow.document.open();
        // about:blank inherits our CSP, so the loader must use a same-origin stylesheet.
        previewWindow.document.write(previewLoadingHtml.replace("__PREVIEW_STYLESHEET__", stylesheetUrl));
        previewWindow.document.close();
      }
      const result = await apiWhenReady<{ url: string }>(`/api/environments/${encodeURIComponent(id)}/ports/${port}/preview`, { method: "POST", body: "{}" });
      if (previewWindow) previewWindow.location.href = result.url;
      else window.location.href = result.url;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not open the preview.";
      if (previewWindow && !previewWindow.closed) {
        previewWindow.document.open();
        previewWindow.document.write(previewErrorHtml
          .replace("__PREVIEW_STYLESHEET__", stylesheetUrl)
          .replace("__PREVIEW_MESSAGE__", escapePreviewMarkup(message))
          .replace("__RETURN_URL__", escapePreviewMarkup(window.location.href)));
        previewWindow.document.close();
      }
      setError(message);
    } finally { setOpeningPreviewPort(null); }
  }

  useEffect(() => {
    setSavedPreviewPort(environment?.preview_port ? String(environment.preview_port) : "");
  }, [environment?.id, environment?.preview_port]);

  async function setPreviewEnabled(enabled: boolean, port?: string) {
    setPreviewBusy(true); setError("");
    try {
      const result = await api<{ preview_enabled: boolean; preview_port: number | null }>(`/api/environments/${encodeURIComponent(id)}/preview`, { method: "PUT", body: JSON.stringify({ enabled, ...(port === undefined ? {} : { preview_port: port ? Number(port) : null }) }) });
      setEnvironment((current) => current ? { ...current, ...result } : current);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not update preview access."); }
    finally { setPreviewBusy(false); }
  }

  function previewPortSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const port = Number(previewPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError("Enter a port between 1 and 65535.");
      return;
    }
    void openPreview(port);
  }

  async function saveEnvironmentVariable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedName = variableName.trim();
    if (!normalizedName) {
      setError("Enter a variable name.");
      return;
    }
    setVariableBusy(normalizedName);
    setError("");
    try {
      await api(`/api/environments/${encodeURIComponent(id)}/environment-variables`, {
        method: "PUT",
        body: JSON.stringify({ name: normalizedName, value: variableValue }),
      });
      setVariableName("");
      setVariableValue("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the environment variable.");
    } finally {
      setVariableBusy("");
    }
  }

  async function removeEnvironmentVariable(name: string) {
    if (!await confirm({ title: `Remove ${name}?`, description: "Remove the saved value? Running processes and values set when the container was created are unchanged. Replace the environment to fully revoke those values.", confirmLabel: "Remove variable" })) return;
    setVariableBusy(name);
    setError("");
    try {
      await api(`/api/environments/${encodeURIComponent(id)}/environment-variables/${encodeURIComponent(name)}`, { method: "DELETE" });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the environment variable.");
    } finally {
      setVariableBusy("");
    }
  }

  async function saveImportedVariables() {
    setVariableBusy("import");
    setError("");
    try {
      for (const variable of importedVariables) {
        await api(`/api/environments/${encodeURIComponent(id)}/environment-variables`, { method: "PUT", body: JSON.stringify(variable) });
        setImportedVariables((current) => current.filter((item) => item.name !== variable.name));
      }
    } catch (caught) {
      setError(`Import stopped. Saved values were kept; unsaved variables remain in the form. ${caught instanceof Error ? caught.message : "Try again."}`);
    } finally { await load(); setVariableBusy(""); }
  }

  if (!environment && !loadError) return <Page><TableSkeleton /></Page>;
  if (!environment) return <Page><div className="form-alert form-alert-error">{loadError}</div></Page>;

  const running = environment.state === "running";
  const cliSshCommand = `driftverk ssh ${environment.name}`;
  const remoteAuthority = encodeURIComponent(`${environment.ssh_username}@${environment.ssh_host}:${environment.ssh_port}`);
  const editorPath = environment.workspace_path || "/";
  function openEditor(editor: "cursor" | "vscode") {
    const scheme = editor === "cursor" ? "cursor" : "vscode";
    window.location.assign(`${scheme}://vscode-remote/ssh-remote+${remoteAuthority}${editorPath}`);
  }
  const example = isExampleApp(environment);
  const primaryPort = defaultPreviewPort(environment.preview_port ?? (example ? 3000 : null), telemetry.ports);
  const pendingAction = Boolean(environment.active_operation) || environment.state === "provisioning" || environment.desired_state === "deleted";
  const nextAction = pendingAction ? "pending" : !running ? "start" : environment.application_status?.status === "failed" ? "logs" : environment.agent_configuration ? "agent" : environment.preview_enabled && primaryPort ? "preview" : "terminal";
  const nextActionLabel = nextAction === "pending" ? "Operation in progress…" : nextAction === "start" ? environment.state === "degraded" ? "Retry start" : "Start environment" : nextAction === "logs" ? "Review startup logs" : nextAction === "agent" ? `Open ${agentName(environment.agent_configuration!.id)}` : nextAction === "preview" ? "Open app" : "Open terminal";
  function openNextAction() {
    if (nextAction === "start") void action("start");
    else if (nextAction === "logs") setTab("logs");
    else if (nextAction === "preview" && primaryPort) void openPreview(primaryPort);
    else if (nextAction === "agent" || nextAction === "terminal") { setAgentTerminal(nextAction === "agent"); setTab("terminal"); }
  }
  const currentMetrics = telemetry.metrics.length ? latest(telemetry) : null;
  const cpuPercent = currentMetrics ? Math.min(100, currentMetrics.cpu_percent / Math.max(1, environment.cpu_count)) : 0;
  const recentActivity = telemetry.logs.slice(-3).reverse();
  const lastActivityAt = environment.last_activity_at || recentActivity[0]?.recorded_at || currentMetrics?.recorded_at || environment.updated_at;
  return (
    <Page>
      {snapshotDialogOpen && <SnapshotDialog hasSecrets={Boolean(environment.has_ever_received_environment_secrets)} defaultName={`${environment.name.slice(0, 54).replace(/-+$/, "")}-snapshot`} busy={busy} error={snapshotError} onClose={() => setSnapshotDialogOpen(false)} onSubmit={(name) => void captureSnapshot(name)} />}
      {blueprintName !== null && <Modal busy={busy} title="Save as blueprint" description="Reuse this source, repository branch, project commands, CPU, memory, and idle timeout. Selected organization secret names are retained. Secret values, other variables, mounted volumes, and filesystem changes are not copied." onClose={() => { if (!busy) setBlueprintName(null); }}>
        <form className="blueprint-modal-form" onSubmit={saveBlueprint}>
          <label className="field"><span>Blueprint name</span><input required maxLength={80} value={blueprintName} disabled={busy} onChange={event => setBlueprintName(event.target.value)} /></label>
          {blueprintError && <p className="form-alert form-alert-error" role="alert">{blueprintError}</p>}
          <div className="confirm-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => setBlueprintName(null)}>Cancel</button><button type="submit" className="button button-primary" disabled={busy || !blueprintName.trim()}>{busy ? "Saving…" : "Save blueprint"}</button></div>
        </form>
      </Modal>}
      {confirmationDialog}
      <div className="environment-detail">
        <div className="breadcrumbs"><Link to="/environments">Environments</Link><span>/</span><span>{environment.name}</span></div>
        <div className="detail-heading">
          <div><div className="title-with-status"><h1>{environment.name}</h1><StatusBadge state={environment.state} provisioningStep={environment.provisioning_step} computeNodeId={environment.compute_node_id} activeOperation={environment.active_operation} /></div><p className="detail-subtitle"><span className="detail-source">{environment.source_image ? formatImageName(environment.source_image) : environment.snapshot_id || "Unknown source"}</span><span>·</span>{environment.compute_host_name || (environment.compute_node_id ? "Driftverk compute" : "Awaiting host")}</p>{environment.repository && <p className="detail-repository" title={environment.workspace_path || undefined}>{environment.repository} · {environment.repository_branch}</p>}</div>
          <div className="detail-actions">
            <div className="preview-primary"><button type="button" className="button button-primary" disabled={busy || pendingAction || (running && !environment.compute_node_id) || openingPreviewPort !== null || (nextAction === "start" && environment.can_manage_actions === false)} onClick={openNextAction}>{pendingAction ? <CircleNotch className="spin" /> : nextAction === "start" ? <Play /> : nextAction === "preview" ? <GlobeHemisphereWest /> : <TerminalWindow />}{openingPreviewPort !== null && nextAction === "preview" ? "Opening preview…" : nextActionLabel}</button>{nextAction === "preview" && <span title="Anyone with the full link can open it until it expires.">Link access · 1 hour</span>}</div>
            {running && nextAction !== "preview" && <div className="preview-primary"><button className="button button-secondary" disabled={openingPreviewPort !== null || !environment.preview_enabled || !environment.compute_node_id || Boolean(environment.active_operation) || (example && !running)} onClick={() => primaryPort ? void openPreview(primaryPort) : setTab("ports")}>{openingPreviewPort !== null ? <CircleNotch className="spin" /> : <GlobeHemisphereWest />}{openingPreviewPort !== null ? "Opening preview…" : environment.preview_enabled ? primaryPort ? `Open preview · ${primaryPort}` : "Choose preview port" : "Preview disabled"}</button>{environment.preview_enabled && <span title="Anyone with the full link can open it until it expires.">Link access · 1 hour</span>}</div>}
            <ActionDropdown label="Connect" className="connect-menu">
              <button type="button" disabled={!environment.compute_node_id} onClick={() => { setAgentTerminal(false); setTab("terminal"); }}><TerminalWindow /> Open terminal</button><hr />
              <button type="button" disabled={environment.ssh_enabled === false || !environment.compute_node_id || !environment.ssh_key_count} onClick={() => openEditor("cursor")}><TerminalWindow /> Open in Cursor</button>
              <button type="button" disabled={environment.ssh_enabled === false || !environment.compute_node_id || !environment.ssh_key_count} onClick={() => openEditor("vscode")}><TerminalWindow /> Open in VS Code</button>
              <CopyAction icon={<Copy />} label="Copy Driftverk CLI command" value={cliSshCommand} disabled={environment.ssh_enabled === false || !environment.compute_node_id || !environment.ssh_key_count} />
              {environment.ssh_enabled === false ? <div className="connect-help"><p>SSH connections are disabled.</p><button type="button" onClick={() => setTab("settings")}>Open environment settings</button></div> : !environment.ssh_key_count && <div className="connect-help"><p>Add an SSH key to connect from your editor.</p><Link to="/settings"><Key /> Add SSH key</Link></div>}
              {!environment.compute_node_id && <p className="connect-help">Connection becomes available when a compute host is assigned.</p>}
            </ActionDropdown>
            <ActionDropdown label="More">
              {canSaveBlueprint && <button type="button" disabled={busy} onClick={() => { setBlueprintError(""); setBlueprintName(environment.name); }}><Blueprint /> Save as blueprint</button>}
              <button type="button" disabled={busy || environment.can_manage_actions === false || Boolean(environment.active_operation)} onClick={() => void action(running ? "stop" : "start")}>{running ? <Pause /> : <Play />}{running ? "Stop environment" : environment.state === "degraded" && ["cloning", "setting-up", "initializing", "starting-services", "checking-app"].includes(environment.provisioning_step) ? "Retry setup" : "Start environment"}</button>
              <button type="button" title={environment.state !== "stopped" ? "Stop the environment before creating a snapshot" : undefined} disabled={busy || !environment.can_manage_lifecycle || !environment.runtime_id || Boolean(environment.active_operation) || environment.state !== "stopped"} onClick={() => { setSnapshotError(""); setSnapshotDialogOpen(true); }}><FloppyDisk /> Create snapshot</button><hr />
              <button type="button" className="action-menu-danger" disabled={busy || environment.can_manage_actions === false} onClick={() => void action("delete")}><Trash /> Delete environment</button>
            </ActionDropdown>
          </div>
        </div>
        {error && <div className="form-alert form-alert-error">{error}</div>}
        {loadError && <div className="form-alert form-alert-error">{loadError}</div>}
        <EnvironmentHostHealth nodeId={environment.compute_node_id} />
        {environment.has_ever_received_environment_secrets && <div className="notice notice-warning">This environment has received environment variables. A snapshot may include their values. Only continue if copying them into future environments is intentional.</div>}
        {showQuickstart && !example && running && !environment.active_operation && <section className="data-panel quickstart-next" aria-labelledby="quickstart-next-heading">
          <div><p className="eyebrow">Ready to work</p><h2 id="quickstart-next-heading">Your environment is running.</h2><p>Open the terminal to run commands or your coding agent. Use Connect above to open your editor.</p></div>
          <div className="development-actions"><button className="button button-primary" onClick={() => { setAgentTerminal(false); setTab("terminal"); }}><TerminalWindow /> Open terminal</button><Link className="button button-secondary" to="/docs/codex-and-t3-code">Connect your agent <ArrowRight /></Link><button type="button" className="button button-quiet" onClick={() => { setShowQuickstart(false); const next = new URLSearchParams(location.search); next.delete("quickstart"); navigate({ pathname: location.pathname, search: next.toString() }, { replace: true }); }}>Got it</button></div>
        </section>}
        {example && environment.active_operation !== "stop" && <section className="data-panel example-guide" aria-label="Try your example app">
          <div className="example-guide-heading"><div><span className="eyebrow">Example app</span><h2>{running && !environment.active_operation ? "Ready to try" : "Starting up"}</h2></div><Link to="/environments/new">Use your repository <ArrowRight /></Link></div>
          <p>{running && !environment.active_operation ? "Open the preview above to try the counter." : "The preview becomes available after the startup check passes."}</p>
          <details className="example-edit-guide"><summary><span><strong>Change the heading</strong><small>Edit the running app from Terminal</small></span><CaretDown aria-hidden="true" /></summary><div className="example-edit-body"><pre><code>{exampleEditCommand}</code></pre><div className="development-actions"><CopyAction className="button button-secondary copy-action" icon={<Copy />} label="Copy command" value={exampleEditCommand} /><button className="button button-secondary" disabled={!running} onClick={() => { setAgentTerminal(false); setTab("terminal"); }}><TerminalWindow /> Open Terminal</button></div></div></details>
        </section>}
        {environment.active_operation === "stop" && <section className="project-progress data-panel" aria-label="Environment shutdown">
          <div className="setup-heading"><strong role="status"><Pause aria-hidden="true" /> Stopping environment…</strong><button type="button" className="text-button" onClick={() => setTab("logs")}>View logs <ArrowRight aria-hidden="true" /></button></div>
        </section>}
        {(!environment.active_operation || environment.active_operation === "create" || environment.active_operation === "start") && (environment.state === "provisioning" || environment.state === "degraded") && <section className="project-progress data-panel" aria-label="Environment setup">
          <div className="setup-heading"><strong role="status">{environment.state === "degraded" ? "Setup needs attention" : !environment.compute_node_id ? "Waiting for compute" : projectStepLabel(environment.provisioning_step)}</strong><button type="button" className="text-button" onClick={() => setTab("logs")}>View logs <ArrowRight aria-hidden="true" /></button></div>
          <SetupProgress environment={environment} />
          {environment.queue_reason === "insufficient_capacity" && <p className="setup-capacity">Not enough CPU or memory. Stop an environment or <Link to="/hosts">add compute</Link>.</p>}
          {environment.state === "degraded" && <><details className="setup-details"><summary>Setup details</summary><p>Command: <code>{environment.provisioning_step === "setting-up" ? environment.setup_command : environment.provisioning_step === "initializing" ? environment.initialization_command : environment.provisioning_step === "starting-services" ? environment.startup_command || "Automatic Compose startup" : environment.provisioning_step === "checking-app" ? environment.readiness_command || "Automatic Compose readiness check" : "Git clone"}</code></p><p>Logs: <code>/var/lib/driftverk/setup-{environment.id}/</code></p>{environment.error_message && <p className="setup-error">{environment.error_message}</p>}</details><div className="development-actions"><button className="button button-secondary" onClick={() => { setAgentTerminal(false); setTab("terminal"); }}>Open terminal</button><button className="button button-primary" disabled={busy || environment.can_manage_actions === false || Boolean(environment.active_operation)} onClick={() => void action("start")}>Retry setup</button></div></>}
        </section>}
        {environment.error_message && environment.state !== "degraded" && <div className="form-alert form-alert-error">{environment.error_message}</div>}

        {running && environment.agent_protection && <div className="form-alert" role="status">Agent session protected until {new Date(environment.agent_protection.expires_at).toLocaleTimeString()}. Closing this tab keeps it running. The agent ends at this deadline; compute remains billable while running.</div>}
        {running && (environment.repository || environment.startup_command || environment.readiness_command) && <section className="project-progress data-panel" aria-label="Application status">
          <div className="setup-heading"><strong role="status">{environment.application_status?.status === "failed" ? "Application needs attention" : environment.application_status?.status === "starting" ? "Application starting" : environment.application_status?.status === "ready" ? "Project services running" : environment.readiness_command ? "Startup readiness check passed" : "Application readiness unverified"}</strong><button type="button" className="text-button" onClick={() => setTab("logs")}>View logs <ArrowRight aria-hidden="true" /></button></div>
          {environment.application_status ? <><p>{environment.application_status.message}</p><p>Services without health checks are checked for process state only. Verify the application through its preview.</p>{environment.application_status_at && <small>Last checked {new Date(environment.application_status_at).toLocaleTimeString()}</small>}</> : <p>{environment.readiness_command ? "This check ran at startup; it is not continuous application monitoring." : "Add a readiness command or Compose health checks to verify your application."}</p>}
        </section>}

        <div className="environment-workspace">
          <div className="environment-primary">
            <section className="runtime-console">
              <div className="console-tabs" role="tablist" aria-label="Runtime information" onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
                const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
                const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
                event.preventDefault(); tabs[next]?.focus(); tabs[next]?.click();
              }}>
                {environment.agent_configuration && <button id="runtime-tab-agent" type="button" role="tab" aria-controls="runtime-panel-terminal" aria-selected={tab === "terminal" && agentTerminal} className={tab === "terminal" && agentTerminal ? "active" : ""} onClick={() => { setAgentTerminal(true); setTab("terminal"); }}>{agentName(environment.agent_configuration.id)}</button>}
                <button id="runtime-tab-metrics" type="button" role="tab" aria-controls="runtime-panel-metrics" aria-selected={tab === "metrics"} className={tab === "metrics" ? "active" : ""} onClick={() => setTab("metrics")}>Metrics</button>
                <button id="runtime-tab-logs" type="button" role="tab" aria-controls="runtime-panel-logs" aria-selected={tab === "logs"} className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}>Logs</button>
                <button id="runtime-tab-ports" type="button" role="tab" aria-controls="runtime-panel-ports" aria-selected={tab === "ports"} className={tab === "ports" ? "active" : ""} onClick={() => setTab("ports")}>Ports</button>
                <button id="runtime-tab-terminal" type="button" role="tab" aria-controls="runtime-panel-terminal" aria-selected={tab === "terminal" && !agentTerminal} className={tab === "terminal" && !agentTerminal ? "active" : ""} onClick={() => { setAgentTerminal(false); setTab("terminal"); }}>Terminal</button>
                <button id="runtime-tab-desktop" type="button" role="tab" aria-controls="runtime-panel-desktop" aria-selected={tab === "desktop"} className={tab === "desktop" ? "active" : ""} onClick={() => setTab("desktop")}>Desktop</button>
                {billing?.hosting_mode === "managed" && <button id="runtime-tab-billing" type="button" role="tab" aria-controls="runtime-panel-billing" aria-selected={tab === "billing"} className={tab === "billing" ? "active" : ""} onClick={() => setTab("billing")}>Billing</button>}
                <button id="runtime-tab-settings" type="button" role="tab" aria-controls="runtime-panel-settings" aria-selected={tab === "settings"} className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Settings</button>
              </div>
              {tab === "billing" && <div id="runtime-panel-billing" role="tabpanel" aria-labelledby="runtime-tab-billing">{billing ? billing.hosting_mode === "managed" ? <CloudUsage data={billing} environmentId={id} /> : <p className="billing-card">Compute and storage run on your own infrastructure. <Link to="/billing">View Hybrid plan</Link></p> : <p className="billing-card" role="status">Billing is unavailable. <Link to="/billing">Open organization billing</Link></p>}</div>}
              {tab === "logs" && <div id="runtime-panel-logs" role="tabpanel" aria-labelledby="runtime-tab-logs" className="console-view"><div ref={logPanel} className="log-panel">{telemetry.logs.map((entry, index) => <div className={`log-line${entry.severity === "error" ? " log-error" : ""}`} key={`${entry.recorded_at}-${index}`}><span>{new Date(entry.recorded_at).toLocaleString()}</span><em>{entry.severity.toUpperCase()}</em><code>{entry.message}</code></div>)}{telemetryError && <div className="console-empty console-error">Logs are unavailable: {telemetryError}</div>}{!telemetryError && !telemetry.logs.length && <div className="console-empty">Waiting for runtime output.</div>}</div></div>}
              {tab === "metrics" && <div id="runtime-panel-metrics" role="tabpanel" aria-labelledby="runtime-tab-metrics" className="console-view"><div className="metrics-grid">{environment.state === "stopped" ? (
                <div className="console-empty console-empty-light metrics-stopped">
                  <p>This environment is stopped. Start it to see runtime metrics.</p>
                  <button type="button" className="button button-primary" disabled={busy || environment.can_manage_actions === false || Boolean(environment.active_operation)} onClick={() => void action("start")}>
                    <Play /> Start environment
                  </button>
                </div>
              ) : telemetry.metrics.length ? <><MetricCard key={`cpu-${currentMetrics?.recorded_at}`} label="CPU" value={`${latest(telemetry).cpu_percent.toFixed(2)}%`} percent={Math.min(100, latest(telemetry).cpu_percent / environment.cpu_count)} /><MetricCard key={`memory-${currentMetrics?.recorded_at}`} label="Memory" value={`${latest(telemetry).memory_usage_mb.toFixed(0)} MB · ${latest(telemetry).memory_percent.toFixed(1)}%`} percent={latest(telemetry).memory_percent} /><MetricCard key={`filesystem-${currentMetrics?.recorded_at}`} label="Filesystem" value={`${latest(telemetry).filesystem_percent.toFixed(1)}%`} percent={latest(telemetry).filesystem_percent} /></> : <div className="console-empty console-empty-light">Metrics will appear when the environment is ready.</div>}</div></div>}
              {tab === "ports" && <div id="runtime-panel-ports" role="tabpanel" aria-labelledby="runtime-tab-ports" className="console-view"><div className="ports-panel">
                <div className="ports-intro"><h2>Ports</h2><p>{environment.preview_enabled ? "Preview links expire after 1 hour. Anyone with the full link can open them." : "HTTP preview is disabled for this environment. Enable it in Settings to create a link."}</p></div>
                {telemetry.ports.length ? <div className="ports-list"><div className="ports-header"><span>Port</span><span>Protocol</span><span>Status</span><span /></div>{telemetry.ports.map((entry) => <div className="port-row" key={entry.port}><strong className="mono">{entry.port}{entry.port === environment.preview_port && <small className="default-port-label">Default</small>}</strong><span>{entry.protocol.toUpperCase()}</span><span className="port-listening"><i /> Listening</span><button className="row-link" disabled={openingPreviewPort !== null || !environment.preview_enabled || !environment.compute_node_id} onClick={() => void openPreview(entry.port)}>{openingPreviewPort === entry.port ? "Opening…" : "Open"} <ArrowRight /></button></div>)}</div> : <div className="ports-empty">{telemetryError ? "Listening ports could not be loaded. You can still preview a known HTTP port." : "No listening ports detected yet. Preview a known HTTP port below."}</div>}
                <details className="manual-preview" open={environment.preview_enabled && (telemetry.ports.length === 0 || undefined)}><summary>Preview another port <CaretDown /></summary><form className="preview-port-form" onSubmit={previewPortSubmit}>
                  <label htmlFor="preview-port"><strong>Preview a port</strong><span>Enter the HTTP port used inside the environment.</span></label>
                  <input id="preview-port" type="number" min="1" max="65535" inputMode="numeric" value={previewPort} onChange={(event) => setPreviewPort(event.target.value)} aria-label="HTTP port" />
                  <button className="button button-secondary" type="submit" disabled={openingPreviewPort !== null || !environment.preview_enabled || !environment.compute_node_id}>{openingPreviewPort !== null ? <CircleNotch className="spin" /> : <GlobeHemisphereWest />}{openingPreviewPort !== null ? "Opening…" : "Open preview"}</button>
                  <p className="subtle">The service must listen on 0.0.0.0 and start with the container to recover automatically after a stop.</p>
                </form></details>
              </div></div>}
              {tab === "terminal" && <div id="runtime-panel-terminal" role="tabpanel" aria-labelledby={agentTerminal ? "runtime-tab-agent" : "runtime-tab-terminal"} className="console-view">{agentTerminal && !environment.compute_node_id ? <p className="console-empty" role="status">Preparing your environment. The agent will open when compute is assigned.</p> : <WebTerminal key={agentTerminal ? "agent" : "shell"} agent={agentTerminal && Boolean(environment.agent_configuration)} agentLabel={environment.agent_configuration ? agentName(environment.agent_configuration.id) : undefined} environmentId={id} showProjectLogs={Boolean(environment.repository || environment.workspace_path || environment.initialization_command || environment.setup_command || environment.startup_command || environment.readiness_command)} running={running || (environment.state === "degraded" && Boolean(environment.runtime_id) && ["cloning", "setting-up", "initializing", "starting-services", "checking-app"].includes(environment.provisioning_step))} />}</div>}
              {tab === "desktop" && <div id="runtime-panel-desktop" role="tabpanel" aria-labelledby="runtime-tab-desktop"><Desktop key={id} environment={environment} /></div>}
              {tab === "settings" && <div id="runtime-panel-settings" role="tabpanel" aria-labelledby="runtime-tab-settings" className="environment-settings">
                <EnvironmentAccess key={id} environment={environment} onSshChange={ssh_enabled => setEnvironment(current => current ? { ...current, ssh_enabled } : current)} />
                <OverviewSection title="Preview access">
                  <label className="setting-toggle"><input type="checkbox" role="switch" aria-label="HTTP preview" checked={environment.preview_enabled} disabled={previewBusy || !environment.can_manage_configuration} onChange={(event) => void setPreviewEnabled(event.target.checked)} /><span><strong>HTTP preview</strong><small>Links expire after 1 hour. Anyone with the full link can open them.</small></span></label>
                  {!environment.can_manage_configuration && <p className="subtle">{environment.can_manage_lifecycle ? "Preview settings require a trusted environment." : "An organization admin can change preview settings."}</p>}
                  <form className="default-preview-form" onSubmit={event => { event.preventDefault(); void setPreviewEnabled(environment.preview_enabled, savedPreviewPort); }}>
                    <label className="field"><span>Default preview port <small>Optional</small></span><input type="number" min="1" max="65535" step="1" inputMode="numeric" value={savedPreviewPort} onChange={event => setSavedPreviewPort(event.target.value)} disabled={!environment.preview_enabled || previewBusy || !environment.can_manage_configuration} placeholder="Detect automatically" /></label>
                    <button className="button button-secondary" disabled={!environment.preview_enabled || previewBusy || !environment.can_manage_configuration || savedPreviewPort === (environment.preview_port ? String(environment.preview_port) : "")}>Save port</button>
                  </form>
                  <p className="subtle">{environment.preview_enabled ? "Leave the port empty to detect a web service automatically." : "Enable HTTP preview to use the default port. Your saved port is kept while previews are off."}</p>
                </OverviewSection>
                <OverviewSection title="Size">
                  <p className="subtle">Stop the environment to change CPU and memory. The new limits apply on the next start. Your files are kept.</p>
                  {!environment.can_manage_lifecycle && <p className="subtle">An organization admin can change the size.</p>}
                  <form className="environment-size-form" onSubmit={saveResources}>
                    <fieldset disabled={resourcesBusy || !environment.can_manage_lifecycle || environment.state !== "stopped" || Boolean(environment.active_operation)}>
                      <div className="resource-presets" aria-label="Environment size">
                        {RESOURCE_SIZES.map(size => <button key={size.name} type="button" aria-pressed={resourceCpu === size.cpu && resourceMemory === size.memoryMb} onClick={() => { setResourceCpu(size.cpu); setResourceMemory(size.memoryMb); }}><strong>{size.name}</strong><span>{size.cpu} vCPU · {formatMemory(size.memoryMb)}</span></button>)}
                      </div>
                      <div className="resource-selects">
                        <SelectField icon={<Cpu />} label="vCPU limit" value={resourceCpu} onChange={value => setResourceCpu(Number(value))} options={[[1, "1"], [2, "2"], [4, "4"], [8, "8"]]} />
                        <SelectField icon={<HardDrives />} label="Memory limit" value={resourceMemory} onChange={value => setResourceMemory(Number(value))} options={[[1024, "1 GB"], [2048, "2 GB"], [4096, "4 GB"], [8192, "8 GB"], [16384, "16 GB"]]} />
                      </div>
                      <button className="button button-secondary" disabled={resourceCpu === environment.cpu_count && resourceMemory === environment.memory_mb}>{resourcesBusy ? "Saving…" : "Save size"}</button>
                    </fieldset>
                  </form>
                  <p className="subtle">Shared disk storage, no per-environment limit.</p>
                </OverviewSection>
                <OverviewSection title="Lifecycle">
                  <form className="default-preview-form" onSubmit={saveLifecycle}>
                    <DurationField label="Stop after inactivity" value={autoStop} onChange={setAutoStop} disabled={lifecycleBusy || !environment.can_manage_lifecycle} />
                    <button className="button button-secondary" disabled={lifecycleBusy || !environment.can_manage_lifecycle || autoStop === (environment.auto_stop_minutes ?? "")}>{lifecycleBusy ? "Saving…" : "Save"}</button>
                  </form>
                  <OverviewRow label="Delete at" value={environment.auto_delete_minutes ? new Date(new Date(environment.created_at).getTime() + environment.auto_delete_minutes * 60_000).toLocaleString() : "Disabled"} />
                </OverviewSection>
                {Boolean(environment.volume_mounts?.length) && <OverviewSection title="Volumes">
                  <div className="overview-volume-list">{environment.volume_mounts!.map((mount) => <div key={mount.mount_path}><FolderOpen /><span><strong>{mount.volume_name}</strong><small className="mono">{mount.mount_path}{mount.subpath ? ` · ${mount.subpath}` : ""}</small></span><em>{mount.read_only ? "Read only" : "Read/write"}</em></div>)}</div>
                </OverviewSection>}
                <OverviewSection title="Environment variables">
                  <div className="overview-variable-list">
                    {environment.environment_variable_names?.length ? environment.environment_variable_names.map((name) => <div key={name}><span><strong className="mono">{name}</strong><small>Value stored securely</small></span>{environment.can_manage_configuration && <button type="button" className="overview-variable-remove" disabled={Boolean(variableBusy)} onClick={() => void removeEnvironmentVariable(name)} aria-label={`Remove ${name}`}><Trash /></button>}</div>) : <p>No environment variables configured.</p>}
                  </div>
                  {environment.can_manage_configuration && <fieldset disabled={Boolean(variableBusy)} className="variable-edit-fields"><EnvImport existingNames={[...(environment.environment_variable_names || []), ...importedVariables.map((variable) => variable.name)]} onImport={(variables) => setImportedVariables((current) => mergeImportedVariables(current, variables))} />{importedVariables.length > 0 && <div className="pending-import"><p>{importedVariables.length} variables ready to save</p><ul className="import-names">{importedVariables.map((variable) => <li key={variable.name}><code>{variable.name}</code><button type="button" className="icon-button" aria-label={`Discard ${variable.name}`} onClick={() => setImportedVariables((current) => current.filter((item) => item.name !== variable.name))}><X /></button></li>)}</ul><button type="button" className="button button-primary" onClick={() => void saveImportedVariables()}>Save imported variables</button></div>}</fieldset>}
                  {environment.can_manage_configuration && <form className="overview-variable-form" autoComplete="off" onSubmit={saveEnvironmentVariable}>
                    <label><span>Name</span><input name="environment-variable-name" autoComplete="off" data-1p-ignore value={variableName} onChange={(event) => setVariableName(event.target.value)} placeholder="DATABASE_URL" pattern="[A-Za-z_][A-Za-z0-9_]*" required /></label>
                    <label><span>Value</span><input name="environment-variable-value" autoComplete="new-password" data-1p-ignore data-lpignore="true" value={variableValue} onChange={(event) => setVariableValue(event.target.value)} placeholder="Stored encrypted" type="password" /></label>
                    <button className="button button-secondary" disabled={Boolean(variableBusy)}>{variableBusy ? <CircleNotch className="spin" /> : <Plus />}{environment.environment_variable_names?.includes(variableName.trim()) ? "Replace value" : "Add variable"}</button>
                  </form>}
                </OverviewSection>
              </div>}
            </section>
          </div>
          <aside className="environment-overview" aria-label="Environment overview">
            <OverviewSection title="Overview">
              <OverviewRow label="Source" value={environment.source_image ? formatImageName(environment.source_image) : environment.snapshot_id || "Unknown"} mono />
              <OverviewRow label="Host" value={environment.compute_host_name || (environment.compute_node_id ? "Driftverk compute" : "Awaiting host")} />
              <OverviewRow label="Last activity" value={timeAgo(lastActivityAt)} />
            </OverviewSection>
            <OverviewSection title="Resources">
              <p className="resource-size-name">{formatResourceSize(environment.cpu_count, environment.memory_mb)}</p>
              <div className="compact-resources"><span><Cpu />{environment.cpu_count} vCPU</span><span><HardDrives />{formatMemory(environment.memory_mb)}</span></div>
              <OverviewUsage key={`cpu-${currentMetrics?.recorded_at}`} label="CPU" value={currentMetrics ? `${currentMetrics.cpu_percent.toFixed(1)}%` : "Waiting"} percent={cpuPercent} />
              <OverviewUsage key={`memory-${currentMetrics?.recorded_at}`} label="Memory" value={currentMetrics ? `${currentMetrics.memory_usage_mb.toFixed(0)} MB` : "Waiting"} percent={currentMetrics?.memory_percent || 0} />
              <OverviewUsage key={`disk-${currentMetrics?.recorded_at}`} label="Filesystem usage" value={currentMetrics ? `${currentMetrics.filesystem_percent.toFixed(1)}%` : "Waiting"} percent={currentMetrics?.filesystem_percent || 0} />
            </OverviewSection>
            <OverviewSection title="Lifecycle"><OverviewRow label="Auto-stop" value={formatMinutes(environment.auto_stop_minutes)} /><button type="button" className="overview-inline-action" onClick={() => setTab("settings")}>Settings <ArrowRight /></button></OverviewSection>
          </aside>
        </div>
      </div>
    </Page>
  );
}

function CopyAction({ icon, label, value, compact = false, disabled = false, className }: { icon?: ReactNode; label: string; value: string; compact?: boolean; disabled?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  return <button type="button" className={className || (compact ? "overview-inline-action copy-action" : "access-action copy-action")} disabled={disabled} title={value} aria-label={compact ? `Copy ${label}` : undefined} onClick={async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setCopyFailed(false); }
    catch { setCopyFailed(true); }
    window.setTimeout(() => { setCopied(false); setCopyFailed(false); }, 2000);
  }}>{icon}{copied ? <Check className="copy-feedback" /> : compact ? <Copy /> : null}<span aria-live="polite">{copyFailed ? "Could not copy" : copied ? "Copied" : label}</span></button>;
}

function OverviewSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="overview-section"><h2>{title}</h2>{children}</section>;
}

function OverviewRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="overview-row"><span>{label}</span><strong className={mono ? "mono" : ""}>{value}</strong></div>;
}

function OverviewUsage({ label, value, percent }: { label: string; value: string; percent: number }) {
  return <div className="overview-usage"><div><span>{label}</span><strong>{value}</strong></div><div className="overview-usage-track" aria-hidden="true"><i style={{ transform: `scaleX(${Math.max(0, Math.min(100, percent)) / 100})` }} /></div></div>;
}

function WebTerminal({ environmentId, running, showProjectLogs = false, agent = false, agentLabel }: { environmentId: string; running: boolean; showProjectLogs?: boolean; agent?: boolean; agentLabel?: string }) {
  const [connectionError, setConnectionError] = useState("");
  const diagnosticSocket = useRef<WebSocket | null>(null);
  const mount = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState(0);
  const [active, setActive] = useState(agent);
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "failed">("idle");

  useEffect(() => {
    if (!active || !mount.current) return;
    setStatus("connecting");
    setConnectionError("");
    const terminal = new XTerm({
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: {
        background: "#071f1b",
        foreground: "#dce9e4",
        cursor: "#d8ff47",
        cursorAccent: "#071f1b",
        selectionBackground: "#286456",
        black: "#071f1b",
        green: "#9edc78",
        brightGreen: "#d8ff47",
        blue: "#78b7dc",
        brightBlue: "#a8d8f5",
        red: "#ef8d85",
        brightRed: "#ffb0aa",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(mount.current);
    fit.fit();
    let disposed = false;
    const accessAbort = new AbortController();
    let socket: WebSocket | null = null;
    let inputSubscription: { dispose: () => void } | null = null;
    const observer = new ResizeObserver(() => {
      fit.fit();
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
    });
    observer.observe(mount.current);

    void apiWhenReady<{ token: string; websocket_path: string }>(`/api/environments/${encodeURIComponent(environmentId)}/terminal-ticket`, { method: "POST", body: JSON.stringify({ agent }), signal: accessAbort.signal })
      .then((ticket) => {
        if (disposed) return;
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(`${protocol}//${window.location.host}${ticket.websocket_path}?token=${encodeURIComponent(ticket.token)}`);
        socket.binaryType = "arraybuffer";
        socket.onopen = () => {
          setStatus("connected");
          diagnosticSocket.current = socket;
          socket?.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
          inputSubscription = terminal.onData((data) => socket?.readyState === WebSocket.OPEN && socket.send(new TextEncoder().encode(data)));
          terminal.focus();
        };
        socket.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) terminal.write(new Uint8Array(event.data));
        };
        socket.onerror = () => setStatus("failed");
        socket.onclose = (event) => {
          setStatus(event.code === 1000 ? "idle" : "failed");
          if (!agent) setActive(false);
          if (event.code !== 1000) setConnectionError(event.reason || "Could not open the session. Check that the compute host is online and up to date.");
        };
      })
      .catch((caught) => {
        if (disposed) return;
        setStatus("failed");
        setActive(false);
        setConnectionError(caught instanceof Error ? caught.message : "Could not open terminal.");
        terminal.writeln(`\r\n${caught instanceof Error ? caught.message : "Could not open terminal."}`);
      });

    return () => {
      disposed = true;
      accessAbort.abort();
      observer.disconnect();
      inputSubscription?.dispose();
      diagnosticSocket.current = null;
      socket?.close(1000, "Terminal tab closed");
      terminal.dispose();
    };
  }, [active, environmentId, session, agent]);

  function connect() {
    setSession((value) => value + 1);
    setActive(true);
  }

  const statusLabel = !running ? active ? "Starting environment" : "Environment stopped" : status === "connecting" ? "Connecting" : status === "connected" ? "Connected" : status === "failed" ? "Connection failed" : "Not connected";
  return <div className="terminal-panel">
    <div className="terminal-header">
      <span><TerminalWindow /> {agent ? agentLabel : "Web terminal"}</span>
      {agent && <small>Sessions last up to one hour, including time waiting for input. Reopening does not extend the deadline.</small>}
      {showProjectLogs && !agent && <button type="button" disabled={status !== "connected"} onClick={() => {
        const marker = `/var/lib/driftverk/setup-${environmentId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
        const command = `tail -n 80 -- '${marker}/initialize.log' '${marker}/setup.log' '${marker}/startup.log' '${marker}/readiness.log'\n`;
        if (diagnosticSocket.current?.readyState === WebSocket.OPEN) diagnosticSocket.current.send(new TextEncoder().encode(command));
      }}>Show project output</button>}
      {active && status !== "connecting" && status !== "connected" && <button type="button" onClick={connect}>Reconnect</button>}
      <span><i className={`terminal-status terminal-status-${status}`} />{statusLabel}{status === "connected" && <button type="button" onClick={() => setActive(false)}>Disconnect</button>}</span>
    </div>
    {connectionError && <p role="alert" className="form-alert form-alert-error">{connectionError}</p>}
    {active ? <div className="web-terminal" ref={mount} /> : <div className="terminal-connect">
      <div className="terminal-connect-icon"><TerminalWindow /></div>
      <strong>{running ? "Connect to this environment" : "Start and connect to this environment"}</strong>
      <p>{running ? "Open an interactive shell in the running container. Closing this tab disconnects the session." : "The environment will start automatically, then the terminal will connect."}</p>
      <button className="button terminal-connect-button" type="button" onClick={connect}><TerminalWindow />{status === "failed" ? "Try again" : agent ? `Open ${agentLabel}` : running ? "Connect" : "Start and connect"}</button>
    </div>}
  </div>;
}

function MetricCard({ label, value, percent }: { label: string; value: string; percent: number }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong><div className="metric-track"><i style={{ width: `${Math.max(1, Math.min(100, percent))}%` }} /></div></div>;
}

function latest(telemetry: EnvironmentTelemetry) { return telemetry.metrics[telemetry.metrics.length - 1]!; }

function normalizeTelemetry(value: EnvironmentTelemetry | null): EnvironmentTelemetry {
  const metrics = Array.isArray(value?.metrics) ? value.metrics.map((sample) => ({
    ...sample,
    cpu_percent: Number(sample.cpu_percent),
    memory_usage_mb: Number(sample.memory_usage_mb),
    memory_percent: Number(sample.memory_percent),
    filesystem_percent: Number(sample.filesystem_percent),
  })).filter((sample) => [sample.cpu_percent, sample.memory_usage_mb, sample.memory_percent, sample.filesystem_percent].every(Number.isFinite)) : [];
  return {
    metrics,
    logs: Array.isArray(value?.logs) ? value.logs : [],
    ports: Array.isArray(value?.ports) ? value.ports : [],
  };
}

function formatImageName(reference: string) {
  if (/^(?:ghcr\.io\/simskii\/dev|driftverk-dev)(?::|@|$)/.test(reference)) return "Driftverk Dev";
  if (/^sha256:[a-f0-9]{64}$/i.test(reference)) return `sha256:${reference.slice(7, 19)}…`;
  const [image, digest] = reference.split("@sha256:");
  const name = image?.split("/").pop() || "Image";
  return digest ? `${name}@${digest.slice(0, 12)}…` : name;
}

const RESOURCE_SIZES = [
  { name: "Small", cpu: 1, memoryMb: 2048 },
  { name: "Medium", cpu: 2, memoryMb: 4096 },
  { name: "Large", cpu: 4, memoryMb: 8192 },
] as const;

function formatResourceSize(cpu: number, memoryMb: number) {
  return RESOURCE_SIZES.find(size => size.cpu === cpu && size.memoryMb === memoryMb)?.name || "Custom";
}

function SnapshotsPage() {
  const location = useLocation();
  const createdId = new URLSearchParams(location.search).get("created");
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [deletingId, setDeletingId] = useState("");
  const [confirm, confirmationDialog] = useConfirmation();

  async function remove(snapshot: Snapshot) {
    if (!await confirm({
      title: "Delete snapshot?",
      description: `${snapshot.name} will no longer be available when creating environments. Existing environments keep running, and any prebuild tied to this snapshot will also be removed.`,
      confirmLabel: "Delete snapshot",
    })) return;
    setDeletingId(snapshot.id);
    setError("");
    try {
      await api(`/api/snapshots/${encodeURIComponent(snapshot.id)}`, { method: "DELETE" });
      setSnapshots((current) => current?.filter((item) => item.id !== snapshot.id) ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the snapshot.");
    } finally {
      setDeletingId("");
    }
  }

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await api<{ snapshots: Snapshot[] }>("/api/snapshots");
        if (!cancelled) {
          setSnapshots(result.snapshots);
          setError("");
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load snapshots.");
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 3000);
      }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [retry]);

  const visibleSnapshots = snapshots?.filter(snapshot => !snapshot.is_system || snapshot.is_default) ?? null;

  return <Page>
    {confirmationDialog}
    <PageHeader title="Snapshots" description="Start environments from system snapshots or your saved filesystems." />
    {createdId && snapshots?.find(snapshot => snapshot.id === createdId)?.status === "building" && <p className="form-alert" role="status"><CircleNotch className="spin" /> Creating your snapshot. It will be available to launch when capture finishes.</p>}
    {createdId && snapshots?.find(snapshot => snapshot.id === createdId)?.status === "ready" && <p className="form-alert" role="status">Your snapshot is ready. <Link to={`/environments/new?snapshot=${encodeURIComponent(createdId)}`}>Launch environment <ArrowRight /></Link></p>}
    {error && (!snapshots ? <LoadError message={error} onRetry={() => { setError(""); setRetry(value => value + 1); }} /> : <div className="form-alert form-alert-error" role="alert">{error}</div>)}
    {!visibleSnapshots ? (!error && <TableSkeleton />) : visibleSnapshots.length === 0 ? <section className="empty-state data-panel"><div className="empty-icon"><Stack /></div><h2>No snapshots yet</h2><p>Create an environment from an image, install your tools, then create a snapshot to reuse it.</p></section> : <section className="data-panel environment-table-wrap snapshot-table-wrap"><table className="data-table"><thead><tr><th>Snapshot</th><th>Status</th><th>Type</th><th>Base image</th><th>Size</th><th>Created</th><th>Actions</th></tr></thead><tbody>{visibleSnapshots.map((snapshot) => <tr key={snapshot.id}><td><strong>{snapshot.is_system ? "Driftverk Dev" : snapshot.name}</strong></td><td><StatusBadge state={snapshot.status} />{snapshot.error_message && <p className="form-alert-error">{snapshot.error_message}</p>}</td><td>{snapshot.is_system ? "System" : snapshot.kind === "base" ? "Base" : "Filesystem"}</td><td className="mono snapshot-image">{snapshot.is_system ? "Driftverk Dev" : formatImageName(snapshot.base_image)}</td><td>{snapshot.snapshot_size_gb ? `${snapshot.snapshot_size_gb.toFixed(1)} GB` : "—"}</td><td>{timeAgo(snapshot.created_at)}</td><td><div className="table-actions">{snapshot.status === "ready" && <Link className="button button-secondary" to={`/environments/new?snapshot=${encodeURIComponent(snapshot.id)}`}>Create environment</Link>}{!snapshot.is_system && <button type="button" className="icon-button danger" disabled={Boolean(deletingId)} onClick={() => void remove(snapshot)} aria-label={`Delete ${snapshot.name}`}>{deletingId === snapshot.id ? <CircleNotch className="spin" /> : <Trash />}</button>}</div></td></tr>)}</tbody></table></section>}
  </Page>;
}

function VolumesPage() {
  const [volumes, setVolumes] = useState<Volume[] | null>(null);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const { pathname } = useLocation();

  async function load() {
    try {
      const result = await api<{ volumes: Volume[] }>("/api/volumes");
      setVolumes(result.volumes);
      setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load volumes."); }
  }
  useEffect(() => { void load(); }, [pathname]);

  return <Page>
    <PageHeader title="Volumes" description="Persistent directories shared across your environments." action={<button className="button button-primary" onClick={() => navigate("/volumes/new")}><Plus /> Create volume</button>} />
    {error && (!volumes ? <LoadError message={error} onRetry={() => { setError(""); void load(); }} /> : <div className="form-alert form-alert-error" role="alert">{error}</div>)}
    {!volumes ? (!error && <TableSkeleton />) : volumes.length === 0 ? <section className="empty-state data-panel"><div className="empty-icon"><FolderOpen /></div><h2>No volumes yet</h2><p>Create a persistent directory and mount it into one or more environments.</p><button className="button button-primary" onClick={() => navigate("/volumes/new")}><Plus /> Create volume</button></section> : <section className="data-panel environment-table-wrap"><table className="data-table"><thead><tr><th>Volume</th><th>Status</th><th>Storage path</th><th>Environments</th><th>Created</th></tr></thead><tbody>{volumes.map((volume) => <tr key={volume.id}><td><strong>{volume.name}</strong><span className="subtle">Persistent volume</span></td><td><StatusBadge state="ready" /></td><td className="mono">{volume.storage_prefix}</td><td>{volume.mount_count}</td><td>{timeAgo(volume.created_at)}</td></tr>)}</tbody></table></section>}
    <Outlet />
  </Page>;
}

function CreateVolumePage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/volumes", { method: "POST", body: JSON.stringify({ name }) });
      navigate("/volumes");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the volume.");
    } finally {
      setBusy(false);
    }
  }

  return <Modal title="Create volume" description="A persistent directory you can mount in your environments." className="resource-dialog" busy={busy} onClose={() => navigate("/volumes")}>
    <form className="settings-form-body resource-form" onSubmit={submit}>
      <label className="field"><span>Name</span><input data-dialog-autofocus required disabled={busy} value={name} maxLength={63} onChange={event => setName(event.target.value.toLowerCase())} pattern="[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?" placeholder="customer-datasets" aria-describedby="volume-name-hint" /></label>
      <p id="volume-name-hint" className="field-hint">Use lowercase letters, numbers and hyphens.</p>
      {error && <div className="form-alert form-alert-error" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => navigate("/volumes")}>Cancel</button><button className="button button-primary" disabled={busy || !name}>{busy && <CircleNotch className="spin" />}{busy ? "Creating…" : "Create volume"}</button></div>
    </form>
  </Modal>;
}

function RegistriesPage() {
  const [registries, setRegistries] = useState<Registry[] | null>(null);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [confirm, confirmationDialog] = useConfirmation();

  async function load() {
    try {
      const result = await api<{ registries: Registry[] }>("/api/registries");
      setRegistries(result.registries);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load registries.");
    }
  }
  useEffect(() => { void load(); }, [pathname]);

  async function remove(registry: Registry) {
    if (!await confirm({ title: `Remove ${registry.name}?`, description: "Existing environments keep their image reference, but future pulls will lose these credentials.", confirmLabel: "Remove registry" })) return;
    try {
      await api(`/api/registries/${encodeURIComponent(registry.id)}`, { method: "DELETE", body: "{}" });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the registry.");
    }
  }

  return <Page>
    {confirmationDialog}
    <PageHeader title="Registries" description="Store pull credentials for private OCI images." action={<button className="button button-primary" onClick={() => navigate("/registries/new")}><Plus /> Add registry</button>} />
    <div className="registry-note"><Key /><span><strong>Docker Hub is always available.</strong> Private credentials are encrypted before storage and the password is never shown again.</span></div>
    {error && (!registries ? <LoadError message={error} onRetry={() => { setError(""); void load(); }} /> : <div className="form-alert form-alert-error" role="alert">{error}</div>)}
    {!registries ? (!error && <TableSkeleton />) : <section className="data-panel environment-table-wrap"><table className="data-table"><thead><tr><th>Name</th><th>Registry</th><th>Username</th><th>Last used</th><th /></tr></thead><tbody><tr><td><strong>Docker Hub</strong><span className="subtle">System registry</span></td><td className="mono">docker.io</td><td>Public images</td><td>Available</td><td /></tr>{registries.map((registry) => <tr key={registry.id}><td><strong>{registry.name}</strong><span className="subtle">Private registry</span></td><td className="mono">{registry.url}</td><td>{registry.username}</td><td>{registry.last_used_at ? timeAgo(registry.last_used_at) : "Never"}</td><td><button className="icon-button danger" onClick={() => void remove(registry)} aria-label={`Remove ${registry.name}`}><Trash /></button></td></tr>)}</tbody></table></section>}
    <Outlet />
  </Page>;
}

function CreateRegistryPage() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api("/api/registries", { method: "POST", body: JSON.stringify(values) });
      navigate("/registries");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add the registry.");
    } finally {
      setBusy(false);
    }
  }
  return <Modal title="Add registry" description="Connect a private image registry with a read-only token." className="resource-dialog" busy={busy} onClose={() => navigate("/registries")}>
    <form className="settings-form-body resource-form" onSubmit={submit}>
      <fieldset disabled={busy} className="resource-fields">
        <Field label="Name" name="name" placeholder="GitHub Container Registry" data-dialog-autofocus maxLength={80} required />
        <Field label="Registry host" name="url" placeholder="ghcr.io" maxLength={200} required aria-describedby="registry-host-hint" />
        <p id="registry-host-hint" className="field-hint">Host only, without an image path.</p>
        <div className="field-grid"><Field label="Username" name="username" maxLength={160} autoComplete="off" required /><Field label="Password or token" name="password" type="password" maxLength={8192} autoComplete="new-password" required /></div>
      </fieldset>
      <p className="field-hint">Credentials are encrypted and never shown again.</p>
      {error && <div className="form-alert form-alert-error" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => navigate("/registries")}>Cancel</button><button className="button button-primary" disabled={busy}>{busy && <CircleNotch className="spin" />}{busy ? "Adding…" : "Add registry"}</button></div>
    </form>
  </Modal>;
}

function WebhooksPage() {
  const [data, setData] = useState<WebhooksPayload | null>(null);
  const [confirm, confirmationDialog] = useConfirmation();
  const [modalMode, setModalMode] = useState<"create" | "edit" | null>(null);
  const [name, setName] = useState("Production endpoint");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEventType[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    try {
      const result = await api<WebhooksPayload>("/api/webhooks");
      setData(result);
      if (result.endpoint) {
        setName(result.endpoint.name);
        setUrl(result.endpoint.url);
        setEvents(result.endpoint.event_types);
        setEnabled(result.endpoint.enabled);
      } else if (!events.length) {
        setEvents(result.event_types);
      }
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load webhooks.");
    }
  }

  useEffect(() => { void load(); }, []);

  function toggleEvent(eventType: WebhookEventType) {
    setEvents((current) => current.includes(eventType) ? current.filter((item) => item !== eventType) : [...current, eventType]);
  }

  function openCreateModal() {
    if (!data) return;
    setName("Production endpoint");
    setUrl("");
    setEvents(data.event_types);
    setEnabled(true);
    setSecret("");
    setError("");
    setModalMode("create");
  }

  function openEditModal() {
    if (!data?.endpoint) return;
    setName(data.endpoint.name);
    setUrl(data.endpoint.url);
    setEvents(data.endpoint.event_types);
    setEnabled(data.endpoint.enabled);
    setSecret("");
    setError("");
    setModalMode("edit");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!data) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (data.endpoint) {
        await api(`/api/webhooks/${encodeURIComponent(data.endpoint.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ name, url, events, enabled }),
        });
        setMessage("Webhook settings saved.");
        setModalMode(null);
      } else {
        const result = await api<{ id: string; secret: string }>("/api/webhooks", {
          method: "POST",
          body: JSON.stringify({ name, url, events }),
        });
        setSecret(result.secret);
        setMessage("Webhook endpoint created. Copy the signing secret now.");
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the webhook endpoint.");
    } finally { setBusy(false); }
  }

  async function sendTest() {
    if (!data?.endpoint) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{ delivery: { status: string; response_status: number | null; last_error: string | null } }>(`/api/webhooks/${encodeURIComponent(data.endpoint.id)}/test`, { method: "POST", body: "{}" });
      setMessage(result.delivery.status === "succeeded" ? `Test delivered${result.delivery.response_status ? ` with HTTP ${result.delivery.response_status}` : ""}.` : `Test failed: ${result.delivery.last_error || "No response"}. It will be retried automatically.`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the test webhook.");
    } finally { setBusy(false); }
  }

  async function retry(deliveryId: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/webhook-deliveries/${encodeURIComponent(deliveryId)}/retry`, { method: "POST", body: "{}" });
      setMessage("Delivery queued again.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not retry the delivery.");
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!data?.endpoint || !await confirm({ title: "Delete webhook endpoint?", description: "This also deletes its delivery history and cannot be undone.", confirmLabel: "Delete webhook" })) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/webhooks/${encodeURIComponent(data.endpoint.id)}`, { method: "DELETE", body: "{}" });
      setSecret("");
      setUrl("");
      setMessage("Webhook endpoint deleted.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the webhook endpoint.");
    } finally { setBusy(false); }
  }

  const canEdit = data?.workspace.role === "admin";
  return <Page>
    {confirmationDialog}
    <PageHeader eyebrow="Automation" title="Webhooks" description="Send signed lifecycle events to your own systems." action={canEdit && !data?.endpoint ? <button className="button button-primary" onClick={openCreateModal}><Plus />Create webhook</button> : undefined} />
    <SettingsNav />
    {error && (!data ? <LoadError message={error} onRetry={() => { setError(""); void load(); }} /> : <div className="form-alert form-alert-error webhook-alert" role="alert">{error}</div>)}
    {message && <div className="notice webhook-alert" role="status">{message}</div>}
    {!data ? (!error && <TableSkeleton />) : <>
      {!data.endpoint ? <section className="empty-state data-panel webhook-empty"><div className="empty-icon"><WebhooksLogo /></div><h2>No webhooks yet</h2><p>Create an endpoint to receive signed environment and snapshot events.</p></section> : <section className="data-panel webhook-list">
        <div className="webhook-list-header"><span>Name</span><span>Endpoint</span><span>Events</span><span>Status</span><span /></div>
        <div className="webhook-list-row"><div><strong>{data.endpoint.name}</strong><span className="mono">{data.endpoint.id}</span></div><span className="mono">{data.endpoint.url}</span><span>{data.endpoint.event_types.length}</span><span className={`webhook-state ${data.endpoint.enabled ? "enabled" : "disabled"}`}>{data.endpoint.enabled ? "Enabled" : "Paused"}</span><div className="webhook-row-actions">{canEdit && <button type="button" className="button button-secondary" onClick={openEditModal}>Edit</button>}<button type="button" className="button button-secondary" onClick={() => void sendTest()} disabled={busy || !canEdit}><ArrowRight />Test</button>{canEdit && <button type="button" className="icon-button danger" onClick={() => void remove()} disabled={busy} aria-label={`Delete ${data.endpoint.name}`}><Trash /></button>}</div></div>
      </section>}
      <section className="data-panel webhook-deliveries">
        <div className="panel-heading"><div><span className="eyebrow">Recent activity</span><h2>Deliveries</h2></div><span className="subtle">Last 50 deliveries</span></div>
        {!data.deliveries.length ? <p className="settings-empty">No webhook deliveries yet.</p> : <div className="webhook-delivery-list"><div className="webhook-delivery-header"><span>Event</span><span>Status</span><span>Response</span><span>Created</span><span /></div>{data.deliveries.map((delivery) => <div className="webhook-delivery-row" key={delivery.id}><div><strong>{delivery.event_type}</strong><span className="mono">{delivery.event_id}</span></div><span className={`webhook-delivery-status status-${delivery.status}`}>{delivery.status}</span><span>{delivery.response_status ? `HTTP ${delivery.response_status}` : delivery.last_error || "Waiting"}</span><time dateTime={delivery.created_at}>{timeAgo(delivery.created_at)}</time><button type="button" className="button button-secondary" disabled={busy || !canEdit || (delivery.status !== "succeeded" && delivery.status !== "failed")} onClick={() => void retry(delivery.id)}>Retry</button></div>)}</div>}
      </section>
    </>}
    {modalMode && data && <Modal busy={busy} title={modalMode === "edit" ? "Edit webhook" : "Create webhook"} description="Choose where Driftverk sends lifecycle events." onClose={() => { if (!busy) setModalMode(null); }}>
      <form className="webhook-modal-form" onSubmit={save}>
        <div className="field-grid"><Field label="Name" name="webhook-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required /><Field label="Endpoint URL" name="webhook-url" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/webhooks/driftverk" required /></div>
        <div className="webhook-events"><span>Events</span><div>{data.event_types.map((eventType) => <label key={eventType}><input type="checkbox" checked={events.includes(eventType)} onChange={() => toggleEvent(eventType)} /><span><strong>{eventType}</strong><small>{webhookEventDescription(eventType)}</small></span></label>)}</div></div>
        {modalMode === "edit" && <label className="webhook-enabled"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span><strong>Deliver events</strong><small>Pause delivery without deleting the endpoint.</small></span></label>}
        {secret && <div className="webhook-secret"><span>Copy this signing secret now</span><code>{secret}</code><button type="button" className="button button-secondary" onClick={() => void navigator.clipboard.writeText(secret)}><Copy />Copy secret</button></div>}
        {error && <div className="form-alert form-alert-error">{error}</div>}
        <div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setModalMode(null)} disabled={busy}>{secret ? "Close" : "Cancel"}</button>{!secret && <button className="button button-primary" disabled={busy || !events.length}>{busy ? <CircleNotch className="spin" /> : <FloppyDisk />}{modalMode === "edit" ? "Save changes" : "Create webhook"}</button>}</div>
      </form>
    </Modal>}
  </Page>;
}

function webhookEventDescription(eventType: WebhookEventType): string {
  const descriptions: Record<WebhookEventType, string> = {
    "environment.created": "An environment has been queued for creation.",
    "environment.running": "An environment has started successfully.",
    "environment.stopped": "An environment has stopped successfully.",
    "environment.degraded": "An environment operation has failed.",
    "environment.deleted": "An environment has been deleted.",
    "snapshot.ready": "A snapshot is ready to use.",
    "snapshot.failed": "A snapshot could not be created.",
  };
  return descriptions[eventType];
}

function ApiKeysPage() {
  const [apiKeys, setApiKeys] = useState<DriftverkApiKey[] | null>(null);
  const [canManageApiKeys, setCanManageApiKeys] = useState(false);
  const [newApiToken, setNewApiToken] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, confirmationDialog] = useConfirmation();

  async function load() {
    try {
      const apiKeyResult = await api<{ api_keys: DriftverkApiKey[]; can_manage: boolean }>("/api/api-keys");
      setApiKeys(apiKeyResult.api_keys);
      setCanManageApiKeys(apiKeyResult.can_manage);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load API keys.");
    }
  }

  useEffect(() => { void load(); }, []);

  async function createApiToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNewApiToken("");
    const form = event.currentTarget;
    const values = new FormData(form);
    const scopes = ["read", ...["write", "delete"].filter((scope) => values.get(scope) === "on")];
    try {
      const response = await api<{ api_key: { token: string } }>("/api/api-keys", {
        method: "POST",
        body: JSON.stringify({ name: values.get("name"), scopes, automation_id_prefix: values.get("automation_id_prefix") }),
      });
      setNewApiToken(response.api_key.token);
      form.reset();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the API key.");
    } finally { setBusy(false); }
  }

  async function revokeApiToken(key: DriftverkApiKey) {
    if (!await confirm({ title: `Revoke ${key.name}?`, description: "AI clients using this key will lose access immediately.", confirmLabel: "Revoke API key" })) return;
    try {
      await api(`/api/api-keys/${encodeURIComponent(key.id)}`, { method: "DELETE", body: "{}" });
      setNewApiToken("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not revoke the API key.");
    }
  }

  return <Page>
    {confirmationDialog}
    <PageHeader eyebrow="Access" title="API keys" description="Create credentials for the Driftverk API and MCP clients." action={<div className="page-header-actions"><a className="button button-secondary" href="/docs/api" target="_blank" rel="noreferrer">API docs</a>{canManageApiKeys && <button className="button button-primary" onClick={() => { setNewApiToken(""); setError(""); setModalOpen(true); }}><Plus />Create API key</button>}</div>} />
    <SettingsNav />
    {error && (!apiKeys ? <LoadError message={error} onRetry={() => { setError(""); void load(); }} /> : <div className="form-alert form-alert-error webhook-alert" role="alert">{error}</div>)}
    {!apiKeys ? (!error && <TableSkeleton />) : !apiKeys.length ? <section className="empty-state data-panel"><div className="empty-icon"><Key /></div><h2>No API keys yet</h2><p>Create a key for an API or MCP client. Driftverk only shows the token once.</p></section> : <section className="data-panel settings-panel api-key-list"><div className="ssh-key-list">{apiKeys.map((key) => <div className="ssh-key-row" key={key.id}><Key /><div><strong>{key.name}</strong><span className="mono">{key.secret_prefix} · {key.scopes.join(", ")}{key.automation_id_prefix ? ` · ${key.automation_id_prefix}*` : ""}{key.revoked_at ? " · revoked" : key.last_used_at ? ` · used ${timeAgo(key.last_used_at)}` : " · never used"}</span></div>{!key.revoked_at && canManageApiKeys && <button className="icon-button danger" onClick={() => void revokeApiToken(key)} aria-label={`Revoke ${key.name}`}><Trash /></button>}</div>)}</div></section>}
    {modalOpen && <Modal busy={busy} title="Create API key" description="The token is shown once after creation." onClose={() => { if (!busy) setModalOpen(false); }}>
      <form className="settings-form-body api-key-modal-form" onSubmit={createApiToken}>
        <p>Use this key with the Driftverk API or the remote MCP endpoint at <code>/mcp</code>.</p>
        <Field label="Name" name="name" placeholder="Claude or Cursor" maxLength={80} required />
        <Field label="GitHub automation scope" name="automation_id_prefix" placeholder="github:12345678:pr:" maxLength={200} />
        <div className="api-scope-list">
          <label><input type="checkbox" name="read" checked disabled /><span><strong>Read</strong><small>Required for API and MCP access</small></span></label>
          <label><input type="checkbox" name="write" defaultChecked /><span><strong>Write</strong><small>Create, start and stop environments</small></span></label>
          <label><input type="checkbox" name="delete" /><span><strong>Delete</strong><small>Permanently delete environments</small></span></label>
        </div>
        {newApiToken && <div className="api-token-once"><strong>Copy this token now</strong><code>{newApiToken}</code><button className="button button-secondary" type="button" onClick={() => void navigator.clipboard.writeText(newApiToken)}><Copy />Copy token</button></div>}
        {error && (!apiKeys ? <LoadError message={error} onRetry={() => { setError(""); void load(); }} /> : <div className="form-alert form-alert-error" role="alert">{error}</div>)}
        <div className="modal-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => setModalOpen(false)}>{newApiToken ? "Close" : "Cancel"}</button>{!newApiToken && <button className="button button-primary" disabled={busy}>{busy ? <CircleNotch className="spin" /> : <Plus />}Create API key</button>}</div>
      </form>
    </Modal>}
  </Page>;
}

function SettingsPage() {
  const [keys, setKeys] = useState<SshKey[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [confirm, confirmationDialog] = useConfirmation();

  async function load() {
    try {
      const result = await api<{ keys: SshKey[] }>("/api/ssh-keys");
      setKeys(result.keys);
      setLoadError("");
    } catch (caught) { setLoadError(caught instanceof Error ? caught.message : "Could not load SSH keys."); }
  }

  useEffect(() => { void load(); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = event.currentTarget;
    try {
      await api("/api/ssh-keys", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset();
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not add the SSH key."); }
    finally { setBusy(false); }
  }

  async function remove(key: SshKey) {
    if (!await confirm({ title: `Remove ${key.name}?`, description: "This SSH key will no longer grant access to your environments.", confirmLabel: "Remove SSH key" })) return;
    try {
      await api(`/api/ssh-keys/${encodeURIComponent(key.id)}`, { method: "DELETE", body: "{}" });
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not remove the SSH key."); }
  }

  return <Page>
    {confirmationDialog}
    <PageHeader title="Settings" description="Manage developer access, automation and workspace compute." />
    <SettingsNav />
    {loadError && <LoadError message={loadError} onRetry={() => { setLoadError(""); void load(); }} />}
    <div className="settings-grid">
      <section className="data-panel settings-panel"><div className="panel-heading"><div><span className="eyebrow">Access</span><h2>SSH keys</h2></div></div>{!keys ? (!loadError && <TableSkeleton />) : !keys.length ? <p className="settings-empty">No SSH keys added yet.</p> : <div className="ssh-key-list">{keys.map((key) => <div className="ssh-key-row" key={key.id}><Key /><div><strong>{key.name}</strong><span className="mono">{key.fingerprint}</span></div><button className="icon-button danger" onClick={() => void remove(key)} aria-label={`Remove ${key.name}`}><Trash /></button></div>)}</div>}</section>
      <form className="data-panel settings-panel add-key-form" onSubmit={submit}><div className="panel-heading"><div><span className="eyebrow">New key</span><h2>Add public key</h2></div></div><div className="settings-form-body"><p>Generate one with <code>ssh-keygen -t ed25519</code>, then paste the contents of the <code>.pub</code> file. Never paste the private key.</p><Field label="Name" name="name" placeholder="My laptop" maxLength={80} required /><label className="field"><span>Public key</span><textarea name="public_key" rows={5} placeholder="ssh-ed25519 AAAA... operator@example.com" required /></label>{error && <div className="form-alert form-alert-error">{error}</div>}<button className="button button-primary" disabled={busy}>{busy ? <CircleNotch className="spin" /> : <Plus />}Add SSH key</button></div></form>
    </div>
    <OrganizationSecrets />
    <HostingSettings />
  </Page>;
}

function TeamPage() {
  const [data, setData] = useState<TeamPayload | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, confirmationDialog] = useConfirmation();

  async function load() {
    try {
      setData(await api<TeamPayload>("/api/team"));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the team.");
    }
  }

  useEffect(() => { void load(); }, []);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data) return;
    setBusy(true);
    setError("");
    setMessage("");
    const form = event.currentTarget;
    const values = new FormData(form);
    try {
      await api("/api/auth/organization/invite-member", {
        method: "POST",
        body: JSON.stringify({
          email: String(values.get("email") || "").trim().toLowerCase(),
          role: values.get("role") === "admin" ? "admin" : "member",
          organizationId: data.workspace.id,
        }),
      });
      form.reset();
      setMessage("Invitation sent.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the invitation.");
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(member: TeamPayload["members"][number]) {
    if (!data || data.workspace.role !== "admin" || member.user_id === data.current_user_id) return;
    if (!await confirm({
      title: `Remove ${member.name || member.email}?`,
      description: `${member.email} will lose access to this workspace and its environments.`,
      confirmLabel: "Remove member",
    })) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("/api/auth/organization/remove-member", {
        method: "POST",
        body: JSON.stringify({ memberIdOrEmail: member.id, organizationId: data.workspace.id }),
      });
      setMessage("Member removed.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the member.");
    } finally {
      setBusy(false);
    }
  }

  async function updateMemberRole(member: TeamPayload["members"][number], role: "admin" | "member") {
    if (!data || data.workspace.role !== "admin" || member.user_id === data.current_user_id || member.role === role) return;
    const roleName = role === "admin" ? "admin" : "member";
    if (!await confirm({
      title: `Make ${member.name || member.email} ${role === "admin" ? "an" : "a"} ${roleName}?`,
      description: `${member.email} will ${role === "admin" ? "gain" : "lose"} admin access to this workspace.`,
      confirmLabel: `Make ${roleName}`,
      tone: role === "admin" ? "warning" : "danger",
      icon: <UsersThree />,
    })) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("/api/auth/organization/update-member-role", {
        method: "POST",
        body: JSON.stringify({ memberId: member.id, role, organizationId: data.workspace.id }),
      });
      setMessage("Member role updated.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the member role.");
    } finally {
      setBusy(false);
    }
  }

  async function cancelInvitation(invitation: TeamPayload["invitations"][number]) {
    if (!data || data.workspace.role !== "admin") return;
    if (!await confirm({
      title: `Cancel invitation for ${invitation.email}?`,
      description: "This invitation will no longer be valid.",
      confirmLabel: "Cancel invitation",
    })) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("/api/auth/organization/cancel-invitation", {
        method: "POST",
        body: JSON.stringify({ invitationId: invitation.id }),
      });
      setMessage("Invitation cancelled.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not cancel the invitation.");
    } finally {
      setBusy(false);
    }
  }

  const runningCount = data?.members.reduce((sum, member) => sum + member.running_environment_count, 0) ?? 0;
  const canManageMembers = data?.workspace.role === "admin";

  return <Page>
    {confirmationDialog}
    <PageHeader eyebrow="Workspace" title="Team" description="Invite developers and keep every environment tied to the person who created it." />
    {!data ? error ? <LoadError message={error} onRetry={() => { setError(""); void load(); }} /> : <TableSkeleton /> : <>
      <MemberCreationPolicy />
      <div className="team-stats">
        <div><span>Members</span><strong>{data?.members.length ?? 0}</strong></div>
        <div><span>Pending invites</span><strong>{data?.invitations.length ?? 0}</strong></div>
        <div><span>Running environments</span><strong>{runningCount}</strong></div>
      </div>
      <div className="team-layout">
        <section className="data-panel team-members-panel">
          <div className="panel-heading"><div><span className="eyebrow">{data?.workspace.name}</span><h2>Members</h2></div></div>
          <div className="team-list">
            {data?.members.map((member) => <div className="team-row" key={member.id}>
              <div className="avatar avatar-light">{initials(member.name || member.email)}</div>
              <div className="team-person"><strong>{member.name || member.email}{member.user_id === data.current_user_id && <small>You</small>}</strong><span>{member.email}</span></div>
              {canManageMembers && member.user_id !== data.current_user_id ? <select className={`team-role-select role-${member.role}`} value={member.role} disabled={busy} aria-label={`Change role for ${member.name || member.email}`} onChange={(event) => { const role = event.currentTarget.value === "admin" ? "admin" : "member"; void updateMemberRole(member, role); }}><option value="member">Member</option><option value="admin">Admin</option></select> : <span className={`role-badge role-${member.role}`}>{member.role}</span>}
              <div className="team-usage"><strong>{member.environment_count}</strong><span>environments</span></div>
              <div className="team-actions">{canManageMembers && member.user_id !== data.current_user_id && <button type="button" className="icon-button danger" disabled={busy} onClick={() => void removeMember(member)} aria-label={`Remove ${member.name || member.email}`}><Trash /></button>}</div>
            </div>)}
          </div>
          {!!data?.invitations.length && <div className="pending-invitations">
            <div className="panel-heading"><div><span className="eyebrow">Awaiting response</span><h2>Pending invitations</h2></div></div>
            {data.invitations.map((invitation) => <div className="invitation-row" key={invitation.id}>
              <EnvelopeSimple /><div><strong>{invitation.email}</strong><span>Invited as {invitation.role}</span></div><span className="status status-provisioning"><i />Pending</span>{canManageMembers && <button type="button" className="icon-button danger" disabled={busy} onClick={() => void cancelInvitation(invitation)} aria-label={`Cancel invitation for ${invitation.email}`}><X /></button>}
            </div>)}
          </div>}
        </section>
        <form className="data-panel invite-panel" onSubmit={invite}>
          <div className="panel-heading"><div><span className="eyebrow">New member</span><h2>Invite developer</h2></div><UserPlus /></div>
          <div className="settings-form-body">
            <p>Members can create one personal environment when enabled and access environments assigned to them. Admins manage the workspace.</p>
            <Field label="Email" name="email" type="email" autoComplete="email" placeholder="developer@company.com" required disabled={!canManageMembers} />
            <label className="field"><span>Role</span><select name="role" defaultValue="member" disabled={!canManageMembers}><option value="member">Member</option><option value="admin">Admin</option></select></label>
            {error && <div className="form-alert form-alert-error">{error}</div>}
            {message && <div className="form-alert form-alert-success">{message}</div>}
            {!canManageMembers && <div className="form-alert">Only workspace admins can invite members.</div>}
            <button className="button button-primary button-wide" disabled={busy || !canManageMembers}>{busy ? <CircleNotch className="spin" /> : <UserPlus />}Send invitation</button>
          </div>
        </form>
      </div>
    </>}
  </Page>;
}

function AdminOrganizationsPage() {
  const selfHosted = useInstallation().installationMode === "self-hosted";
  const [creditAmount, setCreditAmount] = useState("50");
  const [creditReason, setCreditReason] = useState("");
  const [creditRequestId, setCreditRequestId] = useState(() => crypto.randomUUID());
  const [creditFeedback, setCreditFeedback] = useState<{ error?: string; message?: string }>({});
  const [organizations, setOrganizations] = useState<AdminOrganization[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [hostingMode, setHostingMode] = useState<"managed" | "hybrid">(selfHosted ? "hybrid" : "managed");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, confirmationDialog] = useConfirmation();

  const selected = organizations?.find((organization) => organization.id === selectedId) ?? null;
  const activeAgents = selected?.agents.filter((agent) => !agent.revoked_at) ?? [];

  async function load(preferredId?: string) {
    try {
      const result = await api<{ organizations: AdminOrganization[] }>("/api/admin/organizations");
      setOrganizations(result.organizations);
      setSelectedId((current) => preferredId || current || result.organizations[0]?.id || "");
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load organizations.");
    }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!selected) return;
    setName(selected.name);
    setHostingMode(selected.hosting_mode);
    setCreditReason("");
    setCreditRequestId(crypto.randomUUID());
    setCreditFeedback({});
    setMessage("");
    setError("");
  }, [selectedId]);

  async function toggleComplimentaryAccess() {
    if (!selected?.billing) return;
    const complimentary = !selected.billing.complimentary;
    if (!complimentary && !await confirm({ title: `End free access for ${selected.name}?`, description: "Normal billing requirements resume immediately. Environments may stop if the organization has insufficient Cloud credits or no active Hybrid plan.", confirmLabel: "End free access" })) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await api(`/api/admin/organizations/${encodeURIComponent(selected.id)}/complimentary`, { method: "PATCH", body: JSON.stringify({ complimentary }) });
      await load(selected.id);
      setMessage(`Complimentary access ${complimentary ? "enabled" : "disabled"} for ${selected.name}.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not update complimentary access."); }
    finally { setBusy(false); }
  }

  async function grantCredit(event: FormEvent) {
    event.preventDefault();
    if (!selected?.billing) return;
    const amount = Math.round(Number(creditAmount) * 100);
    const formatted = new Intl.NumberFormat(undefined, { style: "currency", currency: selected.billing.currency }).format(amount / 100);
    if (!await confirm({ title: `Grant ${formatted} to ${selected.name}?`, description: "No payment will be collected. The grant and reason will appear in billing activity.", confirmLabel: "Grant credits" })) return;
    setBusy(true); setError(""); setMessage(""); setCreditFeedback({});
    try {
      await api(`/api/admin/organizations/${encodeURIComponent(selected.id)}/credits`, { method: "POST", body: JSON.stringify({ amount_ore: amount, currency: selected.billing.currency, reason: creditReason, request_id: creditRequestId }) });
      setCreditRequestId(crypto.randomUUID()); setCreditReason("");
      await load(selected.id);
      setCreditFeedback({ message: `${formatted} in credits granted to ${selected.name}.` });
    } catch (caught) { setCreditFeedback({ error: caught instanceof Error ? caught.message : "Could not grant credits." }); }
    finally { setBusy(false); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api(`/api/admin/organizations/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name, hosting_mode: hostingMode }),
      });
      await load(selected.id);
      setMessage("Organization settings saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the organization.");
    } finally { setBusy(false); }
  }

  async function revokeAgent(activeAgent: AdminOrganization["agents"][number]) {
    if (!selected || !activeAgent || !await confirm({ title: `Revoke ${activeAgent.name}?`, description: "Its services will lose access immediately.", confirmLabel: "Revoke Compute agent" })) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/admin/organizations/${encodeURIComponent(selected.id)}/compute-agents/${encodeURIComponent(activeAgent.id)}`, { method: "DELETE", body: "{}" });
      await load(selected.id);
      setMessage("Compute agent revoked.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not revoke the Compute agent.");
    } finally { setBusy(false); }
  }

  const installCommand = `curl -fsSL ${window.location.origin}/install/agent | sudo bash -s --`;

  return <Page>
    {confirmationDialog}
    <PageHeader eyebrow="Platform administration" title="Organizations" description="Manage customer hosting, credits and Compute agents." />
    {error && (organizations === null ? <LoadError message={error} onRetry={() => { setError(""); void load(); }} /> : <div className="form-alert form-alert-error admin-alert" role="alert">{error}</div>)}
    {message && <div className="form-alert form-alert-success admin-alert">{message}</div>}
    {organizations === null ? (!error && <TableSkeleton />) : organizations.length === 0 && !error ? <section className="empty-state data-panel"><div className="empty-icon"><HardDrives /></div><h2>No organizations</h2><p>Organizations appear here when their first workspace is created.</p></section> : organizations.length > 0 && <div className="admin-layout">
      <aside className="data-panel admin-organization-list" aria-label="Organizations">
        <div className="panel-heading"><div><span className="eyebrow">Customers</span><h2>{organizations.length} organizations</h2></div></div>
        {organizations.map((organization) => <button key={organization.id} type="button" className={organization.id === selectedId ? "admin-organization active" : "admin-organization"} onClick={() => setSelectedId(organization.id)}>
          <span><strong>{organization.name}</strong><small>{organization.primary_contact_email || organization.slug}</small><small>{organization.environment_count} environments · {organization.member_count} members{organization.last_environment_activity_at ? ` · active ${timeAgo(organization.last_environment_activity_at)}` : ""}</small></span>
          <span className={`status ${organization.environment_issue_count > 0 ? "status-failed" : organization.hosting_mode === "hybrid" ? "status-ready" : "status-stopped"}`}><i />{organization.environment_issue_count > 0 ? `${organization.environment_issue_count} ${organization.environment_issue_count === 1 ? "issue" : "issues"}` : organization.hosting_mode}</span>
        </button>)}
      </aside>
      {selected && <div className="admin-detail">
        <form className="data-panel admin-panel" onSubmit={save}>
          <div className="panel-heading"><div><span className="eyebrow">Organization</span><h2>Hosting settings</h2></div></div>
          <dl className="customer-summary">
            <div><dt>Primary contact</dt><dd>{selected.primary_contact_name || "No contact"}<small>{selected.primary_contact_email || "No admin email"}</small></dd></div>
            <div><dt>Customer since</dt><dd>{new Date(selected.created_at).toLocaleDateString()}</dd></div>
            <div><dt>Latest activity</dt><dd>{selected.last_environment_activity_at ? timeAgo(selected.last_environment_activity_at) : "No environment activity"}</dd></div>
            <div><dt>Environment health</dt><dd><span className={`status ${selected.environment_issue_count > 0 ? "status-failed" : "status-ready"}`}><i />{selected.environment_issue_count > 0 ? `${selected.environment_issue_count} need attention` : "No reported issues"}</span></dd></div>
          </dl>
          <div className="settings-form-body">
            <Field label="Name" name="organization-name" value={name} onChange={(event) => setName(event.target.value)} required />
            <label className="field"><span>Organization slug</span><input value={selected.slug} readOnly /></label>
            <label className="field"><span>Hosting mode</span><select value={hostingMode} onChange={(event) => setHostingMode(event.target.value as "managed" | "hybrid")}>{!selfHosted && <option value="managed">Managed by Driftverk</option>}<option value="hybrid">Your compute hosts</option></select></label>
            <p className="admin-help">Hybrid mode keeps container execution and snapshot storage in the customer's environment. S3 credentials are configured only on that host.</p>
            <button className="button button-primary" disabled={busy || !name}>{busy ? <CircleNotch className="spin" /> : <FloppyDisk />}Save settings</button>
          </div>
        </form>

        {!selfHosted && selected.billing && <section className="data-panel admin-panel">
          <div className="panel-heading"><div><span className="eyebrow">Pilot billing</span><h2>Complimentary access</h2></div></div>
          <div className="settings-form-body">
            <label className="setting-toggle"><input type="checkbox" role="switch" checked={selected.billing.complimentary} disabled={busy} onChange={() => void toggleComplimentaryAccess()} /><span><strong>Free pilot access</strong></span></label>
            <p className="admin-help">Free Cloud or Hybrid access with no expiry or credit limit. Existing Stripe subscriptions must be canceled before enabling.</p>
          </div>
        </section>}

        {!selfHosted && selected.billing && selected.hosting_mode === "managed" && <form className="data-panel admin-panel" onSubmit={grantCredit}>
          <div className="panel-heading"><div><span className="eyebrow">Cloud billing</span><h2>{selected.billing.complimentary ? "Complimentary access" : new Intl.NumberFormat(undefined, { style: "currency", currency: selected.billing.currency }).format(Number(selected.billing.balance_ore) / 100) + " available"}</h2></div></div>
          <div className="settings-form-body">
            {selected.billing.complimentary ? <p>This organization already has complimentary access without a credit limit.</p> : <>
              <Field label={`Credit amount (${selected.billing.currency.toUpperCase()})`} name="credit-amount" type="number" min="0.01" max="10000" step="0.01" required value={creditAmount} disabled={busy} onChange={(event) => { setCreditAmount(event.target.value); setCreditRequestId(crypto.randomUUID()); }} />
              <Field label="Reason" name="credit-reason" placeholder="Pilot program" maxLength={300} required value={creditReason} disabled={busy} onChange={(event) => { setCreditReason(event.target.value); setCreditRequestId(crypto.randomUUID()); }} />
              {creditFeedback.error && <div role="alert" className="form-alert form-alert-error">{creditFeedback.error}</div>}
              {creditFeedback.message && <div role="status" className="form-alert form-alert-success">{creditFeedback.message}</div>}
              <button className="button button-primary admin-credit-submit" disabled={busy || !creditReason.trim()}>{busy && <CircleNotch className="spin" />}Grant credits</button>
            </>}
          </div>
        </form>}

        {selected.hosting_mode === "hybrid" && <section className="data-panel admin-panel">
          <div className="panel-heading"><div><span className="eyebrow">Compute</span><h2>Driftverk Compute agent</h2></div><span className="admin-counts">{selected.environment_count} environments · {selected.member_count} members</span></div>
          {activeAgents.map(activeAgent => <div className="agent-card" key={activeAgent.id}>
            <div className="agent-heading"><div><strong>{activeAgent.name}</strong><span className="mono">{activeAgent.id}</span></div><ComputeAgentStatus lastSeenAt={activeAgent.last_seen_at} /></div>
            <dl className="agent-metadata"><div><dt>Last connected</dt><dd>{activeAgent.last_seen_at ? timeAgo(activeAgent.last_seen_at) : "Never"}</dd></div><div><dt>Version</dt><dd>{activeAgent.version || "Not reported"}</dd></div><div><dt>Snapshots</dt><dd>{activeAgent.storage_driver || "Not reported"}</dd></div></dl>
            <button type="button" className="button button-danger" disabled={busy} onClick={() => void revokeAgent(activeAgent)}><Trash />Revoke Compute agent</button>
          </div>)}<div className="agent-install">
            <p>Send these commands to the customer. The installer opens a browser authorization and creates the Compute agent after an organization admin approves it.</p>
            <pre>{installCommand}</pre>
            <button type="button" className="button button-primary" onClick={() => void navigator.clipboard.writeText(installCommand)}><Copy />Copy install commands</button>
          </div>
        </section>}
      </div>}
    </div>}
  </Page>;
}

function ComputeAgentStatus({ lastSeenAt }: { lastSeenAt: string | null }) {
  if (!lastSeenAt) return <span className="status status-queued"><i />Never connected</span>;
  const connected = Date.now() - new Date(lastSeenAt).getTime() < 60_000;
  return <span className={`status ${connected ? "status-ready" : "status-stopped"}`}><i />{connected ? "Connected" : "Offline"}</span>;
}

function Page({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`page${className ? ` ${className}` : ""}`}>{children}</div>;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</header>;
}

function SetupProgress({ environment }: { environment: Environment }) {
  const stages = [
    { steps: ["allocating", "restoring", "booting"], label: "Compute", icon: Cpu, enabled: true },
    { steps: ["cloning"], label: "Code", icon: GitBranch, enabled: Boolean(environment.repository) },
    { steps: ["setting-up", "initializing", "capturing-prebuild"], label: "Setup", icon: TerminalWindow, enabled: Boolean(environment.setup_command || environment.initialization_command) || ["setting-up", "initializing", "capturing-prebuild"].includes(environment.provisioning_step) },
    { steps: ["starting-services", "checking-app", "connecting", "ready"], label: "Start", icon: Play, enabled: true },
  ];
  const active = !environment.compute_node_id ? 0 : stages.findIndex((stage) => stage.steps.includes(environment.provisioning_step));
  return <ol className="setup-track">{stages.map((stage, index) => {
    if (!stage.enabled) return null;
    const current = index === active;
    const failed = current && environment.state === "degraded";
    const done = active > index;
    const Icon = failed ? X : done ? Check : stage.icon;
    return <li key={stage.label} className={`${current ? "is-current" : ""} ${done ? "is-done" : ""} ${failed ? "is-failed" : ""}`} aria-current={current ? "step" : undefined} aria-label={`${stage.label}: ${failed ? "failed" : done ? "complete" : current ? "in progress" : "pending"}`}>
      <span className="setup-node"><Icon aria-hidden="true" />{current && !failed && <CircleNotch className="setup-spinner" aria-hidden="true" />}</span>
      <span>{stage.label}</span>
    </li>;
  })}</ol>;
}

function projectStepLabel(step: string) {
  return ({ allocating: "Waiting for compute", restoring: "Preparing the environment", booting: "Starting the environment", cloning: "Fetching your code", "setting-up": "Installing dependencies", initializing: "Initializing environment data", "capturing-prebuild": "Saving prebuild", "starting-services": "Starting services", "checking-app": "Checking the app", connecting: "Connecting the environment", ready: "Setup complete" } as Record<string, string>)[step] || "Preparing your project";
}

function StatusBadge({ state, provisioningStep, computeNodeId, activeOperation }: { state: string; provisioningStep?: string; computeNodeId?: string | null; activeOperation?: Environment["active_operation"] }) {
  const displayState = state === "provisioning" && provisioningStep === "allocating" && !computeNodeId ? "queued" : state;
  const operationLabel = activeOperation ? ({ create: "Starting", start: "Starting", stop: "Stopping", delete: "Deleting", snapshot: "Snapshotting" } as const)[activeOperation] : null;
  return <span className={`status status-${displayState}`}><i />{displayState === "queued" ? stateLabel(displayState) : operationLabel || stateLabel(displayState)}</span>;
}

function TableSkeleton() {
  return <section className="data-panel skeleton-panel" role="status" aria-label="Loading"><div /><div /><div /></section>;
}

function initials(value: string) {
  return value.split(/\s|@/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

function shortId(id: string) {
  return id.length > 25 ? `${id.slice(0, 22)}…` : id;
}

function formatMemory(memoryMb: number) {
  return `${Math.round(memoryMb / 1024)} GB RAM`;
}

function timeAgo(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(diff / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function stateLabel(state: string) {
  return ({ running: "Running", stopped: "Stopped", provisioning: "Starting", queued: "Queued", degraded: "Failed", deleted: "Deleted", building: "Building", ready: "Ready", failed: "Failed" } as Record<string, string>)[state] || state;
}

function formatMinutes(value: number | null) {
  if (!value) return "Disabled";
  if (value % 10080 === 0) return `${value / 10080} week${value === 10080 ? "" : "s"}`;
  if (value % 1440 === 0) return `${value / 1440} day${value === 1440 ? "" : "s"}`;
  if (value % 60 === 0) return `${value / 60} hour${value === 60 ? "" : "s"}`;
  return `${value} minutes`;
}
