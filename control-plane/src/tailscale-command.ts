// Only these fixed actions are sent to the existing environment execution runner.
export function tailscaleCommand(action: "status" | "connect" | "logout") {
  return `python3 - '${action}' <<'DRIFTVERK_TAILSCALE_PY'
${tailscaleScript}
DRIFTVERK_TAILSCALE_PY`;
}

export const tailscaleScript = String.raw`
import json, os, shutil, signal, socket, struct, subprocess, sys, time
from pathlib import Path

action = sys.argv[1]
marker = Path('/var/lib/driftverk/tailscale-enabled')

def emit(state, **values):
    print(json.dumps(dict(state=state, **values)), flush=True)

def run(args, timeout=10):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)

def status():
    result = run(['tailscale', 'status', '--json'])
    try:
        return json.loads(result.stdout)
    except ValueError:
        return None

def report(value):
    backend = value.get('BackendState', '')
    if backend == 'Running':
        me = value.get('Self') or {}
        emit('connected', hostname=me.get('DNSName', '').rstrip('.'), ips=value.get('TailscaleIPs', []))
        return True
    elif backend == 'NeedsMachineAuth':
        emit('needs_approval')
    elif value.get('AuthURL'):
        emit('needs_login', auth_url=value['AuthURL'])
    else:
        emit('logged_out' if backend == 'NeedsLogin' else 'stopped')
    return False

try:
    if not shutil.which('tailscale') or not shutil.which('tailscaled'):
        emit('not_installed')
        sys.exit(0)
    current = status()
    if action == 'status':
        if current is None:
            emit('stopped')
        else:
            report(current)
        sys.exit(0)
    if current is None:
        # Userspace networking works without exposing the host's TUN device or adding capabilities.
        os.makedirs('/var/run/tailscale', exist_ok=True)
        os.makedirs('/var/lib/tailscale', mode=0o700, exist_ok=True)
        subprocess.Popen(['tailscaled', '--tun=userspace-networking', '--state=/var/lib/tailscale/tailscaled.state'],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        for _ in range(40):
            time.sleep(0.25)
            current = status()
            if current is not None:
                break
        if current is None:
            raise RuntimeError('Could not start Tailscale. Check the installation in this environment.')
    if action == 'logout':
        # Identify the daemon behind the default socket before touching its state.
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
            peer.connect('/var/run/tailscale/tailscaled.sock')
            pid, uid, _ = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        process = Path('/proc') / str(pid)
        args = (process / 'cmdline').read_bytes().decode().split('\x00')
        state_file = '/var/lib/tailscale/tailscaled.state'
        for index, arg in enumerate(args):
            if arg.startswith('--state='):
                state_file = arg.split('=', 1)[1]
            elif arg in ['--state', '-state']:
                state_file = args[index + 1]
            elif arg.startswith('-state='):
                state_file = arg.split('=', 1)[1]
        if uid != 0 or (process / 'exe').resolve().name != 'tailscaled' or state_file != '/var/lib/tailscale/tailscaled.state' or any(arg.startswith(('--statedir', '-statedir', '--config', '-config')) for arg in args):
            raise RuntimeError('This Tailscale installation uses custom state. Sign out and clear its identity manually before taking a snapshot.')
        if run(['tailscale', 'logout']).returncode != 0:
            raise RuntimeError('Could not sign out of Tailscale. Try again.')
        os.kill(pid, signal.SIGTERM)
        for _ in range(40):
            if not process.exists() or (process / 'stat').read_text().split(') ', 1)[1].startswith('Z'):
                break
            time.sleep(0.1)
        else:
            raise RuntimeError('Tailscale did not stop. Retry signing out.')
        # Logout retains the machine key. Remove it only after the daemon has stopped,
        # so a later snapshot cannot clone this environment's identity.
        Path(state_file).unlink(missing_ok=True)
        marker.unlink(missing_ok=True)
        emit('logged_out')
        sys.exit(0)
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.touch(mode=0o600)
    # Preserve existing networking preferences on nodes that are already connected.
    if current.get('BackendState') == 'Running':
        if run(['tailscale', 'set', '--ssh']).returncode != 0:
            raise RuntimeError('Could not enable Tailscale SSH. Check the installed Tailscale version.')
        report(current)
        sys.exit(0)
    # Do not change the environment's DNS or routes. Authorization is completed in the user's browser.
    up = subprocess.Popen(['tailscale', 'up', '--ssh', '--accept-dns=false', '--timeout=120s'],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        previous = None
        for _ in range(60):
            current = status() or {}
            summary = {key: current.get(key) for key in ['BackendState', 'AuthURL', 'Self', 'TailscaleIPs']}
            if summary != previous:
                if report(current):
                    break
                previous = summary
            if up.poll() is not None and up.returncode != 0:
                raise RuntimeError('Tailscale setup did not finish. Retry setup or check existing Tailscale settings.')
            time.sleep(2)
    finally:
        if up.poll() is None:
            up.terminate()
        up.wait(timeout=5)
except Exception as error:
    emit('error', message=str(error) if isinstance(error, RuntimeError) else 'Could not configure Tailscale. Check the installation and try again.')
    sys.exit(1)
`;

export function parseTailscaleOutput(output: string) {
  for (const line of output.trim().split("\n").reverse()) {
    try {
      const value = JSON.parse(line);
      if (!["not_installed", "stopped", "logged_out", "needs_login", "needs_approval", "connected", "error"].includes(value.state)) continue;
      // Never turn arbitrary process output into a clickable login link.
      const authUrl = typeof value.auth_url === "string" && /^https:\/\/login\.tailscale\.com\/a\/[a-zA-Z0-9]+$/.test(value.auth_url) ? value.auth_url : undefined;
      return { state: value.state as string, auth_url: authUrl,
        hostname: typeof value.hostname === "string" ? value.hostname.slice(0, 253) : undefined,
        ips: Array.isArray(value.ips) ? value.ips.filter((ip: unknown) => typeof ip === "string" && /^[a-fA-F0-9.:]+$/.test(ip)).slice(0, 4) : [],
        message: value.state === "error" ? "Tailscale setup could not finish. Check the installation and retry." : undefined };
    } catch { /* Ignore incomplete output until the next execution report. */ }
  }
  return null;
}
