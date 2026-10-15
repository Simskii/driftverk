import RFB from './novnc/core/rfb.js';

const screen = document.querySelector('#screen');
const status = document.querySelector('#status');
const control = document.querySelector('#control');
const controlLabel = control.querySelector('.button-label');
const hint = document.querySelector('#hint');
let rfb;
if (new URLSearchParams(location.search).get('view') === 'desktop') {
  document.title = 'Desktop · Driftverk';
  document.querySelector('#view-name').textContent = 'Desktop';
  screen.setAttribute('aria-label', 'Remote desktop');
  document.querySelector('nav').setAttribute('aria-label', 'Desktop controls');
}
function notifyParent(connected) {
  // Only connection state is sent, never a URL, credential or screen content.
  if (window.parent !== window) window.parent.postMessage({ type: 'driftverk-desktop', connected }, '*');
}

function watchOnly() {
  if (rfb) rfb.viewOnly = true;
  controlLabel.textContent = 'Take control';
  control.setAttribute('aria-pressed', 'false');
  hint.textContent = 'Pause your agent before taking control.';
}

function connect() {
  const previous = rfb;
  rfb = null;
  previous?.disconnect();
  screen.replaceChildren();
  control.disabled = true;
  watchOnly();
  status.textContent = 'Connecting…';
  document.body.dataset.connection = 'connecting';
  notifyParent(false);
  // Preview authorization uses the gateway cookie, including on this upgrade.
  // Never copy the page query string or bearer token into the WebSocket URL.
  const url = new URL('websockify', window.location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const connection = new RFB(screen, url.href, { shared: true });
  rfb = connection;
  connection.scaleViewport = true;
  connection.viewOnly = true;
  connection.addEventListener('connect', () => {
    if (rfb !== connection) return;
    status.textContent = 'View only';
    document.body.dataset.connection = 'connected';
    notifyParent(true);
    control.disabled = false;
  });
  connection.addEventListener('disconnect', () => {
    if (rfb !== connection) return;
    control.disabled = true;
    watchOnly();
    status.textContent = 'Disconnected';
    document.body.dataset.connection = 'disconnected';
    notifyParent(false);
    hint.textContent = 'Reconnect to try again. If your preview link expired, open a fresh one from Driftverk.';
  });
  connection.addEventListener('securityfailure', () => {
    if (rfb === connection) status.textContent = 'Connection rejected';
  });
}

control.addEventListener('click', () => {
  if (!rfb || control.disabled) return;
  if (rfb.viewOnly) {
    rfb.viewOnly = false;
    controlLabel.textContent = 'Release control';
    control.setAttribute('aria-pressed', 'true');
    status.textContent = 'In control';
    hint.textContent = 'Your mouse and keyboard are live. Agents are not paused.';
    rfb.focus();
  } else {
    watchOnly();
    status.textContent = 'View only';
  }
});
document.querySelector('#reconnect').addEventListener('click', connect);
const fullscreen = document.querySelector('#fullscreen');
fullscreen.hidden = !document.fullscreenEnabled;
fullscreen.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { hint.textContent = 'Your browser could not enter full screen.'; }
});
document.addEventListener('fullscreenchange', () => {
  const active = Boolean(document.fullscreenElement);
  const label = active ? 'Exit full screen' : 'Full screen';
  fullscreen.dataset.active = String(active);
  fullscreen.dataset.tooltip = label;
  fullscreen.setAttribute('aria-label', label);
});
connect();
