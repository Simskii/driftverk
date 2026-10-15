function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        character
      ] ?? character,
  );
}

const styles = `
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#10231e;background:#f3f2eb;line-height:1.5}*{box-sizing:border-box}body{margin:0}a{color:inherit}.auth-shell{min-height:100vh;display:grid;grid-template-columns:minmax(280px,42%) 1fr}.auth-brand{padding:56px;background:#052f27;color:#fff;display:flex;flex-direction:column;justify-content:space-between}.auth-brand strong{font-size:30px}.auth-brand h1{font-size:clamp(42px,6vw,76px);line-height:.95;letter-spacing:-.06em;max-width:620px}.auth-brand p{color:#d4e2dc;max-width:520px}.auth-main{display:grid;place-items:center;padding:32px}.auth-card{width:min(440px,100%);background:#fff;padding:38px;border:1px solid #d3d6ce}.auth-card h2{font-size:32px;letter-spacing:-.04em;margin:0}.auth-card>p{color:#61706b}.field{display:grid;gap:7px;margin-top:18px}.field label{font-size:12px;font-weight:700}.field input,.field select{width:100%;padding:13px 14px;border:1px solid #aeb7b1;background:#fff;font:inherit}.button{display:inline-flex;justify-content:center;align-items:center;border:0;background:#10231e;color:#fff;padding:13px 18px;font:700 14px inherit;cursor:pointer}.button-primary{background:#c9fa36;color:#10231e}.auth-card .button{width:100%;margin-top:22px}.form-message{min-height:24px;margin:14px 0 0;color:#8d2419;font-size:13px}.auth-links{display:flex;justify-content:space-between;gap:14px;margin-top:22px;font-size:13px}.app-shell{min-height:100vh;display:grid;grid-template-columns:230px 1fr}.sidebar{background:#052f27;color:#fff;padding:27px 20px;display:flex;flex-direction:column}.sidebar .brand{font-size:25px;font-weight:750;margin-bottom:34px}.sidebar nav{display:grid;gap:7px}.sidebar a{padding:11px 12px;text-decoration:none;color:#c9d9d3}.sidebar a.active{background:#ffffff14;color:#d9ff66}.sidebar form{margin-top:auto}.sidebar button{background:none;border:0;color:#c9d9d3;padding:0;cursor:pointer}.main{padding:48px}.page-head{display:flex;justify-content:space-between;align-items:end;gap:20px}.page-head h1{font-size:48px;letter-spacing:-.05em;margin:0}.page-head p{margin:8px 0 0;color:#62706b}.panel{margin-top:28px;background:#fff;border:1px solid #d3d6ce}.table{width:100%;border-collapse:collapse}.table th,.table td{text-align:left;padding:15px;border-bottom:1px solid #e0e2dc;font-size:13px}.table th{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#6b7772}.status{font-weight:700}.status-running{color:#126846}.status-degraded{color:#a44b20}.empty{padding:44px;text-align:center;color:#62706b}.create-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.actions{display:flex;gap:8px}.actions form{margin:0}.actions .button{padding:8px 11px;font-size:12px}.notice{padding:12px 14px;background:#eef8df;border:1px solid #b8d37b;margin-top:20px}.runtime{font-family:ui-monospace,monospace;font-size:11px;color:#64706c}@media(max-width:760px){.auth-shell{grid-template-columns:1fr}.auth-brand{min-height:300px;padding:30px}.auth-brand h1{font-size:44px}.app-shell{grid-template-columns:1fr}.sidebar{display:block}.sidebar nav{display:flex;overflow:auto}.sidebar form{margin-top:20px}.main{padding:28px 18px}.page-head{align-items:start;flex-direction:column}.page-head h1{font-size:40px}.create-grid{grid-template-columns:1fr}.table{min-width:760px}.panel{overflow:auto}}
.panel-form{padding:28px}.placeholder{padding:44px}.placeholder h1{margin:0;font-size:40px;letter-spacing:-.04em}.placeholder p{max-width:620px;color:#62706b}
`;

// Reuse the shared Driftverk favicon asset used by the public site.
export const faviconSvg = `<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><path fill="#10231E" d="M2 2h21l7 5-7 5H2V2Zm0 10h21l7 5-7 5H2V12Zm0 10h21l7 5-7 5H2V22Z"/><path fill="#155F46" d="M2 12h21l7 5-7 5H2V12Z"/><circle cx="22" cy="7" r="1.7" fill="#D9FF66"/><circle cx="22" cy="17" r="1.7" fill="#D9FF66"/><circle cx="22" cy="27" r="1.7" fill="#D9FF66"/></svg>`;

