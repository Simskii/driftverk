import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { commandEnvironment } from './docker-runtime.mjs';
const execute = promisify(execFile);
const runCommand = (command,args) => execute(command,args,{timeout:5000,maxBuffer:65536,env:commandEnvironment()});

export async function inspectAgentSession(session, runner = runCommand, now = Date.now()) {
  if (!/^driftverk-session-[a-f0-9-]{36}$/.test(session.socket) || !/^[a-f0-9]{12,64}$/.test(session.runtime_id)) throw new Error('Invalid session target');
  if (session.current_runtime_id !== session.runtime_id) return 'lost';
  // Failure to reach Docker is not proof that the agent has exited.
  const details = JSON.parse((await runner('docker',['inspect',session.runtime_id])).stdout)[0];
  if (details.Config?.Labels?.['driftverk.server-id'] !== session.sandbox_id || !details.State?.Running) return 'lost';
  const expired = new Date(session.expires_at).getTime() <= now;
  if (expired) {
    await runner('docker',['exec',session.runtime_id,'sh','-c',`tmux -L "$1" kill-server 2>/dev/null || true`,'driftverk-agent',session.socket]);
    return 'expired';
  }
  const result = await runner('docker',['exec',session.runtime_id,'sh','-c',
    `if tmux -L "$1" has-session -t agent 2>/dev/null; then printf running; else printf absent; fi`,'driftverk-agent',session.socket]);
  if (result.stdout.trim() === 'running') return 'running';
  if (session.status === 'launching' && now-new Date(session.created_at).getTime() < 60_000) return null;
  return 'ended';
}

export async function processAgentSessions(api, runner = runCommand) {
  const { sessions = [] } = await api('/api/compute/agent-sessions/poll',{});
  const results = await Promise.allSettled(sessions.map(async session => {
    const status = await inspectAgentSession(session,runner);
    if (status) await api(`/api/compute/agent-sessions/${session.id}/report`,{status});
  }));
  if (results.some(result=>result.status==='rejected')) throw new Error('Some agent sessions could not be checked');
}
