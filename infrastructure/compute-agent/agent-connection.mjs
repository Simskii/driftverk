import { createHash } from 'node:crypto';
// /dev/shm is per-container tmpfs, excluded from filesystem snapshots.
// Refresh tokens stay in the control plane.
export const connectionPath = accountId => `/dev/shm/driftverk-codex-${createHash('sha256').update(String(accountId)).digest('hex').slice(0, 16)}.json`;
export const credentialCommand = accountId => `import json,sys,urllib.request
try:
 with open('${connectionPath(accountId)}') as f: connection=json.load(f)
 request=urllib.request.Request(connection['url'],data=b'{}',headers={'Authorization':'Bearer '+connection['token'],'Content-Type':'application/json'})
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args): return None
 with urllib.request.build_opener(NoRedirect).open(request,timeout=25) as response: result=json.load(response)
 print(result['access_token'])
except Exception:
 sys.exit('ChatGPT connection unavailable. Reopen the agent pane or reconnect in Agents.')
`;
const writer = `import json,os,sys,tempfile
value=json.load(sys.stdin)
fd,path=tempfile.mkstemp(prefix='driftverk-codex-',dir='/dev/shm')
try:
 with os.fdopen(fd,'w') as f: json.dump(value,f)
 os.replace(path,sys.argv[1])
finally:
 if os.path.exists(path): os.unlink(path)
`;

export async function prepareAgentConnection(container, connection) {
  const url = new URL(connection.url);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','host.docker.internal'].includes(url.hostname))) ||
    url.username || url.password || url.pathname !== '/api/agent-credentials/codex' ||
    typeof connection.token !== 'string' || typeof connection.account_id !== 'string') throw new Error('Invalid agent connection');
  const exec = await container.exec({ Cmd: ['python3', '-c', writer, connectionPath(connection.account_id)], AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false });
  const stream = await exec.start({ hijack: true, stdin: true });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { stream.destroy(); reject(new Error('Could not prepare agent connection')); }, 10_000);
    stream.on('data', () => {});
    stream.on('error', () => { clearTimeout(timeout); reject(new Error('Could not prepare agent connection')); });
    stream.on('end', () => { clearTimeout(timeout); resolve(); });
    stream.end(JSON.stringify(connection));
  });
  if ((await exec.inspect()).ExitCode !== 0) throw new Error('Connected accounts require Python 3. Use Driftverk Dev.');
}

export function managedCodexArguments(accountId) {
  const options = {
    model_provider: 'driftverk_chatgpt',
    'model_providers.driftverk_chatgpt.name': 'ChatGPT',
    'model_providers.driftverk_chatgpt.base_url': 'https://chatgpt.com/backend-api/codex',
    'model_providers.driftverk_chatgpt.wire_api': 'responses',
    'model_providers.driftverk_chatgpt.requires_openai_auth': false,
    'model_providers.driftverk_chatgpt.env_http_headers': { 'ChatGPT-Account-ID': 'DRIFTVERK_CHATGPT_ACCOUNT_ID' },
    'model_providers.driftverk_chatgpt.auth.command': 'python3',
    'model_providers.driftverk_chatgpt.auth.args': ['-c', credentialCommand(accountId)],
    'model_providers.driftverk_chatgpt.auth.timeout_ms': 30000,
    'model_providers.driftverk_chatgpt.auth.refresh_interval_ms': 60000,
  };
  const toml = value => typeof value === 'object' && !Array.isArray(value)
    ? `{${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}=${JSON.stringify(entry)}`).join(',')}}` : JSON.stringify(value);
  return Object.entries(options).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]);
}
