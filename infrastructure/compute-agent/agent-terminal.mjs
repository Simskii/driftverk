import { createHash } from 'node:crypto';
import { managedCodexArguments } from './agent-connection.mjs';
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function agentTerminalCommand(agent) {
  if (!agent || !['codex', 'claude'].includes(agent.id)) throw new Error('Invalid agent');
  if (agent.auth_method != null && !['api_key', 'subscription'].includes(agent.auth_method)) throw new Error('Invalid authentication method');
  const subscription = agent.auth_method === 'subscription';
  const managed = subscription && agent.id === 'codex' && Boolean(agent.connection_id);
  if (agent.model != null && (typeof agent.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(agent.model))) throw new Error('Invalid agent model');
  let socket = `driftverk-agent-${agent.id}${managed ? '-' + createHash('sha256').update(String(agent.account_id)).digest('hex').slice(0, 16) : ''}`;
  const protection = agent.protection;
  if (protection) {
    if (!/^driftverk-session-[a-f0-9-]{36}$/.test(protection.socket) || !Number.isFinite(Date.parse(protection.expires_at))) throw new Error('Invalid agent protection');
    socket = protection.socket;
  }
  const directory = agent.workspace_path || '/workspace';
  if (!/^\/(?:workspace|workspaces)(?:\/[A-Za-z0-9_.-]+)*$/.test(directory) || directory.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid agent directory');
  const cli = agent.id === 'codex' ? 'codex' : 'claude';
  const key = agent.id === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  const preparation = subscription ? [
    'unset OPENAI_API_KEY ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN',
    `export CODEX_HOME="$HOME/${managed ? '.driftverk-connected' : '.driftverk-subscription'}/codex" CLAUDE_CONFIG_DIR="$HOME/.driftverk-subscription/claude"`,
    'mkdir -p "$CODEX_HOME" "$CLAUDE_CONFIG_DIR"',
  ] : [];
  if (agent.id === 'codex' && !managed) preparation.push(subscription
    ? 'codex login status >/dev/null 2>&1 || codex login --device-auth || exit 1'
    : 'printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null || exit 1');
  const args = managed ? managedCodexArguments(agent.account_id) : [];
  if (agent.model) args.push('--model', agent.model);
  const agentLaunch = [...preparation, `exec ${cli} ${args.map(shellQuote).join(' ')}`].join('\n');
  const remaining = protection ? Math.max(0, Math.min(3600, Math.floor((Date.parse(protection.expires_at)-Date.now())/1000))) : 0;
  if (protection && remaining < 1) throw new Error('Agent session expired. Reopen the agent to start a new session.');
  const launch = protection ? `exec timeout -k 10 ${remaining}s /bin/sh -lc ${shellQuote(agentLaunch)}` : agentLaunch;
  const script = `
command -v ${cli} >/dev/null 2>&1 || { printf '%s\\n' '${cli} is not installed. Use Driftverk Dev or install it in this environment.'; exit 1; }
${subscription ? '' : `[ -n "$${key}" ] || { printf '%s\\n' 'The agent API key is missing. Create an environment with a connected agent.'; exit 1; }`}
${managed ? `codex --version | python3 -c 'import re,sys; m=re.search(r"(\\d+)\\.(\\d+)\\.(\\d+)",sys.stdin.read()); sys.exit(0 if m and tuple(map(int,m.groups())) >= (0,154,0) else 1)' || { printf '%s\\n' 'Update Codex to 0.154.0 or later to use your connected account.'; exit 1; }` : ''}
${protection ? `command -v timeout >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1 || { printf '%s\\n' 'Update this image: protected agents require tmux and timeout.'; exit 1; }` : ''}
cd ${shellQuote(directory)} || exit 1
if command -v tmux >/dev/null 2>&1; then
  exec tmux -L ${socket} new-session -A -s agent -c ${shellQuote(directory)} /bin/sh -lc ${shellQuote(launch)}
fi
printf '%s\\n' 'tmux is not installed; reconnecting will start a new agent session.' >&2
${launch}
`;
  return ['/bin/sh', '-lc', script];
}
