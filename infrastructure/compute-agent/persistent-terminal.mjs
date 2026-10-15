// Keep the shell in the environment, independent of the agent or gateway.
// Web and SSH terminals use separate, environment-wide sessions.
// A WebSocket can receive input while Docker is still starting the shell.
export function bufferTerminalInput(socket) {
  let pending = [];
  let bytes = 0;
  let handler;
  let closed = false;
  socket.on('close', () => { closed = true; pending = []; handler = undefined; });
  socket.on('message', (data, binary) => {
    if (closed) return;
    if (handler) return handler(data, binary);
    bytes += data.length;
    if (bytes > 65_536 || pending.length >= 1024) {
      closed = true;
      pending = [];
      socket.close(1009, 'Too much input before terminal startup');
      return;
    }
    pending.push([data, binary]);
  });
  return consume => {
    if (closed) return false;
    handler = consume;
    const queued = pending;
    pending = [];
    for (const args of queued) {
      if (closed) break;
      handler(...args);
    }
    return !closed;
  };
}

export function terminalCommand(kind) {
  if (!['ssh', 'web'].includes(kind)) throw new Error('Invalid terminal kind');
  return ['/bin/sh', '-lc', `
if command -v tmux >/dev/null 2>&1; then
  exec tmux -L driftverk new-session -A -s "$1" /bin/sh -il
fi
printf '%s\\n' 'tmux is not installed; this terminal cannot be resumed after disconnect.' >&2
exec /bin/sh -il
`, 'driftverk-terminal', kind];
}

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function agentTerminalCommand(agent) {
  if (!agent || !['codex', 'claude'].includes(agent.id)) throw new Error('Invalid agent');
  if (agent.model != null && (typeof agent.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(agent.model))) throw new Error('Invalid agent model');
  const directory = agent.workspace_path || '/workspace';
  if (!/^\/(?:workspace|workspaces)(?:\/[A-Za-z0-9_.-]+)*$/.test(directory) || directory.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid agent directory');
  const cli = agent.id === 'codex' ? 'codex' : 'claude';
  const key = agent.id === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  const launch = `${agent.id === 'codex' ? 'printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null || exit 1\n' : ''}exec ${cli}${agent.model ? ` --model ${shellQuote(agent.model)}` : ''}`;
  const script = `
command -v ${cli} >/dev/null 2>&1 || { printf '%s\\n' '${cli} is not installed. Use Driftverk Dev or install it in this environment.'; exit 1; }
[ -n "$${key}" ] || { printf '%s\\n' 'The agent API key is missing. Create an environment with a connected agent.'; exit 1; }
cd ${shellQuote(directory)} || exit 1
if command -v tmux >/dev/null 2>&1; then
  exec tmux -L driftverk-agent-${agent.id} new-session -A -s agent -c ${shellQuote(directory)} /bin/sh -lc ${shellQuote(launch)}
fi
printf '%s\\n' 'tmux is not installed; reconnecting will start a new agent session.' >&2
${launch}
`;
  return ['/bin/sh', '-lc', script];
}

// Docker exec does not populate SHELL as a login service would. Codex desktop
// requires it before starting its remote server. Preserve image/user choices.
export function sshEnvironment(imageEnvironment = [], environment = {}) {
  const imageShell = imageEnvironment?.find((entry) => entry.startsWith('SHELL='))?.slice(6);
  return Object.entries({ SHELL: imageShell || '/bin/sh', ...environment })
    .map(([name, value]) => `${name}=${value}`);
}