export function document(input: {
  title: string;
  body: string;
  nonce?: string;
}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>${escapeHtml(input.title)} · Driftverk</title><style${input.nonce ? ` nonce="${input.nonce}"` : ""}>${styles}</style></head><body>${input.body}</body></html>`;
}

export function authPage(input: {
  mode: "sign-in" | "sign-up" | "forgot-password" | "reset-password";
  nonce: string;
  allowSignUp: boolean;
}): string {
  const content = {
    "sign-in": {
      title: "Sign in",
      description: "Open your Driftverk control plane.",
      fields: `<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div><div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>`,
      button: "Sign in",
    },
    "sign-up": {
      title: "Create account",
      description: "Create the first account for your workspace.",
      fields: `<div class="field"><label for="name">Name</label><input id="name" name="name" autocomplete="name" required></div><div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div><div class="field"><label for="password">Password</label><input id="password" name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></div>`,
      button: "Create account",
    },
    "forgot-password": {
      title: "Reset password",
      description: "We will email you a secure reset link.",
      fields: `<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div>`,
      button: "Send reset link",
    },
    "reset-password": {
      title: "Choose a new password",
      description: "Use at least 12 characters.",
      fields: `<div class="field"><label for="password">New password</label><input id="password" name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></div>`,
      button: "Save password",
    },
  }[input.mode];
  const links =
    input.mode === "sign-in"
      ? `<a href="/forgot-password">Forgot password?</a>${input.allowSignUp ? '<a href="/sign-up">Create account</a>' : ""}`
      : input.mode === "sign-up"
        ? '<a href="/sign-in">Already have an account?</a>'
        : '<a href="/sign-in">Back to sign in</a>';
  const script = `const form=document.querySelector('form');const message=document.querySelector('[data-message]');form.addEventListener('submit',async event=>{event.preventDefault();message.textContent='';const data=Object.fromEntries(new FormData(form));let path='';let body={};const mode=form.dataset.mode;if(mode==='sign-in'){path='/api/auth/sign-in/email';body={email:data.email,password:data.password,callbackURL:'/environments'}}else if(mode==='sign-up'){path='/api/auth/sign-up/email';body={name:data.name,email:data.email,password:data.password,callbackURL:'/environments'}}else if(mode==='forgot-password'){path='/api/auth/request-password-reset';body={email:data.email,redirectTo:'/reset-password'}}else{const token=new URLSearchParams(location.search).get('token');if(!token){message.textContent='This reset link is missing its token.';return}path='/api/auth/reset-password';body={newPassword:data.password,token}}const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json().catch(()=>({}));if(!response.ok){message.textContent=result.message||result.error||'The request failed.';return}if(mode==='sign-up'){message.style.color='#126846';message.textContent='Check your email to verify the account.';form.reset();return}if(mode==='forgot-password'){message.style.color='#126846';message.textContent='If the account exists, a reset link has been sent.';form.reset();return}location.href=mode==='reset-password'?'/sign-in?reset=1':'/environments'});`;
  return document({
    title: content.title,
    nonce: input.nonce,
    body: `<main class="auth-shell"><section class="auth-brand"><strong>Driftverk</strong><div><h1>Isolated development environments.</h1><p>Start OCI sandboxes for developers and coding agents without sharing filesystems, databases or nested Docker state.</p></div><small>Driftverk control plane</small></section><section class="auth-main"><div class="auth-card"><h2>${content.title}</h2><p>${content.description}</p><form data-mode="${input.mode}">${content.fields}<button class="button button-primary" type="submit">${content.button}</button><p class="form-message" data-message aria-live="polite"></p></form><div class="auth-links">${links}</div></div></section><script nonce="${input.nonce}">${script}</script></main>`,
  });
}

export function appPage(input: {
  title: string;
  userName: string;
  content: string;
  nonce: string;
}): string {
  const script = `document.querySelector('[data-sign-out]')?.addEventListener('submit',async event=>{event.preventDefault();await fetch('/api/auth/sign-out',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});location.href='/sign-in'});`;
  return document({
    title: input.title,
    nonce: input.nonce,
    body: `<div class="app-shell"><aside class="sidebar"><div class="brand">Driftverk</div><nav><a class="active" href="/environments">Environments</a><a href="/snapshots">Snapshots</a><a href="/registries">Registries</a></nav><form data-sign-out><button type="submit">Sign out · ${escapeHtml(input.userName)}</button></form></aside><main class="main">${input.content}</main></div><script nonce="${input.nonce}">${script}</script>`,
  });
}

export { escapeHtml };
