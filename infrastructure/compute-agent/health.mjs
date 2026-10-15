import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';

export function probeSocket(options) {
  return new Promise((resolve, reject) => {
    const socket = connect(options);
    const finish = (error) => { socket.destroy(); error ? reject(error) : resolve(); };
    socket.setTimeout(3000, () => finish(new Error('Connection timed out')));
    socket.once('error', finish);
    socket.once('connect', () => finish());
  });
}

export async function checkHealth({ docker, sysbox = false, watchdogFile, tunnelConnected, probe = probeSocket, request = fetch, read = readFile, now = Date.now() }) {
  const checks = [];
  async function check(service, fn) {
    try { await fn(); checks.push({ service, status: 'healthy' }); }
    catch { checks.push({ service, status: 'unhealthy', message: `${service} is unavailable` }); }
  }
  await check('docker', docker);
  if (sysbox) {
    await check('sysbox-fs', () => probe({ path: '/run/sysbox/sysfs.sock' }));
    await check('sysbox-mgr', () => probe({ path: '/run/sysbox/sysmgr.sock' }));
  }
  for (const [service, port] of [['preview-gateway', 8081], ['web-terminal', 2223]]) {
    await check(service, async () => {
      const response = await request(`http://${service}:${port}/health`, { signal: AbortSignal.timeout(3000) });
      await response.body?.cancel();
      if (!response.ok) throw new Error('HTTP health check failed');
    });
  }
  checks.push({ service: 'data-tunnel', status: tunnelConnected ? 'healthy' : 'unhealthy', ...(!tunnelConnected ? { message: 'Data tunnel is reconnecting' } : {}) });
  if (watchdogFile) {
    try {
      const report = JSON.parse(await read(watchdogFile, 'utf8'));
      if (!Number.isFinite(report.checked_at) || now - report.checked_at > 90000 || report.checked_at > now + 5000) throw new Error('Stale watchdog');
      if (!Array.isArray(report.checks) || !report.checks.length || report.checks.length > 8 || !report.checks.every(c => c && typeof c.service === 'string' && ['healthy', 'unhealthy', 'recovering'].includes(c.status))) throw new Error('Invalid watchdog');
      checks.push(...report.checks);
    } catch { checks.push({ service: 'host-watchdog', status: 'unhealthy', message: 'Host watchdog report is missing or stale' }); }
  }
  return { checked_at: new Date(now).toISOString(), status: checks.every(c => c.status === 'healthy') ? 'healthy' : 'unhealthy', checks };
}

export function canClaimJobs(health, now = Date.now()) {
  return health?.status === 'healthy' && now - Date.parse(health.checked_at) < 45000;
}

export function allowedOperations(health, operations, now = Date.now()) {
  if (!health || !(now - Date.parse(health.checked_at) < 45000)) return [];
  if (health.status === 'healthy') return operations;
  const docker = health.checks.filter(c => c.service === 'docker');
  return docker.length && docker.every(c => c.status === 'healthy') ? operations.filter(op => ['stop', 'delete'].includes(op)) : [];
}
